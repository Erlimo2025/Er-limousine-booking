require("dotenv").config();

const express = require("express");
const Stripe = require("stripe");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { isIP } = require("net");
const pricing = require("./pricing");

const app = express();
const PORT = process.env.PORT || 3000;

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

const DATA_FILE = path.join(
  __dirname,
  "data",
  "bookings.json"
);

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;


/* =========================================
   BOOKING DATA
========================================= */

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, "[]", "utf8");
  }
}

function readBookings() {
  ensureDataFile();

  try {
    return JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );
  } catch (_) {
    return [];
  }
}

function writeBookings(bookings) {
  ensureDataFile();

  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(bookings, null, 2),
    "utf8"
  );
}


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

function hasPreviousPaidRide(email, phone) {
  const customerEmail =
    normalizeEmail(email);

  const customerPhone =
    normalizePhone(phone);

  if (!customerEmail && !customerPhone) {
    return false;
  }

  return readBookings().some((booking) => {
    if (booking.paymentStatus !== "paid") {
      return false;
    }

    const oldEmail =
      normalizeEmail(booking.customer?.email);

    const oldPhone =
      normalizePhone(booking.customer?.phone);

    const sameEmail =
      customerEmail &&
      oldEmail &&
      customerEmail === oldEmail;

    const samePhone =
      customerPhone &&
      oldPhone &&
      customerPhone === oldPhone;

    return Boolean(sameEmail || samePhone);
  });
}


/* =========================================
   PROMOTION
========================================= */

function getPromotion(body) {
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
    hasPreviousPaidRide(
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
            address: origin
          },

          destination: {
            address: destination
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

async function lookupPlace(query) {
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
            "places.displayName,places.formattedAddress,places.addressComponents,places.location,places.types"
        },

        body: JSON.stringify({
          textQuery:
            sanitizeText(query, 200),

          maxResultCount: 1,

          languageCode: "en"
        })
      }
    );

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
    lookupPlace(body.pickup),
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

  /*
    Verify EWR using the actual Google
    location returned for the pickup.

    EWR center:
    approximately 40.6895, -74.1745
  */

  const pickupLat =
    Number(
      pickupPlace.location?.latitude
    );

  const pickupLng =
    Number(
      pickupPlace.location?.longitude
    );

  let isEwr = false;

  if (
    Number.isFinite(pickupLat) &&
    Number.isFinite(pickupLng)
  ) {
    const milesFromEwr =
      distanceMiles(
        pickupLat,
        pickupLng,
        40.6895,
        -74.1745
      );

    isEwr =
      milesFromEwr <= 3;
  }

  const pickupText =
    `${
      pickupPlace.displayName?.text || ""
    } ${
      pickupPlace.formattedAddress || ""
    }`
      .toLowerCase();

  if (
    pickupText.includes(
      "newark liberty international airport"
    ) ||
    pickupText.includes(
      "newark liberty"
    )
  ) {
    isEwr = true;
  }

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

  if (!isEwr) {
    throw new Error(
      "The $150 special requires pickup at Newark Liberty International Airport (EWR)."
    );
  }

  if (!isManhattan) {
    throw new Error(
      "The $150 EWR Airport Special is available only for trips to Manhattan. Please use Get Quote for this destination."
    );
  }

  return {
    code,
    label: offer.label,
    price: money(offer.price)
  };
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

function validateCheckoutQuote(body, quote) {
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
  const promotion = getPromotion(body);
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

  const route = isHourly ? null :
    await getRouteEstimate(
      body.pickup,
      body.dropoff,
      isRoundTrip ? new Date(parseServiceDateTime(body.date, body.time, "pickup")).toISOString() : undefined
    );
  const returnRoute = isRoundTrip ? await getRouteEstimate(body.dropoff, body.pickup,
    new Date(parseServiceDateTime(body.returnDate, body.returnTime, "return")).toISOString()) : null;

  /*
    Verify fixed offer before
    calculating normal pricing.
  */

  const fixedOffer =
    await verifyFixedOffer(body);

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
    getPromotion(body);

  const {discount, discountedFare, gratuity, originalTotal, total} = calculateFareTotals(fare, promotion);

  validateCalculatedFare(body.vehicle, total);

  return {
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
      tripType:
        sanitizeText(
          body.tripType,
          30
        ),

      pickup:
        sanitizeText(
          body.pickup
        ),

      dropoff:
        sanitizeText(
          body.dropoff
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

  async (req, res) => {
    if (
      !stripe ||
      !process.env
        .STRIPE_WEBHOOK_SECRET
    ) {
      return res
        .status(503)
        .send(
          "Stripe webhook is not configured."
        );
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
      return res
        .status(400)
        .send(
          `Webhook error: ${error.message}`
        );
    }


    const checkoutEvents = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed"
    ];

    if (checkoutEvents.includes(event.type)) {
      const session = event.data?.object;
      const bookingId = session?.metadata?.bookingId;
      const bookings = readBookings();
      const booking = typeof bookingId === "string"
        ? bookings.find(item => item.id === bookingId)
        : null;

      if (!booking || !booking.stripeSessionId || booking.stripeSessionId !== session?.id) {
        return res.status(400).json({error: "Checkout session does not match a reservation."});
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
        return res.status(400).json({error: "Checkout payment does not match the reservation fare."});
      }

      // A completed Checkout session may still be awaiting payment.
      // Repeated or out-of-order events must not reset paid/dispatch state.
      if (booking.paymentStatus !== "paid") {
        if (event.type !== "checkout.session.async_payment_failed" && session.payment_status === "paid") {
          booking.paymentStatus = "paid";
          if (booking.status === "awaiting_payment") booking.status = "confirmed";
          booking.paidAt = new Date().toISOString();
          writeBookings(bookings);
        } else if (
          event.type === "checkout.session.async_payment_failed" &&
          session.payment_status === "unpaid" && booking.paymentStatus !== "failed"
        ) {
          booking.paymentStatus = "failed";
          booking.paymentFailedAt = new Date().toISOString();
          writeBookings(bookings);
        }
      }
    }

    res.json({
      received: true
    });
  }
);


/* =========================================
   EXPRESS
========================================= */

app.use("/api/address-suggestions", rateLimit("address", 120));
app.use("/api/quote", rateLimit("quote", 30));
app.use("/api/checkout", rateLimit("checkout", 15), rateLimit("checkout-long", 60, 30 * MINUTE));
app.use("/api/booking", rateLimit("booking-status", 120));
app.use("/api/bookings", adminNoStore, rateLimit("admin-requests", 120));
app.use("/api/admin", adminNoStore, rateLimit("admin-requests", 120));
app.use("/admin.html", adminNoStore);

app.use(
  express.json({
    limit: "50kb"
  })
);

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
              "Address and route lookup is temporarily unavailable. Please try again.",

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
                (item) =>
                  item
                    .placePrediction
                    ?.text
                    ?.text
              )
              .filter(Boolean)
              .slice(0, 6)
          : [];

      return res.json({
        suggestions
      });

    } catch (error) {
      // Do not log Google error payloads or credentials.

      return res
        .status(502)
        .json({
          error:
            "Address search is temporarily unavailable.",

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
      res
        .status(400)
        .json({
          error:
            error.message
        });
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

function saveCheckoutBooking(booking) {
  // Re-read after async work to preserve other reservations/webhook updates.
  const bookings = readBookings();
  const stored = bookings.find(item => item.id === booking.id);
  if (!stored) throw new Error("Checkout is temporarily unavailable. Please try again.");
  Object.assign(stored, {
    quote: booking.quote,
    stripeSessionId: booking.stripeSessionId,
    checkoutAttempt: booking.checkoutAttempt
  });
  writeBookings(bookings);
}

async function createCheckout(body, ip, fingerprint) {
  if (!stripe) {
    throw Object.assign(new Error("Stripe is not configured. Add STRIPE_SECRET_KEY before accepting payments."), {status: 503});
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
  validateCheckoutQuote(body, quote);
  if (quote.vehicleKey !== body.vehicle) {
    throw new Error("Calculated fare does not match the selected vehicle.");
  }
  const checkoutAmount = Math.round(quote.total * 100);
  if (!Number.isSafeInteger(checkoutAmount) || checkoutAmount <= 0) {
    throw new Error("Calculated Checkout amount is invalid.");
  }

  // Google work may have taken long enough for a near-term pickup to pass.
  validateBookingInput(body);
  let booking = readBookings().find(item =>
    item.checkoutFingerprint === fingerprint && item.status !== "cancelled" &&
    Date.now() - Date.parse(item.createdAt) < 24 * 60 * MINUTE);
  if (booking?.paymentStatus === "paid") {
    throw Object.assign(new Error("This reservation has already been paid."), {status: 409});
  }
  if (booking?.stripeSessionId) {
    validateCheckoutQuote(body, booking.quote);
    let existing;
    try {
      existing = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);
    } catch (_) {
      throw Object.assign(new Error("Checkout is temporarily unavailable. Please try again."), {status: 503});
    }
    if (existing.status === "open" && existing.url) {
      return {url: existing.url, bookingId: booking.id};
    }
    if (existing.status !== "expired") {
      throw Object.assign(new Error("Checkout is already processing for this reservation."), {status: 409});
    }
    booking.stripeSessionId = null;
    booking.checkoutAttempt = null;
  }
  if (!booking) {
    const bookings = readBookings();
    enforceBookingBudget(bookings, body, ip);
    booking = createBookingRecord(body, quote);
    booking.checkoutFingerprint = fingerprint;
    booking.checkoutClientHash = checkoutHash(ip);
    bookings.unshift(booking);
    writeBookings(bookings);
  }
  // Persist the attempt before contacting Stripe. Network failures retry the same
  // key/reservation, including after a process restart, rather than double-create.
  if (!booking.checkoutAttempt || booking.checkoutAttempt.expiresAt <= Math.floor(Date.now() / 1000)) {
    booking.checkoutAttempt = {
      key: crypto.randomUUID(),
      // Retain Stripe's normal 24-hour Checkout window.
      expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      quote
    };
  }
  // Retry with identical server quote and parameters used for this attempt.
  quote = booking.checkoutAttempt.quote;
  validateCheckoutQuote(body, quote);
  if (quote.vehicleKey !== body.vehicle || !Number.isSafeInteger(Math.round(quote.total * 100)) ||
      Math.round(quote.total * 100) <= 0) {
    throw new Error("Calculated Checkout amount is invalid.");
  }
  booking.quote = quote;
  saveCheckoutBooking(booking);

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
  validateBookingInput(body);
  let session;
  try {
    session = await stripe
      .checkout
      .sessions
      .create({
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
      }, {idempotencyKey: `er-checkout-${booking.id}-${booking.checkoutAttempt.key}`});
  } catch (error) {
    // Definitive failures did not create a session; ambiguous failures retain
    // their idempotency key for a safe retry.
    if (["StripeInvalidRequestError", "StripeCardError"].includes(error.type)) {
      booking.checkoutAttempt = null;
      saveCheckoutBooking(booking);
    }
    throw Object.assign(new Error("Checkout is temporarily unavailable. Please try again."), {status: 503});
  }

  booking.stripeSessionId =
    session.id;

  saveCheckoutBooking(booking);

  return {url: session.url, bookingId: booking.id};
}

app.post("/api/checkout", async (req, res) => {
  try {
    validateBookingInput(req.body);
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
    let action = checkoutActions.get(fingerprint);
    if (!action) {
      if (checkoutActions.size >= 1000) return tooManyRequests(res);
      action = createCheckout(req.body, clientKey(req), fingerprint);
      checkoutActions.set(fingerprint, action);
      // All overlapping requests for the same action share one result.
      action.finally(() => checkoutActions.delete(fingerprint)).catch(() => {});
    }
    res.json(await action);
  } catch (error) {
    if (error.status === 429) return tooManyRequests(res, 30 * 60);
    res.status(error.status || 400).json({error: error.message});
  }
});


/* =========================================
   ADMIN — GET BOOKINGS
========================================= */

app.get(
  "/api/bookings",

  requireAdmin,

  (req, res) => {
    res.json(
      readBookings()
    );
  }
);


/* =========================================
   ADMIN — UPDATE BOOKING
========================================= */

app.patch(
  "/api/bookings/:id",

  requireAdmin,

  (req, res) => {
    const allowedStatuses = [
      "awaiting_payment",
      "confirmed",
      "assigned",
      "driver_en_route",
      "passenger_on_board",
      "completed",
      "cancelled"
    ];

    const bookings =
      readBookings();

    const booking =
      bookings.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!booking) {
      return res
        .status(404)
        .json({
          error:
            "Booking not found."
        });
    }

    if (req.body.status) {
      if (
        !allowedStatuses.includes(
          req.body.status
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              "Invalid status."
          });
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

    writeBookings(
      bookings
    );

    res.json(
      booking
    );
  }
);


/* =========================================
   CUSTOMER BOOKING STATUS
========================================= */

app.get(
  "/api/booking/:id",

  (req, res) => {
    const booking =
      readBookings()
        .find(
          (item) =>
            item.id ===
            req.params.id
        );

    if (!booking) {
      return res
        .status(404)
        .json({
          error:
            "Booking not found."
        });
    }

    res.json({
      id:
        booking.id,

      status:
        booking.status,

      paymentStatus:
        booking.paymentStatus,

      trip:
        booking.trip,

      quote:
        booking.quote,

      dispatch:
        booking.status ===
          "assigned" ||

        booking.status ===
          "driver_en_route" ||

        booking.status ===
          "passenger_on_board" ||

        booking.status ===
          "completed"

          ? booking.dispatch

          : null
    });
  }
);


/* =========================================
   START SERVER
========================================= */

app.listen(
  PORT,
  () => {
    ensureDataFile();

    console.log(
      `ER Limousine Service running at ${SITE_URL}`
    );
  }
);
