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

  if (!pricing.vehicleRates[body.vehicle]) {
    throw new Error(
      "Unknown vehicle type."
    );
  }

  const passengers =
    Number(body.passengers || 1);

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

  if (passengers > maxPassengers) {
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
    process.env.GOOGLE_MAPS_API_KEY;

  if (!key) {
    throw new Error(
      "Google Maps API key is not configured."
    );
  }

  const response =
    await fetch(
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

          travelMode: "DRIVE",

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
      "Google Maps API key is not configured."
    );
  }

  const response =
    await fetch(
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

  if (!response.ok) {
    const detail =
      await response.text();

    throw new Error(
      `Address verification failed (${response.status}): ${detail.slice(0, 250)}`
    );
  }

  const data =
    await response.json();

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

async function calculateQuote(body) {
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

  /*
    Verify fixed offer before
    calculating normal pricing.
  */

  const fixedOffer =
    await verifyFixedOffer(body);

  if (fixedOffer) {
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


  /*
    PROMOTION
  */

  const promotion =
    getPromotion(body);

  let discount = 0;

  if (promotion) {
    discount =
      money(
        fare *
        (
          promotion.percentOff /
          100
        )
      );
  }

  const discountedFare =
    money(
      Math.max(
        0,
        fare - discount
      )
    );

  const gratuity =
    money(
      discountedFare *
      (
        pricing.gratuityPercent /
        100
      )
    );

  const originalTotal =
    money(
      fare +
      (
        fare *
        (
          pricing.gratuityPercent /
          100
        )
      )
    );

  const total =
    money(
      discountedFare +
      gratuity
    );

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
    req.get("authorization") ||
    "";

  const supplied =
    auth.startsWith("Bearer ")
      ? auth.slice(7)
      : "";

  if (supplied !== configured) {
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
        session.metadata.bookingId;

      if (bookingId) {
        const bookings =
          readBookings();

        const booking =
          bookings.find(
            (item) =>
              item.id === bookingId
          );

        if (booking) {
          booking.paymentStatus =
            "paid";

          booking.status =
            "confirmed";

          booking.stripeSessionId =
            session.id;

          booking.paidAt =
            new Date()
              .toISOString();

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
              value.maxLuggage
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

      /*
        IMPORTANT:
        The price is calculated again
        on the server.

        The browser cannot choose the
        Stripe payment amount.
      */

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


      let description =
        `${booking.trip.pickup} → ${booking.trip.dropoff} | ${booking.trip.date} ${booking.trip.time}`;

      if (quote.fixedOffer) {
        description =
          `${booking.trip.pickup} → ${booking.trip.dropoff} | EWR → Manhattan $150 Flat Rate`;
      } else if (quote.promotion) {
        description =
          `${booking.trip.pickup} → ${booking.trip.dropoff} | ${quote.promotion.code} applied`;
      }


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
                      quote.total * 100
                    ),

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
          });


      booking.stripeSessionId =
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
