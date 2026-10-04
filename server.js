require("dotenv").config();

const express = require("express");
const Stripe = require("stripe");
const {createStore, StorageError} = require("./storage/postgres");
const path = require("path");
const crypto = require("crypto");
const { isIP } = require("net");
const pricing = require("./pricing");
const ewrPickups = require("./ewr-pickups");

const app = express();
const PORT = process.env.PORT || 3000;

// Diagnostic fields come from closed allowlists, never exception/request payloads.
const diagnosticOperations=new Set(['request','quote','checkout','address','webhook','reservation','admin']);
const diagnosticCategories=new Set(['request_rejected','validation_error','unexpected_error','provider_error','storage_unavailable','invalid_signature','configuration_unavailable','response_interrupted']);
const diagnosticProviders=new Set(['google','stripe','postgresql']);
function requestOperation(req) {
  const route=req.route?.path;
  if(route==='/api/quote')return 'quote';
  if(route==='/api/checkout')return 'checkout';
  if(route==='/api/address-suggestions')return 'address';
  if(route==='/api/stripe-webhook')return 'webhook';
  if(route==='/api/booking/:id')return 'reservation';
  if(typeof route==='string' && (route.startsWith('/api/admin/') || route.startsWith('/api/bookings')))return 'admin';
  return 'request';
}
function logDiagnostic(req,status,category='request_rejected',provider) {
  if(req.diagnosticLogged)return;
  req.diagnosticLogged=true;
  const entry={timestamp:new Date().toISOString(),referenceId:req.referenceId,
    operation:requestOperation(req),category:diagnosticCategories.has(category)?category:'unexpected_error',
    status:Number.isInteger(status)&&status>=400&&status<=599?status:500};
  if(!diagnosticOperations.has(entry.operation))entry.operation='request';
  if(diagnosticProviders.has(provider))entry.provider=provider;
  console.error(JSON.stringify(entry));
}
app.use((req,res,next)=>{
  req.referenceId=crypto.randomUUID();
  res.set('X-Request-ID',req.referenceId);
  const json=res.json;
  res.json=function(body) {
    if(res.statusCode>=400 && body && typeof body==='object' && typeof body.error==='string') {
      body={...body,referenceId:req.referenceId};
      logDiagnostic(req,res.statusCode,req.diagnosticCategory,req.diagnosticProvider);
    }
    return json.call(this,body);
  };
  next();
});

// Explicit customer-safe message allowlist. HTTP status alone never grants trust.
const customerErrorMessages=new Map();
for(const message of [
  'Unknown vehicle type.','A valid vehicle is required.','A valid trip type is required.',
  'Pickup must be scheduled in the future (New York time).','Return must be later than pickup (New York time).',
  'Passenger count must be a whole number.','Passenger count must be between 1 and 6.',
  'Choose a valid hourly duration (3-hour minimum).','Invalid email address.','Invalid phone number.','Invalid flight number.',
  'Promo code is invalid or inactive.','FIRST15 is only available for your first ride.',
  'This special offer is not available.','Unknown special offer.',
  'The EWR special is only available for a single One Way or Airport journey.',
  'The $150 EWR → Manhattan special is for Black SUV only.',
  'We could not verify the pickup or destination for this special.',
  'The $150 special requires pickup at Newark Liberty International Airport (EWR).',
  'The $150 EWR Airport Special is available only for trips to Manhattan. Please use Get Quote for this destination.',
  'The EWR → Manhattan special cannot be used for hourly bookings.','No drivable route was found.','Invalid status.',
  'Too many requests. Please try again later.'
])customerErrorMessages.set(message,{message,status:400});
for(const key of ['pickup','dropoff','date','time','returnDate','returnTime','firstName','lastName','email','phone','flightNumber','notes','promoCode','offerCode']) {
  for(const message of [`A valid ${key} is required.`,`Invalid ${key}.`])customerErrorMessages.set(message,{message,status:400});
}
for(const label of ['pickup','return'])for(const ending of ['date or time.','date or time in New York.']) {
  const message=`Invalid ${label} ${ending}`;customerErrorMessages.set(message,{message,status:400});
}
for(const message of ['This reservation has already been paid.','Checkout is already processing for this reservation.',
 'Checkout is already processing. Please try again.','A first-ride Checkout is already pending. Please complete or retry that booking.',
 'A first-ride Checkout is already pending.'])customerErrorMessages.set(message,{message,status:409});
customerErrorMessages.set('Too many requests. Please try again later.',{message:'Too many requests. Please try again later.',status:429});
function sendSafeError(req,res,error,fallbackStatus=500) {
  if(res.headersSent) {
    logDiagnostic(req,500,'response_interrupted');
    res.destroy();
    return;
  }
  const trusted=customerErrorMessages.get(error?.message);
  const storage=error?.storageFailure===true;
  const parser=['entity.parse.failed','entity.too.large','encoding.unsupported','request.aborted','request.size.invalid'].includes(error?.type);
  const status=storage?503:trusted?trusted.status:parser?(error.type==='entity.too.large'?413:error.type==='encoding.unsupported'?415:400):
    [400,403,409,413,415,422,500,502,503].includes(error?.status)?error.status:fallbackStatus;
  let message=trusted?.message;
  let category=trusted?'validation_error':'unexpected_error',provider;
  if(storage){message='Reservation service temporarily unavailable. Please try again.';category='storage_unavailable';provider='postgresql';}
  else if(parser){message='Invalid request.';category='request_rejected';}
  else if(['Address and route lookup is temporarily unavailable. Please try again.','Route estimate is temporarily unavailable. Please try again.'].includes(error?.message)) {
    message='Address and route lookup is temporarily unavailable. Please try again.';category='provider_error';provider='google';
  }
  else if(error?.message==='Stripe is not configured. Add STRIPE_SECRET_KEY before accepting payments.') {
    message='Checkout is temporarily unavailable. Please try again.';category='configuration_unavailable';provider='stripe';
  }
  else if(error?.message==='Checkout is temporarily unavailable. Please try again.') {
    message='Checkout is temporarily unavailable. Please try again.';category='provider_error';provider='stripe';
  }
  if(!message)message=requestOperation(req)==='quote'?'Quote is temporarily unavailable. Please try again.':
    requestOperation(req)==='checkout'?'Checkout is temporarily unavailable. Please try again.':'Service temporarily unavailable. Please try again.';
  req.diagnosticCategory=category;req.diagnosticProvider=provider;
  return res.status(status).json({error:trusted?message:`${message} Reference: ${req.referenceId}`});
}


// Trust only known proxy networks, never arbitrary forwarded headers or hop counts.
// Render routes ingress through Cloudflare and private load balancers.
// Override with the actual proxy CIDRs if the deployment topology changes.
const renderProxyRanges = [
  "loopback", "uniquelocal",
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"
];
app.set("trust proxy", process.env.TRUSTED_PROXY_CIDRS
  ? process.env.TRUSTED_PROXY_CIDRS.split(",").map(value => value.trim()).filter(Boolean)
  : process.env.RENDER === "true" ? renderProxyRanges : false);


// Browser resources are local; Google requests run on the server and Checkout is navigation.
// The hash permits only the existing confirmation script (HTML line endings normalized by browsers).
const productionHttps = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'sha256-knh3QyEQuoTnqEVTOqmmc3xn6M3YYA4iVj76wcUWmeE='",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "frame-src 'none'"
].join("; ");
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": contentSecurityPolicy,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  });
  if (productionHttps && req.secure) {
    res.set("Strict-Transport-Security", "max-age=31536000");
  }
  if (productionHttps && !req.secure) {
    // Use the configured canonical site, never attacker-controlled Host/forwarded-host headers.
    let canonical;
    try { canonical = new URL(process.env.SITE_URL); } catch (_) {}
    if (!canonical || !["http:", "https:"].includes(canonical.protocol) || canonical.username || canonical.password) {
      return res.status(503).json({error: "Secure service unavailable."});
    }
    canonical.protocol = "https:";
    return res.redirect(308, canonical.origin + req.originalUrl);
  }
  next();
});

/* Single-process controls for the current JSON-file deployment. Multiple instances
   need a shared atomic store for counters/locks as well as reservation storage. */
const abuseCounters = new Map();
const checkoutActions = new Map();
const adminSessions = new Map();
const MINUTE = 60 * 1000;
const ADMIN_SESSION_ABSOLUTE_MS = 8 * 60 * MINUTE;
const ADMIN_SESSION_IDLE_MS = 30 * MINUTE;
const adminCookieSecure = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
const adminCookieName = adminCookieSecure ? "__Host-er_admin_session" : "er_admin_session";
const adminCookieOptions = {httpOnly: true, secure: adminCookieSecure, sameSite: "strict", path: "/"};

function clientKey(req) {
  const address = req.ip || req.socket?.remoteAddress || "unknown";
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) return address.slice(7);
  if (isIP(address) === 6) {
    // Canonicalize and group IPv6 /64 so rotating interface addresses cannot evade limits.
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const halves = canonical.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const groups = halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
    return groups.slice(0, 4).map(group => group.padStart(4, "0")).join(":") + "::/64";
  }
  return address;
}

function consumeLimit(scope, key, limit, windowMs) {
  const now = Date.now();
  const id = `${scope}:${key}`;
  let entry = abuseCounters.get(id);
  if (!entry || entry.resetAt <= now) {
    // Bound memory without evicting active counters (which would bypass protection).
    if (!entry && abuseCounters.size >= 20000) return Math.ceil(windowMs / 1000);
    entry = { count: 0, resetAt: now + windowMs };
    abuseCounters.set(id, entry);
  }
  if (entry.count >= limit) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  entry.count++;
  return 0;
}

const counterCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of abuseCounters) if (entry.resetAt <= now) abuseCounters.delete(key);
  for (const [key, session] of adminSessions) {
    if (session.expiresAt <= now || session.lastSeen + ADMIN_SESSION_IDLE_MS <= now) adminSessions.delete(key);
  }
}, MINUTE);
counterCleanup.unref();

function tooManyRequests(res, retryAfter = 60) {
  return res.set("Retry-After", String(retryAfter)).status(429)
    .json({ error: "Too many requests. Please try again later." });
}

function rateLimit(scope, limit, windowMs = MINUTE) {
  return (req, res, next) => {
    const retryAfter = consumeLimit(scope, clientKey(req), limit, windowMs);
    if (retryAfter) return tooManyRequests(res, retryAfter);
    next();
  };
}

// Timeout covers both the request and reading the response body.
async function googleJson(url, options) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Google service unavailable");
    return await response.json();
  } catch (_) {
    throw new Error("Address and route lookup is temporarily unavailable. Please try again.");
  }
}

const SITE_URL =
  process.env.SITE_URL ||
  `http://localhost:${PORT}`;

// PostgreSQL is the only runtime reservation store, including development.
let reservationStore;
try { reservationStore = createStore(process.env); }
catch (_) { console.error("Reservation storage configuration unavailable."); process.exitCode = 1; }
let recoveryEmailProvider,recoveryConfigurationFailed=false;
try { recoveryEmailProvider=require('./services/email').createEmailProvider({enabled:process.env.CUSTOMER_EMAIL_RECOVERY_ENABLED==='true',apiKey:process.env.CUSTOMER_EMAIL_RECOVERY_ENABLED==='true'?process.env.RESEND_API_KEY:undefined,from:process.env.CUSTOMER_RECOVERY_FROM,siteUrl:SITE_URL,production:productionHttps}); }
catch (_) { recoveryConfigurationFailed=true; console.error('Customer recovery configuration unavailable.'); }
const storageReady = reservationStore && !recoveryConfigurationFailed ? reservationStore.migrate() : Promise.reject(new StorageError());
// Attach immediately so an unavailable database never creates an unhandled rejection.
storageReady.catch(() => { console.error("Reservation storage initialization unavailable."); });
const readBookings = () => reservationStore.list();
const route = handler => async (req, res, next) => {
  try { await storageReady; await handler(req,res,next); }
  catch (error) {
    if(error.storageFailure) return sendSafeError(req,res,error,503);
    next(error);
  }
};

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;


/* =========================================
   BOOKING DATA
========================================= */

/* =========================================
   HELPERS
========================================= */

function sanitizeText(value, max = 200) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function money(number) {
  return (
    Math.round(Number(number || 0) * 100) /
    100
  );
}

function normalizePromoCode(value) {
  return sanitizeText(value, 30).toUpperCase();
}

function normalizeEmail(value) {
  return sanitizeText(value, 160).toLowerCase();
}

function normalizePhone(value) {
  return String(value || "")
    .replace(/\D/g, "");
}


/* =========================================
   FIRST-RIDE CHECK
========================================= */

async function hasPreviousPaidRide(email, phone) {
  const customerEmail =
    normalizeEmail(email);

  const customerPhone =
    normalizePhone(phone);

  if (!customerEmail && !customerPhone) {
    return false;
  }

  return reservationStore.hasPaidRide(customerEmail, customerPhone);
}


/* =========================================
   PROMOTION
========================================= */

async function getPromotion(body) {
  const code =
    normalizePromoCode(body.promoCode);

  if (!code) {
    return null;
  }

  const promotion =
    pricing.promotions &&
    pricing.promotions[code];

  if (
    !promotion ||
    promotion.active !== true
  ) {
    throw new Error(
      "Promo code is invalid or inactive."
    );
  }

  if (
    promotion.firstRideOnly &&
    await hasPreviousPaidRide(
      body.email,
      body.phone
    )
  ) {
    throw new Error(
      `${code} is only available for your first ride.`
    );
  }

  const percentOff =
    Number(promotion.percentOff);

  if (
    !Number.isFinite(percentOff) ||
    percentOff <= 0 ||
    percentOff > 100
  ) {
    throw new Error(
      "Promo code is not configured correctly."
    );
  }

  return {
    code,
    label:
      promotion.label ||
      `${percentOff}% Off`,
    percentOff
  };
}


/* =========================================
   VALIDATE BOOKING
========================================= */

function getConfiguredVehicleRate(vehicle) {
  if (
    typeof vehicle !== "string" ||
    !["escalade", "suv"].includes(vehicle) ||
    !Object.hasOwn(pricing.vehicleRates, vehicle)
  ) {
    throw new Error("Unknown vehicle type.");
  }
  const rate = pricing.vehicleRates[vehicle];
  if (!rate || typeof rate !== "object" || Array.isArray(rate)) {
    throw new Error("Vehicle pricing is not configured correctly.");
  }
  return rate;
}

function validateCalculatedFare(vehicle, total) {
  getConfiguredVehicleRate(vehicle);
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) {
    throw new Error("Calculated fare must be a finite amount greater than zero.");
  }
}

const SERVICE_TIME_ZONE = "America/New_York";
const HOURLY_DURATIONS = [3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8];
const serviceDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SERVICE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});

function bookingText(body, key, max, required = false, min = 1, multiline = false) {
  const value = Object.hasOwn(body, key) ? body[key] : undefined;
  if (value === undefined || value === null) {
    if (required) throw new Error(`A valid ${key} is required.`);
    body[key] = "";
    return "";
  }
  if (typeof value !== "string") throw new Error(`Invalid ${key}.`);
  const text = value.trim();
  const controlCharacters = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  if (text.length > max || controlCharacters.test(text) || (required && text.length < min)) {
    throw new Error(`Invalid ${key}.`);
  }
  body[key] = text;
  return text;
}

function serviceDateParts(timestamp) {
  return Object.fromEntries(serviceDateFormatter.formatToParts(new Date(timestamp))
    .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
}

function parseServiceDateTime(date, time, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`Invalid ${label} date or time.`);
  }
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallTime = Date.UTC(year, month - 1, day, hour, minute);
  const calendar = new Date(wallTime);
  if (year < 1000 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day) throw new Error(`Invalid ${label} date or time.`);

  // Derive NY offsets around the requested date, independent of the host TZ.
  // Comparing local components rejects nonexistent spring-forward times.
  const candidates = new Set();
  for (const delta of [-86400000, 0, 86400000]) {
    const sample = wallTime + delta;
    const parts = serviceDateParts(sample);
    const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - sample;
    const instant = wallTime - offset;
    const actual = serviceDateParts(instant);
    if (actual.year === year && actual.month === month && actual.day === day &&
        actual.hour === hour && actual.minute === minute) candidates.add(instant);
  }
  if (!candidates.size) throw new Error(`Invalid ${label} date or time in New York.`);
  // A repeated fall-back time refers to its first occurrence, consistently.
  return Math.min(...candidates);
}

function validateBookingInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "vehicle")) {
    throw new Error("A valid vehicle is required.");
  }
  const rate = getConfiguredVehicleRate(body.vehicle);
  if (!Object.hasOwn(body, "tripType") || typeof body.tripType !== "string" ||
      !["oneway", "roundtrip", "airport", "hourly"].includes(body.tripType)) {
    throw new Error("A valid trip type is required.");
  }

  for (const key of ["pickup", "dropoff"]) {
    const address = bookingText(body, key, 200, true, 3);
    if (!/[\p{L}\p{N}]/u.test(address) || /[<>]/u.test(address)) throw new Error(`Invalid ${key}.`);
  }
  bookingText(body, "date", 10, true);
  bookingText(body, "time", 5, true);
  const pickupAt = parseServiceDateTime(body.date, body.time, "pickup");
  if (pickupAt <= Date.now()) throw new Error("Pickup must be scheduled in the future (New York time).");

  bookingText(body, "returnDate", 10, body.tripType === "roundtrip");
  bookingText(body, "returnTime", 5, body.tripType === "roundtrip");
  if (body.tripType === "roundtrip") {
    const returnAt = parseServiceDateTime(body.returnDate, body.returnTime, "return");
    if (returnAt <= pickupAt) throw new Error("Return must be later than pickup (New York time).");
  }

  if (!Object.hasOwn(body, "passengers") ||
      !["string", "number"].includes(typeof body.passengers) ||
      (typeof body.passengers === "string" && !/^[1-9]\d*$/.test(body.passengers.trim()))) {
    throw new Error("Passenger count must be a whole number.");
  }
  const passengers = Number(body.passengers);
  if (!Number.isSafeInteger(passengers) || passengers < 1 || passengers > rate.maxPassengers) {
    throw new Error(`Passenger count must be between 1 and ${rate.maxPassengers}.`);
  }
  body.passengers = passengers;

  if (body.tripType === "hourly") {
    if (!Object.hasOwn(body, "hours") || !["string", "number"].includes(typeof body.hours) ||
        (typeof body.hours === "string" && !/^(?:3|3\.5|4|4\.5|5|5\.5|6|7|8)$/.test(body.hours.trim())) ||
        !HOURLY_DURATIONS.includes(Number(body.hours))) {
      throw new Error("Choose a valid hourly duration (3-hour minimum).");
    }
    body.hours = Number(body.hours);
  }

  for (const key of ["firstName", "lastName"]) {
    const name = bookingText(body, key, 80, true);
    if (!/\p{L}/u.test(name) || /[<>]/u.test(name)) throw new Error(`Invalid ${key}.`);
  }
  const email = bookingText(body, "email", 160, true);
  const emailParts = email.split("@");
  const local = emailParts[0];
  const domain = emailParts[1];
  if (emailParts.length !== 2 || local.length > 64 || !/^[^\s@<>(),;:"]+$/u.test(local) ||
      local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
      !domain || !domain.includes(".") || domain.split(".").some(label =>
        !/^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u.test(label))) {
    throw new Error("Invalid email address.");
  }
  const phone = bookingText(body, "phone", 60, true);
  const phoneMatch = phone.match(/^(\+?[\d\s().-]+?)(?:\s*(?:x|ext\.?|#)\s*\d{1,6})?$/i);
  if (!phoneMatch || !/^[0-9]{7,17}$/.test(phoneMatch[1].replace(/\D/g, ""))) {
    throw new Error("Invalid phone number.");
  }
  // Flight number remains optional, as the existing airport form specifies.
  const flight = bookingText(body, "flightNumber", 40);
  if (flight && !/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(flight)) throw new Error("Invalid flight number.");
  bookingText(body, "notes", 700, false, 1, true);
  bookingText(body, "promoCode", 30);
  const offerCode = bookingText(body, "offerCode", 50);
  if (offerCode && !["oneway", "airport"].includes(body.tripType)) {
    throw new Error("The EWR special is only available for a single One Way or Airport journey.");
  }
}


/* =========================================
   GOOGLE ROUTES
========================================= */

async function getRouteEstimate(
  origin,
  destination,
  departureTime
) {
  const key =
    process.env.GOOGLE_MAPS_API_KEY;

  if (!key) {
    throw new Error(
      "Address and route lookup is temporarily unavailable. Please try again."
    );
  }

  const data =
    await googleJson(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "X-Goog-Api-Key":
            key,

          "X-Goog-FieldMask":
            "routes.distanceMeters,routes.duration"
        },

        body: JSON.stringify({
          origin: {
            ...(typeof origin === "object" ? {placeId:origin.placeId} : {address:origin})
          },

          destination: {
            ...(typeof destination === "object" ? {placeId:destination.placeId} : {address:destination})
          },

          ...(departureTime ? { departureTime } : {}),

          travelMode: "DRIVE",

          routingPreference:
            "TRAFFIC_AWARE"
        })
      }
    );

  const route =
    data.routes &&
    data.routes[0];

  if (!route) {
    throw new Error(
      "No drivable route was found."
    );
  }

  const miles =
    route.distanceMeters /
    1609.344;

  const seconds =
    Number(
      String(
        route.duration || "0s"
      ).replace("s", "")
    );

  return {
    miles,
    minutes: seconds / 60
  };
}


/* =========================================
   GOOGLE PLACE VERIFICATION
========================================= */

async function lookupPlace(query, strict = false) {
  const key =
    process.env.GOOGLE_MAPS_API_KEY;

  if (!key) {
    throw new Error(
      "Address and route lookup is temporarily unavailable. Please try again."
    );
  }

  const data =
    await googleJson(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "X-Goog-Api-Key":
            key,

          "X-Goog-FieldMask":
            "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.types,places.primaryType"
        },

        body: JSON.stringify({
          textQuery:
            sanitizeText(query, 200),

          maxResultCount: strict ? 3 : 1,

          languageCode: "en"
        })
      }
    );

  if (strict && (!Array.isArray(data.places) || data.places.length !== 1)) return null;
  return (
    Array.isArray(data.places) &&
    data.places[0]
      ? data.places[0]
      : null
  );
}


function componentEquals(
  place,
  type,
  expected
) {
  const components =
    Array.isArray(
      place?.addressComponents
    )
      ? place.addressComponents
      : [];

  return components.some(
    (component) => {
      const types =
        Array.isArray(component.types)
          ? component.types
          : [];

      const name =
        String(
          component.longText || ""
        )
          .trim()
          .toLowerCase();

      return (
        types.includes(type) &&
        name ===
          expected.toLowerCase()
      );
    }
  );
}


function distanceMiles(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const toRadians =
    (degrees) =>
      degrees * Math.PI / 180;

  const earthRadiusMiles =
    3958.8;

  const dLat =
    toRadians(lat2 - lat1);

  const dLon =
    toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
    Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return earthRadiusMiles * c;
}


/* =========================================
   $150 EWR → MANHATTAN SPECIAL
========================================= */

async function verifyEwrPickup(body) {
  const id = body.pickupPlaceId;
  const rejected = () => new Error("The $150 special requires pickup at Newark Liberty International Airport (EWR).");
  if (typeof id !== "string" || !Object.hasOwn(ewrPickups,id)) throw rejected();
  const details = await googleJson("https://places.googleapis.com/v1/places/" + encodeURIComponent(id), {
    headers: {"X-Goog-Api-Key":process.env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask":"id,displayName,formattedAddress,location,types,primaryType"}
  });
  const lat=details.location?.latitude,lng=details.location?.longitude;
  const types=Array.isArray(details.types) ? details.types : [];
  const forbidden=["hotel","lodging","restaurant","car_rental","parking","parking_lot","parking_garage","street_address","route"];
  if (details.id !== id || !Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat<40.65 || lat>40.73 || lng< -74.22 || lng> -74.13 ||
      !types.length || types.some(type=>typeof type!=="string") ||
      forbidden.some(type=>types.includes(type) || details.primaryType===type) ||
      (ewrPickups[id].kind==="airport" && !types.some(type=>["airport","international_airport"].includes(type))) ||
      typeof details.displayName?.text!=="string" || !details.displayName.text.trim() ||
      typeof details.formattedAddress!=="string" || !details.formattedAddress.trim()) throw rejected();
  // Text is a consistency check only; authorization requires verified allowlisted identity.
  const normalize=value=>String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
  const entry=ewrPickups[id];
  const names=entry.kind==='airport'
    ? ['EWR','EWR Airport','Newark Airport','Newark Liberty International Airport','Newark Liberty International Airport (EWR)']
    : [entry.label,'Newark Liberty International Airport '+entry.label];
  names.push(details.displayName.text);
  const compatible=new Set(names.flatMap(name=>[normalize(name),normalize(name+', '+details.formattedAddress)]));
  if(entry.kind==='airport') compatible.add(normalize('Newark Liberty International Airport (EWR), 3 Brewster Rd, Newark, NJ 07114'));
  if(!compatible.has(normalize(body.pickup))) throw rejected();
  return {placeId:id, label:details.displayName.text,address:details.formattedAddress};

}

async function verifyFixedOffer(body) {
  const code =
    sanitizeText(
      body.offerCode,
      50
    ).toUpperCase();

  if (!code) {
    return null;
  }

  const offer =
    pricing.fixedOffers &&
    pricing.fixedOffers[code];

  if (
    !offer ||
    offer.active !== true
  ) {
    throw new Error(
      "This special offer is not available."
    );
  }

  if (
    code !==
    "EWR_MANHATTAN_SUV"
  ) {
    throw new Error(
      "Unknown special offer."
    );
  }

  if (
    body.vehicle !== "suv" ||
    offer.vehicle !== "suv"
  ) {
    throw new Error(
      "The $150 EWR → Manhattan special is for Black SUV only."
    );
  }

  const [
    pickupPlace,
    dropoffPlace
  ] = await Promise.all([
    verifyEwrPickup(body),
    lookupPlace(body.dropoff)
  ]);

  if (
    !pickupPlace ||
    !dropoffPlace
  ) {
    throw new Error(
      "We could not verify the pickup or destination for this special."
    );
  }

  const verifiedPickup = pickupPlace;

  /*
    Manhattan is New York County.
    Google may also identify it as
    the Manhattan sublocality.
  */

  const isManhattan =
    componentEquals(
      dropoffPlace,
      "administrative_area_level_2",
      "New York County"
    ) ||
    componentEquals(
      dropoffPlace,
      "sublocality_level_1",
      "Manhattan"
    ) ||
    componentEquals(
      dropoffPlace,
      "sublocality",
      "Manhattan"
    );

  if (!isManhattan) {
    throw new Error(
      "The $150 EWR Airport Special is available only for trips to Manhattan. Please use Get Quote for this destination."
    );
  }

  const verifiedOffer = {code,label:offer.label,price:money(offer.price)};
  Object.defineProperty(verifiedOffer,"verifiedPickup",{value:verifiedPickup});
  return verifiedOffer;
}


/* =========================================
   AIRPORT / NIGHT HELPERS
========================================= */

function isAirportTrip(
  pickup,
  dropoff
) {
  const text =
    `${pickup} ${dropoff}`
      .toLowerCase();

  return [
    "airport",
    "ewr",
    "newark liberty",
    "jfk",
    "laguardia",
    "lga",
    "teb",
    "teterboro"
  ].some(
    (term) =>
      text.includes(term)
  );
}


function isLateNight(time) {
  const hour =
    Number(
      String(time)
        .split(":")[0]
    );

  const start =
    pricing.lateNightStartHour;

  const end =
    pricing.lateNightEndHour;

  return (
    hour >= start ||
    hour < end
  );
}


/* =========================================
   PRICE CALCULATION
========================================= */

function calculateLegFare(rate, route, pickup, dropoff, time, hours) {
  if (hours === undefined && (!route || !Number.isFinite(route.miles) || route.miles < 0 ||
      !Number.isFinite(route.minutes) || route.minutes < 0)) {
    throw new Error("Route estimate is temporarily unavailable. Please try again.");
  }
  let fare = hours !== undefined ? hours * rate.hourlyRate :
    rate.baseFare +
    route.miles *
      rate.perMile +
    route.minutes *
      rate.perMinute +
    pricing.tollAllowance;

  const surcharges = [];


  if (
    isAirportTrip(
      pickup,
      dropoff
    ) &&
    pricing.airportSurcharge > 0
  ) {
    fare +=
      pricing.airportSurcharge;

    surcharges.push({
      label:
        "Airport service",

      amount:
        pricing.airportSurcharge
    });
  }


  if (
    isLateNight(time) &&
    pricing.lateNightSurcharge > 0
  ) {
    fare +=
      pricing.lateNightSurcharge;

    surcharges.push({
      label:
        "Late-night service",

      amount:
        pricing.lateNightSurcharge
    });
  }


  fare =
    Math.max(
      fare,
      rate.minimumFare
    );

  fare =
    money(fare);


  return {fare, surcharges};
}

function calculateFareTotals(fare, promotion) {
  const discount = promotion ? money(fare * promotion.percentOff / 100) : 0;
  const discountedFare = money(Math.max(0, fare - discount));
  const gratuity = money(discountedFare * pricing.gratuityPercent / 100);
  return {discount, discountedFare, gratuity,
    originalTotal: money(fare + fare * pricing.gratuityPercent / 100),
    total: money(discountedFare + gratuity)};
}

function roundTripLeg(body, rate, route, isReturn) {
  const pickup = isReturn ? body.dropoff : body.pickup;
  const dropoff = isReturn ? body.pickup : body.dropoff;
  const date = isReturn ? body.returnDate : body.date;
  const time = isReturn ? body.returnTime : body.time;
  const calculated = calculateLegFare(rate, route, pickup, dropoff, time);
  validateCalculatedFare(body.vehicle, calculated.fare);
  return {pickup, dropoff, date, time, vehicleKey: body.vehicle,
    miles: route.miles, minutes: route.minutes, fare: calculated.fare, surcharges: calculated.surcharges};
}

async function validateCheckoutQuote(body, quote) {
  validateCalculatedFare(body.vehicle, quote.total);
  if (quote.vehicleKey !== body.vehicle || !Number.isSafeInteger(Math.round(quote.total * 100)) ||
      Math.round(quote.total * 100) <= 0) throw new Error("Calculated Checkout amount is invalid.");
  if (body.tripType !== "roundtrip") return;
  const rate = getConfiguredVehicleRate(body.vehicle);
  const detail = quote.roundTrip;
  if (!detail || quote.fixedOffer) throw new Error("Invalid Round Trip fare.");
  for (const [key, isReturn] of [["outbound", false], ["return", true]]) {
    const leg = detail[key];
    if (!leg) throw new Error("Invalid Round Trip fare.");
    const expected = roundTripLeg(body, rate, {miles: leg.miles, minutes: leg.minutes}, isReturn);
    for (const field of ["pickup", "dropoff", "date", "time", "vehicleKey", "fare"]) {
      if (leg[field] !== expected[field]) throw new Error("Invalid Round Trip fare.");
    }
    validateCalculatedFare(body.vehicle, leg.fare);
  }
  const combined = money(detail.outbound.fare + detail.return.fare);
  validateCalculatedFare(body.vehicle, combined);
  if (detail.subtotal !== combined || quote.baseTotal !== combined) throw new Error("Invalid Round Trip total.");
  const promotion = await getPromotion(body);
  if ((quote.promotion?.code || null) !== (promotion?.code || null) ||
      (quote.promotion?.percentOff || 0) !== (promotion?.percentOff || 0)) {
    throw new Error("Invalid Round Trip promotion.");
  }
  const totals = calculateFareTotals(combined, promotion);
  for (const [key, value] of Object.entries(totals)) {
    if (quote[key] !== value) throw new Error("Invalid Round Trip total.");
  }
}

async function calculateQuote(body) {
  validateBookingInput(body);
  await storageReady;
  await readBookings();

  const rate =
    getConfiguredVehicleRate(body.vehicle);

  const isHourly = body.tripType === "hourly";
  const isRoundTrip = body.tripType === "roundtrip";
  const bookedHours = Number(body.hours);
  if (isHourly && !HOURLY_DURATIONS.includes(bookedHours)) {
    throw new Error("Choose a valid hourly duration (3-hour minimum).");
  }
  if (isHourly && sanitizeText(body.offerCode)) {
    throw new Error("The EWR → Manhattan special cannot be used for hourly bookings.");
  }

  const fixedOffer = await verifyFixedOffer(body);
  let verifiedPickup = fixedOffer?.verifiedPickup;
  if (!fixedOffer && body.pickupTerminal !== undefined) {
    const terminalKeys={general:"ChIJ7wzsxeFSwokRhvLXxTe087M",a:"ChIJ2dQDPZNSwokRVJr9XE2SPt0",b:"ChIJ-6uTxfZSwokR-VfW-WSM53k",c:"ChIJMYEleJSwokRawcDBeH8NVg"};
    if (!Object.hasOwn(terminalKeys,body.pickupTerminal) || terminalKeys[body.pickupTerminal]!==body.pickupPlaceId) throw new Error("Invalid request.");
    verifiedPickup=await verifyEwrPickup(body);
  }
  let verifiedDropoff;
  if (fixedOffer && body.dropoffTerminal !== undefined) throw new Error("Invalid request.");
  if (!fixedOffer && body.dropoffTerminal !== undefined) {
    const terminalKeys={general:"ChIJ7wzsxeFSwokRhvLXxTe087M",a:"ChIJ2dQDPZNSwokRVJr9XE2SPt0",b:"ChIJ-6uTxfZSwokR-VfW-WSM53k",c:"ChIJMYEleJSwokRawcDBeH8NVg"};
    if (!Object.hasOwn(terminalKeys,body.dropoffTerminal) || terminalKeys[body.dropoffTerminal]!==body.dropoffPlaceId) throw new Error("Invalid request.");
    verifiedDropoff=await verifyEwrPickup({pickupPlaceId:body.dropoffPlaceId,pickup:body.dropoff});
  }
  const route = isHourly ? null :
    await getRouteEstimate(
      verifiedPickup ? {placeId:verifiedPickup.placeId} : body.pickup,
      verifiedDropoff ? {placeId:verifiedDropoff.placeId} : body.dropoff,
      isRoundTrip ? new Date(parseServiceDateTime(body.date, body.time, "pickup")).toISOString() : undefined
    );
  const returnRoute = isRoundTrip ? await getRouteEstimate(verifiedDropoff ? {placeId:verifiedDropoff.placeId} : body.dropoff, verifiedPickup ? {placeId:verifiedPickup.placeId} : body.pickup,
    new Date(parseServiceDateTime(body.returnDate, body.returnTime, "return")).toISOString()) : null;

  /*
    Verify fixed offer before
    calculating normal pricing.
  */

  if (fixedOffer) {
    validateCalculatedFare(body.vehicle, fixedOffer.price);
    return {
      vehicle:
        rate.label,

      vehicleKey:
        body.vehicle,

      miles:
        money(route.miles),

      minutes:
        Math.round(
          route.minutes
        ),

      baseTotal:
        fixedOffer.price,

      discount: 0,

      discountedFare:
        fixedOffer.price,

      gratuity: 0,

      originalTotal:
        fixedOffer.price,

      total:
        fixedOffer.price,

      currency:
        pricing.currency,

      promotion: null,

      surcharges: [],

      fixedOffer
    };
  }


  /*
    NORMAL TRIP PRICING
  */

  const outbound = isRoundTrip ? roundTripLeg(body, rate, route, false) : null;
  const returned = isRoundTrip ? roundTripLeg(body, rate, returnRoute, true) : null;
  const single = isRoundTrip ? null : calculateLegFare(rate, route, body.pickup, body.dropoff,
    body.time, isHourly ? bookedHours : undefined);
  const fare = isRoundTrip ? money(outbound.fare + returned.fare) : single.fare;
  const surcharges = isRoundTrip ? [...outbound.surcharges, ...returned.surcharges] : single.surcharges;
  const roundTrip = isRoundTrip ? {outbound, return: returned, subtotal: fare} : undefined;


  /*
    PROMOTION
  */

  const promotion =
    await getPromotion(body);

  const {discount, discountedFare, gratuity, originalTotal, total} = calculateFareTotals(fare, promotion);

  validateCalculatedFare(body.vehicle, total);

  const normalQuote = {
    vehicle:
      isHourly && body.vehicle === "escalade" ? "Cadillac Escalade ESV" : rate.label,

    vehicleKey:
      body.vehicle,

    miles:
      isHourly ? null : money(route.miles + (returnRoute?.miles || 0)),

    minutes:
      isHourly ? null : Math.round(
        route.minutes + (returnRoute?.minutes || 0)
      ),

    roundTrip,

    hourlyRate: isHourly ? rate.hourlyRate : undefined,
    hours: isHourly ? bookedHours : undefined,

    baseTotal:
      fare,

    discount,

    discountedFare,

    gratuity,

    originalTotal,

    total,

    currency:
      pricing.currency,

    promotion,

    surcharges,

    fixedOffer: null
  };
  if (verifiedPickup) Object.defineProperty(normalQuote,"verifiedPickup",{value:verifiedPickup});
  if (verifiedDropoff) Object.defineProperty(normalQuote,"verifiedDropoff",{value:verifiedDropoff});
  return normalQuote;
}


/* =========================================
   CREATE BOOKING
========================================= */

function createBookingRecord(
  body,
  quote
) {
  return {
    id:
      crypto.randomUUID(),

    createdAt:
      new Date().toISOString(),

    status:
      "awaiting_payment",

    paymentStatus:
      "unpaid",

    stripeSessionId:
      null,


    customer: {
      firstName:
        sanitizeText(
          body.firstName,
          80
        ),

      lastName:
        sanitizeText(
          body.lastName,
          80
        ),

      email:
        sanitizeText(
          body.email,
          160
        ),

      phone:
        sanitizeText(
          body.phone,
          60
        )
    },


    trip: {
      ...(body.dropoffTerminal !== undefined ? {dropoffPlaceId:body.dropoffPlaceId || null} : {}),
      ...((body.offerCode || body.pickupTerminal !== undefined) ? {pickupPlaceId:body.pickupPlaceId || null} : {}),
      tripType:
        sanitizeText(
          body.tripType,
          30
        ),

      pickup:
        sanitizeText(
          (quote?.fixedOffer?.verifiedPickup || quote?.verifiedPickup) ? `${(quote.fixedOffer?.verifiedPickup || quote.verifiedPickup).label}, ${(quote.fixedOffer?.verifiedPickup || quote.verifiedPickup).address}` : body.pickup
        ),

      dropoff:
        sanitizeText(
          quote?.verifiedDropoff ? `${quote.verifiedDropoff.label}, ${quote.verifiedDropoff.address}` : body.dropoff
        ),

      date:
        sanitizeText(
          body.date,
          20
        ),

      time:
        sanitizeText(
          body.time,
          20
        ),

      returnDate:
        sanitizeText(
          body.returnDate,
          20
        ),

      returnTime:
        sanitizeText(
          body.returnTime,
          20
        ),

      hours:
        sanitizeText(
          body.hours,
          20
        ),

      passengers:
        Number(
          body.passengers || 1
        ),

      vehicle:
        sanitizeText(
          body.vehicle,
          40
        ),

      flightNumber:
        sanitizeText(
          body.flightNumber,
          40
        ),

      notes:
        sanitizeText(
          body.notes,
          700
        ),

      promoCode:
        normalizePromoCode(
          body.promoCode
        ),

      offerCode:
        sanitizeText(
          body.offerCode,
          50
        ).toUpperCase()
    },


    quote,


    dispatch: {
      driver: "",
      driverPhone: "",
      vehicle: "",
      plate: ""
    }
  };
}


/* =========================================
   ADMIN SECURITY
========================================= */

function adminSessionKey(req) {
  const cookies = String(req.headers.cookie || "").split(";").map(value => value.trim());
  const matches = cookies.filter(value => value.startsWith(`${adminCookieName}=`));
  if (matches.length !== 1) return null;
  const id = matches[0].slice(adminCookieName.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  return crypto.createHash("sha256").update(id).digest("hex");
}

function clearAdminCookie(res) {
  res.clearCookie(adminCookieName, adminCookieOptions);
}

function adminNoStore(req, res, next) {
  res.set("Cache-Control", "no-store");
  next();
}

function customerPrivateResponse(req, res, next) {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  next();
}

function customerAccessCookieName(id) {
  return `${adminCookieSecure ? "__Secure-" : ""}er_booking_access_${id}`;
}

function customerAccessCookieOptions(id) {
  return {httpOnly: true, secure: adminCookieSecure, sameSite: "strict", path: `/api/booking/${id}`};
}

function newCustomerAccess(body, token = crypto.randomBytes(32).toString("base64url")) {
  const lastScheduled = body.tripType === "roundtrip"
    ? parseServiceDateTime(body.returnDate, body.returnTime, "return")
    : parseServiceDateTime(body.date, body.time, "pickup") +
      (body.tripType === "hourly" ? Number(body.hours) * 60 * MINUTE : 0);
  // Usable for at least 30 days, or through 7 days after the final scheduled leg.
  return {tokenHash: checkoutHash(token),
    expiresAt: Math.max(Date.now() + 30 * 24 * 60 * MINUTE, lastScheduled + 7 * 24 * 60 * MINUTE)};
}

function validCustomerAccessData(booking) {
  const access = booking?.customerAccess;
  return access && typeof access.tokenHash === "string" && /^[a-f0-9]{64}$/.test(access.tokenHash) &&
    Number.isFinite(access.expiresAt) && access.expiresAt > Date.now();
}

function checkoutCustomerResult(url, id) {
  return {url, bookingId:id};
}

function checkoutAccessCookieName(id) {
  return `${adminCookieSecure ? "__Secure-" : ""}er_checkout_access_${id}`;
}

function issueCustomerAccessCookies(res, booking, token) {
  const maxAge=booking.customerAccess.expiresAt-Date.now();
  res.cookie(customerAccessCookieName(booking.id),token,{...customerAccessCookieOptions(booking.id),maxAge});
  // Separate restricted paths: the status credential is not broadened to all APIs.
  res.cookie(checkoutAccessCookieName(booking.id),token,{
    httpOnly:true,secure:adminCookieSecure,sameSite:"strict",path:"/api/checkout",maxAge
  });
}

function hasCustomerAccess(req, booking, checkout = false) {
  if (!validCustomerAccessData(booking)) return false;
  const names=checkout ? [checkoutAccessCookieName(booking.id),customerAccessCookieName(booking.id)]
    : [customerAccessCookieName(booking.id)];
  const cookies=String(req.headers.cookie || "").split(";").map(value=>value.trim());
  let supplied=false;
  for(const name of names) {
    const matches=cookies.filter(value=>value.startsWith(`${name}=`));
    if(!matches.length)continue;
    if(matches.length!==1)return false;
    const token=matches[0].slice(name.length+1);
    if(!/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !crypto.timingSafeEqual(Buffer.from(checkoutHash(token),"hex"),Buffer.from(booking.customerAccess.tokenHash,"hex")))return false;
    supplied=true;
  }
  return supplied;
}

function validAdminOrigin(req) {
  // Cookie authentication must not turn state-changing admin routes into CSRF targets.
  const origin = req.get("origin");
  const site = req.get("sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site)) return false;
  return !origin || origin === new URL(SITE_URL).origin;
}

function requireAdmin(req, res, next) {
  res.set("Cache-Control", "no-store");
  if (!["GET", "HEAD"].includes(req.method) && !validAdminOrigin(req)) {
    return res.status(403).json({error: "Unauthorized"});
  }
  const key = adminSessionKey(req);
  const session = key && adminSessions.get(key);
  const now = Date.now();
  if (!session || session.expiresAt <= now || session.lastSeen + ADMIN_SESSION_IDLE_MS <= now) {
    if (key) adminSessions.delete(key);
    clearAdminCookie(res);
    return res.status(401).json({error: "Unauthorized"});
  }
  session.lastSeen = now;
  next();
}


/* =========================================
   STRIPE WEBHOOK
   MUST BE BEFORE express.json()
========================================= */

app.post(
  "/api/stripe-webhook",

  express.raw({
    type:
      "application/json"
  }),

  route(async (req, res) => {
    if (
      !stripe ||
      !process.env
        .STRIPE_WEBHOOK_SECRET
    ) {
      req.diagnosticCategory='configuration_unavailable';req.diagnosticProvider='stripe';
      return res.status(503).json({error:`Service temporarily unavailable. Please try again. Reference: ${req.referenceId}`});
    }

    let event;

    try {
      const sig =
        req.headers[
          "stripe-signature"
        ];

      event =
        stripe.webhooks
          .constructEvent(
            req.body,
            sig,
            process.env
              .STRIPE_WEBHOOK_SECRET
          );

    } catch (error) {
      req.diagnosticCategory='invalid_signature';req.diagnosticProvider='stripe';
      return res.status(400).json({error:`Webhook request rejected. Reference: ${req.referenceId}`});
    }


    const checkoutEvents = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed"
    ];

    if (checkoutEvents.includes(event.type)) {
      const session = event.data?.object;
      const bookingId = session?.metadata?.bookingId;
      if (typeof bookingId !== "string") return res.status(400).json({error:`Webhook request rejected. Reference: ${req.referenceId}`});
      const changed = await reservationStore.update(bookingId, async booking => {

      if (!booking || !booking.stripeSessionId || booking.stripeSessionId !== session?.id) {
        throw Object.assign(new Error("Checkout session does not match a reservation."),{status:400});
      }

      const expectedTotal = booking.quote?.total;
      const expectedAmount = Math.round(expectedTotal * 100);
      const expectedCurrency = booking.quote?.currency;
      if (
        typeof expectedTotal !== "number" || !Number.isFinite(expectedTotal) || expectedTotal <= 0 ||
        !Number.isSafeInteger(expectedAmount) || expectedAmount <= 0 ||
        session.mode !== "payment" ||
        !Number.isSafeInteger(session.amount_total) || session.amount_total !== expectedAmount ||
        typeof expectedCurrency !== "string" || typeof session.currency !== "string" ||
        session.currency.toLowerCase() !== expectedCurrency.toLowerCase()
      ) {
        throw Object.assign(new Error("Checkout payment does not match the reservation fare."),{status:400});
      }

      // A completed Checkout session may still be awaiting payment.
      // Repeated or out-of-order events must not reset paid/dispatch state.
      if (booking.paymentStatus !== "paid") {
        if (event.type !== "checkout.session.async_payment_failed" && session.payment_status === "paid") {
          booking.paymentStatus = "paid";
          if (booking.status === "awaiting_payment") booking.status = "confirmed";
          booking.paidAt = new Date().toISOString();
          if(booking.checkoutAttempt?.version===1) {booking.checkoutAttempt.state="confirmed_paid";booking.checkoutAttempt.evidence="verified_webhook";}
        } else if (
          event.type === "checkout.session.async_payment_failed" &&
          session.payment_status === "unpaid" && booking.paymentStatus !== "failed"
        ) {
          booking.paymentStatus = "failed";
          booking.paymentFailedAt = new Date().toISOString();
        }
      }
      });
      if (!changed) return res.status(400).json({error:`Webhook request rejected. Reference: ${req.referenceId}`});
    }

    res.json({
      received: true
    });
  })
);


/* =========================================
   EXPRESS
========================================= */

app.use("/api/address-suggestions", rateLimit("address", 120));
app.use("/api/quote", rateLimit("quote", 30));
app.use("/api/checkout", customerPrivateResponse, rateLimit("checkout", 15), rateLimit("checkout-long", 60, 30 * MINUTE));
app.use("/api/booking", customerPrivateResponse, rateLimit("booking-status", 120));
app.use("/success.html", customerPrivateResponse);
app.use("/api/bookings", adminNoStore, rateLimit("admin-requests", 120));
app.use("/api/admin", adminNoStore, rateLimit("admin-requests", 120));
app.use("/admin.html", adminNoStore);

app.use(
  express.json({
    limit: "50kb"
  })
);

const customerAuth=require('./auth/customers').installCustomerAuth(app,{store:reservationStore,route,rateLimit,
  validOrigin:validAdminOrigin,secure:adminCookieSecure,now:()=>Date.now()});
const {tripQuery}=require('./storage/customer-trips');
app.get('/api/customer/trips',route(customerAuth.requireCustomer),route(async(req,res)=>{
  const query=tripQuery(req.query,Date.now());
  res.json(await reservationStore.customerTrips(req.customer.id,query));
}));
app.get('/api/customer/trips/:id',route(customerAuth.requireCustomer),route(async(req,res)=>{
  const trip=await reservationStore.customerTrip(req.customer.id,req.params.id);
  if(!trip)return res.status(404).json({error:'Trip not found.'});
  res.json({trip});
}));

require('./auth/recovery').installPasswordRecovery(app,{store:reservationStore,emailProvider:recoveryEmailProvider,route,rateLimit,
  validOrigin:validAdminOrigin,clientKey,secure:adminCookieSecure,now:()=>Date.now(),
  reportFailure:req=>logDiagnostic(req,503,'provider_error')});

app.use(['/reset-password.html','/reset-password.js'],(req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"});next();});

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


/* Admin session credentials are accepted only at login, never on normal APIs. */
app.post("/api/admin/login", (req, res) => {
  if (!validAdminOrigin(req) || !req.is("application/json")) {
    return res.status(403).json({error: "Unauthorized"});
  }
  const configured = process.env.ADMIN_TOKEN;
  if (!configured) return res.status(503).json({error: "Authentication unavailable."});
  const supplied = req.body && !Array.isArray(req.body) && Object.hasOwn(req.body, "token") &&
    typeof req.body.token === "string" ? req.body.token : "";
  // Equal-size digests make credential comparison independent of guessed prefixes.
  const matches = supplied.length > 0 && crypto.timingSafeEqual(
    crypto.createHash("sha256").update(supplied).digest(),
    crypto.createHash("sha256").update(configured).digest());
  if (!matches) {
    const retryAfter = consumeLimit("admin-failures", clientKey(req), 10, 15 * MINUTE);
    if (retryAfter) return tooManyRequests(res, retryAfter);
    return res.status(401).json({error: "Unauthorized"});
  }
  const previous = adminSessionKey(req);
  if (previous) adminSessions.delete(previous);
  if (adminSessions.size >= 2000) return res.status(503).json({error: "Authentication unavailable."});
  const id = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  adminSessions.set(crypto.createHash("sha256").update(id).digest("hex"), {
    expiresAt: now + ADMIN_SESSION_ABSOLUTE_MS, lastSeen: now
  });
  res.cookie(adminCookieName, id, {...adminCookieOptions, maxAge: ADMIN_SESSION_ABSOLUTE_MS});
  res.json({authenticated: true});
});

app.get("/api/admin/session", requireAdmin, (req, res) => res.json({authenticated: true}));

app.post("/api/admin/logout", (req, res) => {
  if (!validAdminOrigin(req) || !req.is("application/json")) {
    return res.status(403).json({error: "Unauthorized"});
  }
  const key = adminSessionKey(req);
  if (key) adminSessions.delete(key);
  clearAdminCookie(res);
  res.json({authenticated: false});
});


/* =========================================
   PUBLIC CONFIG
========================================= */

app.get(
  "/api/public-config",

  (req, res) => {
    res.json({
      companyPhone:
        process.env.COMPANY_PHONE ||
        "(973) 555-0100",

      companyEmail:
        process.env.COMPANY_EMAIL ||
        "bookings@erlimousineservice.com",

      vehicles:
        Object.entries(
          pricing.vehicleRates
        ).map(
          ([key, value]) => ({
            key,
            label:
              value.label,
            maxPassengers:
              value.maxPassengers,
            maxLuggage:
              value.maxLuggage,
            hourlyRate:
              value.hourlyRate
          })
        )
    });
  }
);


/* =========================================
   GOOGLE ADDRESS AUTOCOMPLETE
========================================= */

app.get(
  "/api/address-suggestions",

  async (req, res) => {
    try {
      const query =
        sanitizeText(
          req.query.q,
          200
        );

      if (
        !query ||
        query.length < 3
      ) {
        return res.json({
          suggestions: []
        });
      }

      const key =
        process.env
          .GOOGLE_MAPS_API_KEY;

      if (!key) {
        return res
          .status(503)
          .json({
            error:
              `Address and route lookup is temporarily unavailable. Please try again. Reference: ${req.referenceId}`,

            suggestions: []
          });
      }

      const data =
        await googleJson(
          "https://places.googleapis.com/v1/places:autocomplete",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              "X-Goog-Api-Key":
                key
            },

            body:
              JSON.stringify({
                input:
                  query,

                includedRegionCodes:
                  ["us"],

                locationBias: {
                  circle: {
                    center: {
                      latitude:
                        40.7357,

                      longitude:
                        -74.1724
                    },

                    radius:
                      50000
                  }
                }
              })
          }
        );

      const suggestions =
        Array.isArray(
          data.suggestions
        )
          ? data.suggestions
              .map(
                (item) => {
                  const prediction=item.placePrediction;
                  return prediction?.text?.text && prediction?.placeId
                    ? {description:prediction.text.text,placeId:prediction.placeId} : null;
                }
              )
              .filter(Boolean)
              .slice(0, 6)
          : [];

      return res.json({
        suggestions
      });

    } catch (error) {
      // Do not log Google error payloads or credentials.
      req.diagnosticCategory='provider_error';req.diagnosticProvider='google';

      return res
        .status(502)
        .json({
          error:
            `Address search is temporarily unavailable. Reference: ${req.referenceId}`,

          suggestions: []
        });
    }
  }
);


/* =========================================
   GET QUOTE
========================================= */

app.post(
  "/api/quote",

  async (req, res) => {
    try {
      const quote =
        await calculateQuote(
          req.body
        );

      res.json(quote);

    } catch (error) {
      sendSafeError(req,res,error,400);
    }
  }
);


/* =========================================
   STRIPE CHECKOUT
========================================= */

function checkoutHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function checkoutFingerprint(body) {
  // Only accepted booking fields matter. Arbitrary browser totals/nonce fields
  // cannot bypass protection. Include the pricing revision.
  const record = createBookingRecord(body, null);
  record.customer.email = normalizeEmail(body.email);
  record.customer.phone = normalizePhone(body.phone);
  return checkoutHash(JSON.stringify({customer: record.customer, trip: record.trip, pricing,
    ...(body.tripType === "roundtrip" ? {roundTripPricingVersion: 1} : {})}));
}

function enforceBookingBudget(bookings, body, ip) {
  const now = Date.now();
  const email = normalizeEmail(body.email);
  const phone = normalizePhone(body.phone);
  const ipHash = checkoutHash(ip);
  const unpaid = bookings.filter(item => item.paymentStatus !== "paid");
  const byCustomer = unpaid.filter(item => normalizeEmail(item.customer?.email) === email ||
    normalizePhone(item.customer?.phone) === phone);
  const byIp = unpaid.filter(item => item.checkoutClientHash === ipHash);
  const recentCount = (items, windowMs) => items.filter(item =>
    now - Date.parse(item.createdAt) < windowMs).length;
  if (recentCount(byCustomer, 30 * MINUTE) >= 6 || recentCount(byCustomer, 24 * 60 * MINUTE) >= 20 ||
      recentCount(byIp, 30 * MINUTE) >= 12 || recentCount(byIp, 24 * 60 * MINUTE) >= 40) {
    throw Object.assign(new Error("Too many requests. Please try again later."), {status: 429});
  }
}

async function saveCheckoutBooking(booking) {
  const result=await reservationStore.update(booking.id, stored => {
    Object.assign(stored,{quote:booking.quote,stripeSessionId:booking.stripeSessionId,checkoutAttempt:booking.checkoutAttempt});
    if(stored.paymentStatus === "paid" && stored.checkoutAttempt?.version===1)stored.checkoutAttempt.state="confirmed_paid";
  });
  if(!result)throw new StorageError();
}

// FIRST15 recovery inspects existing provider objects; it never creates or reopens a trip.
function matchesFirstRideSession(session,booking) {
  const a=booking.checkoutAttempt,q=a?.quote;
  return !!session && /^cs_[A-Za-z0-9_]+$/.test(session.id || '') &&
    session.metadata?.bookingId===booking.id && session.metadata?.promoCode==='FIRST15' &&
    session.metadata?.discount===String(q?.discount || 0) && session.mode==='payment' &&
    Number.isSafeInteger(session.amount_total) && session.amount_total===Math.round(q?.total*100) &&
    session.currency===q?.currency && ['open','complete','expired'].includes(session.status) &&
    ['unpaid','paid','no_payment_required'].includes(session.payment_status) &&
    (!a.correlationId || (session.metadata?.attemptReference===a.correlationId && session.expires_at===a.expiresAt));
}
async function reconcileFirstRide(id) {
  const initial=await reservationStore.get(id);
  if(!initial?.checkoutFingerprint || initial.checkoutAttempt?.quote.promotion?.code!=='FIRST15')return;
  return reservationStore.withActionLock(initial.checkoutFingerprint,async()=>{
    const booking=await reservationStore.get(id),a=booking?.checkoutAttempt;
    if(!a || a.quote.promotion?.code!=='FIRST15' || booking.paymentStatus==='paid' || a.state==='confirmed_unpaid')return;
    let outcome={state:'review_required',evidence:'no_conclusive_evidence',at:Date.now()},session,expectedSessionId=booking.stripeSessionId;
    if(a.version===1 && a.state==='prepared' && a.firstSubmittedAt===null && a.submissionCount===0 && !booking.stripeSessionId) {
      outcome={...outcome,state:'confirmed_unpaid',evidence:'not_submitted'};
    } else {
      try {
        if(!stripe)throw new Error();
        const options={timeout:10000,maxNetworkRetries:0},deadline=Date.now()+30000;
        if(booking.stripeSessionId)session=await stripe.checkout.sessions.retrieve(booking.stripeSessionId,{},options);
        else if(a.version===1 && Number.isFinite(a.firstSubmittedAt) && a.correlationId) {
          const candidates=[];let cursor,complete=false;
          for(let page=0;page<10 && Date.now()<deadline;page++) {
            const batch=await stripe.checkout.sessions.list({limit:100,
              created:{gte:Math.floor(a.firstSubmittedAt/1000)-300,lte:Math.floor(Date.now()/1000)},
              ...(cursor ? {starting_after:cursor} : {})},options);
            if(!Array.isArray(batch?.data) || typeof batch.has_more!=='boolean')throw new Error();
            for(const item of batch.data)if(item.metadata?.bookingId===booking.id && item.metadata?.attemptReference===a.correlationId)candidates.push(item);
            if(!batch.has_more){complete=true;break;}
            const next=batch.data.at(-1)?.id;if(!next || next===cursor)throw new Error();cursor=next;
          }
          if(!complete)outcome.evidence='incomplete_scan';
          else if(candidates.length>1)outcome.evidence='conflicting_sessions';
          else if(candidates.length===1) {
            if(!matchesFirstRideSession(candidates[0],booking))outcome.evidence='session_mismatch';
            else {expectedSessionId=candidates[0].id;session=await stripe.checkout.sessions.retrieve(expectedSessionId,{},options);}
          }
        } else outcome.evidence='legacy_without_correlation';
        if(session) {
          if(!matchesFirstRideSession(session,booking) || session.id!==expectedSessionId)outcome.evidence='session_mismatch';
          else {
            outcome.sessionId=session.id;
            if(session.payment_status==='paid')Object.assign(outcome,{state:'confirmed_paid',evidence:'verified_paid'});
            else if(session.status==='expired' && session.payment_status==='unpaid')Object.assign(outcome,{state:'confirmed_unpaid',evidence:'verified_expired_unpaid'});
            else Object.assign(outcome,{state:'session_identified',evidence:session.status==='open' ? 'open_session' : 'payment_pending'});
          }
        }
      } catch(_) {outcome={state:'review_required',evidence:'provider_unavailable',at:Date.now()};}
    }
    await reservationStore.finalizeReconciliation(booking,outcome);
  });
}
let reconciliationRunning=false;
async function runFirstRideReconciliation() {
  if(reconciliationRunning)return;
  reconciliationRunning=true;
  try {
    await storageReady;
    for(const booking of await reservationStore.reconciliationCandidates(10)) {
      try {await reconcileFirstRide(booking.id);} catch(error) {
        if(error.status!==409)logDiagnostic({referenceId:crypto.randomUUID(),route:{path:'/api/checkout'}},503,'storage_unavailable','postgresql');
      }
    }
  } finally {reconciliationRunning=false;}
}
const reconciliationTimer=setInterval(()=>runFirstRideReconciliation().catch(()=>{
  logDiagnostic({referenceId:crypto.randomUUID(),route:{path:'/api/checkout'}},503,'storage_unavailable','postgresql');
}),5*MINUTE);
reconciliationTimer.unref();

app.post('/api/bookings/:id/reconcile',requireAdmin,rateLimit('admin-reconciliation',10),route(async(req,res)=>{
  await reconcileFirstRide(req.params.id);res.json({ok:true});
}));

async function createCheckout(body, ip, fingerprint, req, res) {
  if (!stripe) {
    throw Object.assign(new Error("Stripe is not configured. Add STRIPE_SECRET_KEY before accepting payments."), {status: 503});
  }

  let booking = (await readBookings()).find(item =>
    item.checkoutFingerprint === fingerprint && item.status !== "cancelled" &&
    (Date.now() - Date.parse(item.createdAt) < 24 * 60 * MINUTE ||
      item.checkoutAttempt?.quote.promotion?.code==='FIRST15'));
  // Matching booking data is only a lookup key, never an ownership credential.
  // This check runs under the database action lock, before provider calls or mutations.
  if (booking && !hasCustomerAccess(req,booking,true)) {
    throw Object.assign(new Error("Checkout is temporarily unavailable. Please try again."),{status:503});
  }

  if(booking && req.customer){
    const owner=await reservationStore.reservationOwner(booking.id);
    if(owner && owner!==req.customer.id)throw Object.assign(new Error('Checkout is temporarily unavailable. Please try again.'),{status:503});
  }

  /*
    IMPORTANT:
    The price is calculated again
    on the server.

    The browser cannot choose the
    Stripe payment amount.
  */

  let quote =
    await calculateQuote(
      body
    );

  // Independently validate the final server quote before storing a booking
  // or creating a Stripe session, even if quote calculation changes later.
  await validateCheckoutQuote(body, quote);
  if (quote.vehicleKey !== body.vehicle) {
    throw new Error("Calculated fare does not match the selected vehicle.");
  }
  const checkoutAmount = Math.round(quote.total * 100);
  if (!Number.isSafeInteger(checkoutAmount) || checkoutAmount <= 0) {
    throw new Error("Calculated Checkout amount is invalid.");
  }

  // Google work may have taken long enough for a near-term pickup to pass.
  validateBookingInput(body);
  if (booking?.paymentStatus === "paid") {
    throw Object.assign(new Error("This reservation has already been paid."), {status: 409});
  }
  if (booking?.stripeSessionId) {
    await validateCheckoutQuote(body, booking.quote);
    let existing;
    try {
      existing = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);
    } catch (_) {
      throw Object.assign(new Error("Checkout is temporarily unavailable. Please try again."), {status: 503});
    }
    if (existing.status === "open" && existing.url) {
      return checkoutCustomerResult(existing.url, booking.id);
    }
    if (existing.status !== "expired") {
      throw Object.assign(new Error("Checkout is already processing for this reservation."), {status: 409});
    }
    if(booking.quote.promotion?.code==='FIRST15' && existing.payment_status!=='unpaid')throw Object.assign(new Error("Checkout is already processing for this reservation."),{status:409});
    booking.stripeSessionId = null;
    booking.checkoutAttempt = null;
  }
  if (!booking) {
    booking = createBookingRecord(body, quote);
    const token=crypto.randomBytes(32).toString("base64url");
    booking.customerAccess = newCustomerAccess(body,token);
    booking.checkoutFingerprint = fingerprint;
    booking.checkoutClientHash = checkoutHash(ip);
    const start=parseServiceDateTime(body.date,body.time,'pickup');
    const end=body.tripType==='roundtrip'?parseServiceDateTime(body.returnDate,body.returnTime,'return'):
      start+(body.tripType==='hourly'?Number(body.hours)*60*MINUTE:0);
    await reservationStore.createWithBudget(booking, bookings => enforceBookingBudget(bookings, body, ip),{
      customerId:req.customer?.id || null,sessionHash:req.customerSessionHash,
      now:Date.now(),start:new Date(start),end:new Date(end)
    });
    // Also delivered on a safe error response, allowing ownership-proven ambiguous retries.
    issueCustomerAccessCookies(res,booking,token);
  }
  const resumingFirstRideAttempt=!!booking.checkoutAttempt;
  // Persist the attempt before contacting Stripe. Network failures retry the same
  // key/reservation, including after a process restart, rather than double-create.
  if (!booking.checkoutAttempt || booking.checkoutAttempt.state==='confirmed_unpaid' || (booking.checkoutAttempt.expiresAt <= Math.floor(Date.now() / 1000) &&
      booking.checkoutAttempt.quote.promotion?.code !== 'FIRST15')) {
    booking.checkoutAttempt = {
      key: crypto.randomUUID(),
      ...(quote.promotion?.code==='FIRST15' ? {version:1,correlationId:crypto.randomUUID(),state:'prepared',
        firstSubmittedAt:null,lastReconciledAt:null,submissionCount:0,evidence:'not_submitted'} : {}),
      // Retain Stripe's normal 24-hour Checkout window.
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      quote
    };
  }
  // Retry with identical server quote and parameters used for this attempt.
  quote = booking.checkoutAttempt.quote;
  await validateCheckoutQuote(body, quote);
  if (quote.vehicleKey !== body.vehicle || !Number.isSafeInteger(Math.round(quote.total * 100)) ||
      Math.round(quote.total * 100) <= 0) {
    throw new Error("Calculated Checkout amount is invalid.");
  }
  booking.quote = quote;
  await saveCheckoutBooking(booking);
  if(quote.promotion?.code==='FIRST15') {
    // A new customer's contact fields never authorize mutation of someone else's attempt.
    // Independent authenticated/server reconciliation resolves old claims instead.
    await reservationStore.claimFirstRide(booking);
  }

  let description =
    `${booking.trip.pickup} → ${booking.trip.dropoff} | ${booking.trip.date} ${booking.trip.time}`;

  if (quote.fixedOffer) {
    description =
      `${booking.trip.pickup} → ${booking.trip.dropoff} | EWR → Manhattan $150 Flat Rate`;
  } else if (quote.promotion) {
    description =
      `${booking.trip.pickup} → ${booking.trip.dropoff} | ${quote.promotion.code} applied`;
  }


  // Recheck after asynchronous Google/Stripe lookups before payment creation.
  try {validateBookingInput(body);} catch(error) {
    // No Stripe call has been made in this action. Clear only a newly prepared,
    // unclaimed attempt; a previous ambiguous attempt must remain reconcilable.
    if(quote.promotion?.code==='FIRST15' && !booking.stripeSessionId && !resumingFirstRideAttempt) {
      booking.checkoutAttempt=null;
      await saveCheckoutBooking(booking);
    }
    throw error;
  }
  const parameters={
        mode:
          "payment",

        expires_at: booking.checkoutAttempt.expiresAt,

        customer_email:
          booking
            .customer
            .email,

        line_items: [
          {
            quantity: 1,

            price_data: {
              currency:
                quote.currency,

              unit_amount:
                Math.round(quote.total * 100),

              product_data: {
                name:
                  quote.fixedOffer
                    ? "ER Limousine Service — EWR to Manhattan Black SUV"
                    : `ER Limousine Service — ${quote.vehicle}`,

                description
              }
            }
          }
        ],

        metadata: {
          ...(booking.checkoutAttempt.correlationId ? {attemptReference:booking.checkoutAttempt.correlationId} : {}),
          bookingId:
            booking.id,

          offerCode:
            quote.fixedOffer
              ? quote.fixedOffer.code
              : "",

          promoCode:
            quote.promotion
              ? quote.promotion.code
              : "",

          discount:
            String(
              quote.discount || 0
            )
        },

        success_url:
          `${SITE_URL}/success.html?booking=${booking.id}&session_id={CHECKOUT_SESSION_ID}`,

        cancel_url:
          `${SITE_URL}/?cancelled=1`
  };
  const firstRide=quote.promotion?.code==='FIRST15';
  const earlierSubmission=firstRide && (booking.checkoutAttempt.version!==1 || booking.checkoutAttempt.firstSubmittedAt!==null);
  if(firstRide && (booking.checkoutAttempt.version!==1 ||
    (earlierSubmission && (booking.checkoutAttempt.expiresAt<=Math.floor(Date.now()/1000) ||
      booking.checkoutAttempt.firstSubmittedAt+24*60*MINUTE<=Date.now())) ||
    booking.checkoutAttempt.state==='review_required')) {
    booking.checkoutAttempt.state='review_required';booking.checkoutAttempt.evidence='retry_requires_reconciliation';
    booking.checkoutAttempt.lastReconciledAt=Date.now();await saveCheckoutBooking(booking);
    throw Object.assign(new Error("Checkout is temporarily unavailable. Please try again."),{status:503});
  }
  if(firstRide) {
    booking.checkoutAttempt.parameters ||= parameters;
    booking.checkoutAttempt.firstSubmittedAt ??= Date.now();
    // Persist each submission separately; do not hide ambiguous SDK retries behind a single count.
    booking.checkoutAttempt.submissionCount++;
    booking.checkoutAttempt.state='submitted_unknown';booking.checkoutAttempt.evidence='submission_indeterminate';
    await saveCheckoutBooking(booking);
  }
  let session;
  try {
    session=await stripe.checkout.sessions.create(firstRide ? booking.checkoutAttempt.parameters : parameters,
      {idempotencyKey:`er-checkout-${booking.id}-${booking.checkoutAttempt.key}`,
        ...(firstRide ? {maxNetworkRetries:0} : {})});
  } catch(error) {
    // Only a first submission's explicit pre-execution parameter rejection is definitive.
    // A later error never erases uncertainty from an earlier ambiguous call.
    const rejectedBeforeExecution=error.type==='StripeInvalidRequestError' && error.statusCode===400 &&
      ['parameter_missing','parameter_invalid_integer','parameter_invalid_string_blank'].includes(error.code);
    if(firstRide) {
      if(!earlierSubmission && rejectedBeforeExecution) {
        await reservationStore.finalizeReconciliation(booking,{state:'confirmed_unpaid',evidence:'validation_rejected_before_execution',at:Date.now()});
      } else {
        booking.checkoutAttempt.state='submitted_unknown';booking.checkoutAttempt.evidence='submission_indeterminate';
        await saveCheckoutBooking(booking);
      }
    } else if(['StripeInvalidRequestError','StripeCardError'].includes(error.type)) {
      booking.checkoutAttempt=null;await saveCheckoutBooking(booking);
    }
    throw Object.assign(new Error("Checkout is temporarily unavailable. Please try again."),{status:503});
  }
  if(firstRide) {booking.checkoutAttempt.state='session_identified';booking.checkoutAttempt.evidence='creation_response';}

  booking.stripeSessionId =
    session.id;

  await saveCheckoutBooking(booking);

  return checkoutCustomerResult(session.url, booking.id);
}

app.post("/api/checkout", async (req, res) => {
  try {
    validateBookingInput(req.body);
    await storageReady;
    await customerAuth.resolve(req,res);
    // Also throttle customer actions across changing source IPs. Normal retries
    // have ample room; arbitrary extra fields cannot reset these counters.
    for (const [kind, identity] of [
      ["email", normalizeEmail(req.body.email)], ["phone", normalizePhone(req.body.phone)]
    ]) {
      if (!identity) continue;
      const key = checkoutHash(identity);
      const retryAfter = consumeLimit(`checkout-${kind}`, key, 30, 30 * MINUTE) ||
        consumeLimit(`checkout-${kind}-daily`, key, 100, 24 * 60 * MINUTE);
      if (retryAfter) return tooManyRequests(res, retryAfter);
    }
    const fingerprint = checkoutFingerprint(req.body);
    // Do not share authenticated results with overlapping anonymous requests.
    if (checkoutActions.size >= 1000) return tooManyRequests(res);
    const actionKey=crypto.randomUUID();
    checkoutActions.set(actionKey,true);
    let result;
    try {
      result=await storageReady.then(() => reservationStore.withActionLock(fingerprint,
        () => createCheckout(req.body,clientKey(req),fingerprint,req,res)));
    } finally {checkoutActions.delete(actionKey);}
    res.json({url: result.url, bookingId: result.bookingId});
  } catch (error) {
    if (error.status === 429) return tooManyRequests(res, 30 * 60);
    if(error.message === "Checkout is already processing. Please try again.") {
      error=Object.assign(new Error("Checkout is temporarily unavailable. Please try again."),{status:503});
    }
    sendSafeError(req,res,error,400);
  }
});


/* =========================================
   ADMIN — GET BOOKINGS
========================================= */

app.get(
  "/api/bookings",

  requireAdmin,

  route(async (req, res) => {
    res.json(await readBookings());
  })
);


/* =========================================
   ADMIN — UPDATE BOOKING
========================================= */

app.patch(
  "/api/bookings/:id",

  requireAdmin,

  route(async (req, res) => {
    const allowedStatuses = [
      "awaiting_payment",
      "confirmed",
      "assigned",
      "driver_en_route",
      "passenger_on_board",
      "completed",
      "cancelled"
    ];

    const booking = await reservationStore.update(req.params.id, async booking => {
    if (req.body.status) {
      if (
        !allowedStatuses.includes(
          req.body.status
        )
      ) {
        throw Object.assign(new Error("Invalid status."),{status:400});
      }

      booking.status =
        req.body.status;
    }

    if (req.body.dispatch) {
      booking.dispatch = {
        driver:
          sanitizeText(
            req.body
              .dispatch
              .driver,
            100
          ),

        driverPhone:
          sanitizeText(
            req.body
              .dispatch
              .driverPhone,
            60
          ),

        vehicle:
          sanitizeText(
            req.body
              .dispatch
              .vehicle,
            100
          ),

        plate:
          sanitizeText(
            req.body
              .dispatch
              .plate,
            30
          )
      };
    }

    booking.updatedAt =
      new Date()
        .toISOString();

    });
    if (!booking) return res.status(404).json({error:"Booking not found."});

    res.json(
      booking
    );
  })
);


/* =========================================
   CUSTOMER BOOKING STATUS
========================================= */

app.get(
  "/api/booking/:id",

  route(async (req, res) => {
    const booking=await reservationStore.get(req.params.id);

    if (!hasCustomerAccess(req, booking)) {
      return res.status(401).json({error: "Reservation access unavailable."});
    }
    const driverVisible = ["assigned", "driver_en_route", "passenger_on_board", "completed"].includes(booking.status);
    res.json({
      id: booking.id,
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      trip: {
        pickup: booking.trip.pickup, dropoff: booking.trip.dropoff,
        date: booking.trip.date, time: booking.trip.time
      },
      quote: {vehicle: booking.quote.vehicle, total: booking.quote.total},
      dispatch: driverVisible ? {
        driver: booking.dispatch?.driver || "", driverPhone: booking.dispatch?.driverPhone || "",
        vehicle: booking.dispatch?.vehicle || "", plate: booking.dispatch?.plate || ""
      } : null
    });
  })
);


/* =========================================
   START SERVER
========================================= */

app.use((error,req,res,next)=> {
  sendSafeError(req,res,error);
});

storageReady.then(() => {
app.listen(
  PORT,
  () => {
    // Initialization is explicit and PostgreSQL-only; no JSON fallback.

    console.log(
      "ER Limousine Service started."
    );
  }
);

}).catch(async()=> { process.exitCode=1; try {await reservationStore?.close();}catch(_){} });
