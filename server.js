require("dotenv").config();

const express = require("express");
const Stripe = require("stripe");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pricing = require("./pricing");

const app = express();

const PORT = process.env.PORT || 3000;

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
    fs.mkdirSync(dir, {
      recursive: true
    });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      "[]",
      "utf8"
    );
  }
}


function readBookings() {
  ensureDataFile();

  return JSON.parse(
    fs.readFileSync(
      DATA_FILE,
      "utf8"
    )
  );
}


function writeBookings(bookings) {
  ensureDataFile();

  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(
      bookings,
      null,
      2
    ),
    "utf8"
  );
}


/* =========================================
   HELPERS
========================================= */

function sanitizeText(
  value,
  max = 200
) {
  return String(value || "")
    .trim()
    .slice(0, max);
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

  const missing =
    required.filter(
      (key) =>
        !sanitizeText(body[key])
    );

  if (missing.length) {
    throw new Error(
      `Missing required fields: ${missing.join(", ")}`
    );
  }

  if (
    !pricing.vehicleRates[
      body.vehicle
    ]
  ) {
    throw new Error(
      "Unknown vehicle type."
    );
  }

  const passengers =
    Number(
      body.passengers || 1
    );

  if (
    !Number.isFinite(passengers) ||
    passengers < 1
  ) {
    throw new Error(
      "Passenger count is invalid."
    );
  }

  const maxPassengers =
    pricing.vehicleRates[
      body.vehicle
    ].maxPassengers;

  if (
    passengers >
    maxPassengers
  ) {
    throw new Error(
      `${
        pricing.vehicleRates[
          body.vehicle
        ].label
      } supports up to ${
        maxPassengers
      } passengers.`
    );
  }
}


/* =========================================
   GOOGLE ROUTES
========================================= */

async function getRouteEstimate(
  origin,
  destination
) {

  const key =
    process.env
      .GOOGLE_MAPS_API_KEY;

  if (!key) {
    throw new Error(
      "Google Maps API key is not configured."
    );
  }

  const url =
    "https://routes.googleapis.com/directions/v2:computeRoutes";

  const response =
    await fetch(
      url,
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
            address:
              destination
          },

          travelMode:
            "DRIVE",

          routingPreference:
            "TRAFFIC_AWARE"
        })
      }
    );

  if (!response.ok) {

    const detail =
      await response.text();

    throw new Error(
      `Route lookup failed (${response.status}): ${detail.slice(0, 300)}`
    );
  }

  const data =
    await response.json();

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

  const minutes =
    seconds / 60;

  return {
    miles,
    minutes
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
    pricing
      .lateNightStartHour;

  const end =
    pricing
      .lateNightEndHour;

  return (
    hour >= start ||
    hour < end
  );
}


function money(number) {
  return (
    Math.round(
      number * 100
    ) / 100
  );
}


/* =========================================
   PRICE CALCULATION
========================================= */

async function calculateQuote(
  body
) {

  validateBookingInput(body);

  const rate =
    pricing.vehicleRates[
      body.vehicle
    ];

  const route =
    await getRouteEstimate(
      body.pickup,
      body.dropoff
    );

  let fare =
    rate.baseFare +
    route.miles *
      rate.perMile +
    route.minutes *
      rate.perMinute +
    pricing.tollAllowance;

  const surcharges = [];


  if (
    isAirportTrip(
      body.pickup,
      body.dropoff
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
    isLateNight(body.time) &&
    pricing
      .lateNightSurcharge > 0
  ) {

    fare +=
      pricing
        .lateNightSurcharge;

    surcharges.push({
      label:
        "Late-night service",

      amount:
        pricing
          .lateNightSurcharge
    });
  }


  fare =
    Math.max(
      fare,
      rate.minimumFare
    );


  const gratuity =
    fare *
    (
      pricing
        .gratuityPercent /
      100
    );


  const total =
    fare + gratuity;


  return {

    vehicle:
      rate.label,

    vehicleKey:
      body.vehicle,

    miles:
      money(
        route.miles
      ),

    minutes:
      Math.round(
        route.minutes
      ),

    baseTotal:
      money(fare),

    gratuity:
      money(gratuity),

    total:
      money(total),

    currency:
      pricing.currency,

    surcharges
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
      new Date()
        .toISOString(),

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

      passengers:
        Number(
          body.passengers ||
          1
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
        )
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

function requireAdmin(
  req,
  res,
  next
) {

  const configured =
    process.env.ADMIN_TOKEN;

  if (!configured) {

    return res
      .status(503)
      .json({
        error:
          "ADMIN_TOKEN is not configured."
      });
  }


  const auth =
    req.get(
      "authorization"
    ) || "";


  const supplied =
    auth.startsWith(
      "Bearer "
    )
      ? auth.slice(7)
      : "";


  if (
    supplied !==
    configured
  ) {

    return res
      .status(401)
      .json({
        error:
          "Unauthorized"
      });
  }


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


    if (
      event.type ===
      "checkout.session.completed"
    ) {

      const session =
        event.data.object;


      const bookingId =
        session.metadata &&
        session.metadata
          .bookingId;


      if (bookingId) {

        const bookings =
          readBookings();


        const booking =
          bookings.find(
            (item) =>
              item.id ===
              bookingId
          );


        if (booking) {

          booking
            .paymentStatus =
            "paid";

          booking.status =
            "confirmed";

          booking
            .stripeSessionId =
            session.id;

          booking.paidAt =
            new Date()
              .toISOString();


          writeBookings(
            bookings
          );
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


/* =========================================
   PUBLIC CONFIG
========================================= */

app.get(
  "/api/public-config",
  (req, res) => {

    res.json({

      companyPhone:
        process.env
          .COMPANY_PHONE ||
        "(973) 555-0100",

      companyEmail:
        process.env
          .COMPANY_EMAIL ||
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
              value.maxPassengers
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
              "Google Maps API key is not configured.",
            suggestions: []
          });
      }


      const response =
        await fetch(
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


      if (!response.ok) {

        const detail =
          await response.text();

        console.error(
          "Google Places autocomplete error:",
          response.status,
          detail
        );


        return res
          .status(502)
          .json({
            error:
              "Address search is temporarily unavailable.",
            suggestions: []
          });
      }


      const data =
        await response.json();


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

      console.error(
        "Address autocomplete error:",
        error
      );


      return res
        .status(500)
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

app.post(
  "/api/checkout",

  async (req, res) => {

    try {

      if (!stripe) {

        return res
          .status(503)
          .json({
            error:
              "Stripe is not configured. Add STRIPE_SECRET_KEY before accepting payments."
          });
      }


      const quote =
        await calculateQuote(
          req.body
        );


      const booking =
        createBookingRecord(
          req.body,
          quote
        );


      const bookings =
        readBookings();


      bookings.unshift(
        booking
      );


      writeBookings(
        bookings
      );


      const session =
        await stripe
          .checkout
          .sessions
          .create({

            mode:
              "payment",

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
                    Math.round(
                      quote.total *
                      100
                    ),

                  product_data: {

                    name:
                      `ER Limousine Service — ${quote.vehicle}`,

                    description:
                      `${booking.trip.pickup} → ${booking.trip.dropoff} | ${booking.trip.date} ${booking.trip.time}`
                  }
                }
              }
            ],


            metadata: {
              bookingId:
                booking.id
            },


            success_url:
              `${SITE_URL}/success.html?booking=${booking.id}&session_id={CHECKOUT_SESSION_ID}`,


            cancel_url:
              `${SITE_URL}/?cancelled=1`
          });


      booking
        .stripeSessionId =
        session.id;


      writeBookings(
        bookings
      );


      res.json({

        url:
          session.url,

        bookingId:
          booking.id
      });


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
        !allowedStatuses
          .includes(
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


    if (
      req.body.dispatch
    ) {

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
        booking
          .paymentStatus,

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
