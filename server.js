require("dotenv").config();

const express = require("express");
const Stripe = require("stripe");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pricing = require("./pricing");

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const DATA_FILE = path.join(__dirname, "data", "bookings.json");

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");
}

function readBookings() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeBookings(bookings) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(bookings, null, 2), "utf8");
}

function sanitizeText(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

function validateBookingInput(body) {
  const required = [
    "pickup",
    "dropoff",
    "date",
    "time",
    "vehicle",
    "firstName",
    "lastName",
    "email",
    "phone"
  ];
  const missing = required.filter((key) => !sanitizeText(body[key]));
  if (missing.length) {
    throw new Error(`Missing required fields: ${missing.join(", ")}`);
  }
  if (!pricing.vehicleRates[body.vehicle]) {
    throw new Error("Unknown vehicle type.");
  }
  const passengers = Number(body.passengers || 1);
  if (!Number.isFinite(passengers) || passengers < 1) {
    throw new Error("Passenger count is invalid.");
  }
  if (passengers > pricing.vehicleRates[body.vehicle].maxPassengers) {
    throw new Error(
      `${pricing.vehicleRates[body.vehicle].label} supports up to ${pricing.vehicleRates[body.vehicle].maxPassengers} passengers.`
    );
  }
}

async function getRouteEstimate(origin, destination) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error(
      "Google Maps API key is not configured. Add GOOGLE_MAPS_API_KEY to enable live distance pricing."
    );
  }

  const url = "https://routes.googleapis.com/directions/v2:computeRoutes";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration"
    },
    body: JSON.stringify({
      origin: { address: origin },
      destination: { address: destination },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE"
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Route lookup failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const route = data.routes && data.routes[0];
  if (!route) throw new Error("No drivable route was found.");

  const miles = route.distanceMeters / 1609.344;
  const seconds = Number(String(route.duration || "0s").replace("s", ""));
  const minutes = seconds / 60;

  return { miles, minutes };
}

function isAirportTrip(pickup, dropoff) {
  const text = `${pickup} ${dropoff}`.toLowerCase();
  return [
    "airport",
    "ewr",
    "newark liberty",
    "jfk",
    "laguardia",
    "lga",
    "teb",
    "teterboro"
  ].some((term) => text.includes(term));
}

function isLateNight(time) {
  const hour = Number(String(time).split(":")[0]);
  const start = pricing.lateNightStartHour;
  const end = pricing.lateNightEndHour;
  return hour >= start || hour < end;
}

function money(n) {
  return Math.round(n * 100) / 100;
}

async function calculateQuote(body) {
  validateBookingInput(body);

  const rate = pricing.vehicleRates[body.vehicle];
  const route = await getRouteEstimate(body.pickup, body.dropoff);

  let fare =
    rate.baseFare +
    route.miles * rate.perMile +
    route.minutes * rate.perMinute +
    pricing.tollAllowance;

  const surcharges = [];

  if (isAirportTrip(body.pickup, body.dropoff) && pricing.airportSurcharge > 0) {
    fare += pricing.airportSurcharge;
    surcharges.push({
      label: "Airport service",
      amount: pricing.airportSurcharge
    });
  }

  if (isLateNight(body.time) && pricing.lateNightSurcharge > 0) {
    fare += pricing.lateNightSurcharge;
    surcharges.push({
      label: "Late-night service",
      amount: pricing.lateNightSurcharge
    });
  }

  fare = Math.max(fare, rate.minimumFare);

  const gratuity = fare * (pricing.gratuityPercent / 100);
  const total = fare + gratuity;

  return {
    vehicle: rate.label,
    vehicleKey: body.vehicle,
    miles: money(route.miles),
    minutes: Math.round(route.minutes),
    baseTotal: money(fare),
    gratuity: money(gratuity),
    total: money(total),
    currency: pricing.currency,
    surcharges
  };
}

function createBookingRecord(body, quote) {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "awaiting_payment",
    paymentStatus: "unpaid",
    stripeSessionId: null,
    customer: {
      firstName: sanitizeText(body.firstName, 80),
      lastName: sanitizeText(body.lastName, 80),
      email: sanitizeText(body.email, 160),
      phone: sanitizeText(body.phone, 60)
    },
    trip: {
      pickup: sanitizeText(body.pickup),
      dropoff: sanitizeText(body.dropoff),
      date: sanitizeText(body.date, 20),
      time: sanitizeText(body.time, 20),
      passengers: Number(body.passengers || 1),
      vehicle: sanitizeText(body.vehicle, 40),
      flightNumber: sanitizeText(body.flightNumber, 40),
      notes: sanitizeText(body.notes, 700)
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

function requireAdmin(req, res, next) {
  const configured = process.env.ADMIN_TOKEN;
  if (!configured) return res.status(503).json({ error: "ADMIN_TOKEN is not configured." });

  const auth = req.get("authorization") || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (supplied !== configured) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Stripe webhook must use raw body and be registered before express.json().
app.post(
  "/api/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(503).send("Stripe webhook is not configured.");
    }

    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const bookingId = session.metadata && session.metadata.bookingId;
      if (bookingId) {
        const bookings = readBookings();
        const booking = bookings.find((b) => b.id === bookingId);
        if (booking) {
          booking.paymentStatus = "paid";
          booking.status = "confirmed";
          booking.stripeSessionId = session.id;
          booking.paidAt = new Date().toISOString();
          writeBookings(bookings);
        }
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/public-config", (req, res) => {
  res.json({
    companyPhone: process.env.COMPANY_PHONE || "(973) 555-0100",
    companyEmail: process.env.COMPANY_EMAIL || "bookings@erlimousineservice.com",
    vehicles: Object.entries(pricing.vehicleRates).map(([key, value]) => ({
      key,
      label: value.label,
      maxPassengers: value.maxPassengers
    }))
  });
});

app.post("/api/quote", async (req, res) => {
  try {
    const quote = await calculateQuote(req.body);
    res.json(quote);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/checkout", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({
        error: "Stripe is not configured. Add STRIPE_SECRET_KEY before accepting payments."
      });
    }

    const quote = await calculateQuote(req.body);
    const booking = createBookingRecord(req.body, quote);

    const bookings = readBookings();
    bookings.unshift(booking);
    writeBookings(bookings);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: booking.customer.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: quote.currency,
            unit_amount: Math.round(quote.total * 100),
            product_data: {
              name: `ER Limousine Service — ${quote.vehicle}`,
              description: `${booking.trip.pickup} → ${booking.trip.dropoff} | ${booking.trip.date} ${booking.trip.time}`
            }
          }
        }
      ],
      metadata: {
        bookingId: booking.id
      },
      success_url: `${SITE_URL}/success.html?booking=${booking.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/?cancelled=1`
    });

    booking.stripeSessionId = session.id;
    writeBookings(bookings);

    res.json({ url: session.url, bookingId: booking.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/bookings", requireAdmin, (req, res) => {
  res.json(readBookings());
});

app.patch("/api/bookings/:id", requireAdmin, (req, res) => {
  const allowedStatuses = [
    "awaiting_payment",
    "confirmed",
    "assigned",
    "driver_en_route",
    "passenger_on_board",
    "completed",
    "cancelled"
  ];

  const bookings = readBookings();
  const booking = bookings.find((b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: "Booking not found." });

  if (req.body.status) {
    if (!allowedStatuses.includes(req.body.status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    booking.status = req.body.status;
  }

  if (req.body.dispatch) {
    booking.dispatch = {
      driver: sanitizeText(req.body.dispatch.driver, 100),
      driverPhone: sanitizeText(req.body.dispatch.driverPhone, 60),
      vehicle: sanitizeText(req.body.dispatch.vehicle, 100),
      plate: sanitizeText(req.body.dispatch.plate, 30)
    };
  }

  booking.updatedAt = new Date().toISOString();
  writeBookings(bookings);
  res.json(booking);
});

app.get("/api/booking/:id", (req, res) => {
  const booking = readBookings().find((b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: "Booking not found." });

  // Only expose customer-safe fields.
  res.json({
    id: booking.id,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    trip: booking.trip,
    quote: booking.quote,
    dispatch:
      booking.status === "assigned" ||
      booking.status === "driver_en_route" ||
      booking.status === "passenger_on_board" ||
      booking.status === "completed"
        ? booking.dispatch
        : null
  });
});

app.listen(PORT, () => {
  ensureDataFile();
  console.log(`ER Limousine Service running at ${SITE_URL}`);
});
