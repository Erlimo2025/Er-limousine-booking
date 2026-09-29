const form = document.getElementById("bookingForm");
const quoteBtn = document.getElementById("quoteBtn");
const payBtn = document.getElementById("payBtn");
const notice = document.getElementById("notice");

const tripTypeInput = document.getElementById("tripType");
const tripTabs = document.querySelectorAll(".trip-tab");

const pickup = document.getElementById("pickup");
const dropoff = document.getElementById("dropoff");
const dropoffField = document.getElementById("dropoffField");

const dateInput = document.getElementById("date");
const timeInput = document.getElementById("time");

const returnFields = document.getElementById("returnFields");
const returnDate = document.getElementById("returnDate");
const returnTime = document.getElementById("returnTime");

const hourlyField = document.getElementById("hourlyField");
const hours = document.getElementById("hours");

const vehicle = document.getElementById("vehicle");
const passengers = document.getElementById("passengers");

const flightField = document.getElementById("flightField");
const flightNumber = document.getElementById("flightNumber");

const pickupSuggestions =
  document.getElementById("pickupSuggestions");

const dropoffSuggestions =
  document.getElementById("dropoffSuggestions");

const sumVehicle = document.getElementById("sumVehicle");
const sumMiles = document.getElementById("sumMiles");
const sumMinutes = document.getElementById("sumMinutes");
const sumTotal = document.getElementById("sumTotal");

const promoCode = document.getElementById("promoCode");
const applyPromoBtn = document.getElementById("applyPromoBtn");
const promoMessage = document.getElementById("promoMessage");

const promoSummary = document.getElementById("promoSummary");
const promoSummaryLabel =
  document.getElementById("promoSummaryLabel");
const sumDiscount = document.getElementById("sumDiscount");

const offerCode = document.getElementById("offerCode");

const ewrManhattanSpecialBtn =
  document.getElementById("ewrManhattanSpecialBtn");

let currentQuote = null;
let suggestionTimers = {};


/* =========================================
   FORM DATA
========================================= */

function getFormData() {

  const data =
    Object.fromEntries(
      new FormData(form).entries()
    );

  if (data.promoCode) {
    data.promoCode =
      String(data.promoCode)
        .trim()
        .toUpperCase();
  }

  if (data.offerCode) {
    data.offerCode =
      String(data.offerCode)
        .trim()
        .toUpperCase();
  }

  return data;
}


/* =========================================
   MONEY
========================================= */

function formatMoney(
  amount,
  currency = "usd"
) {

  return new Intl.NumberFormat(
    "en-US",
    {
      style: "currency",
      currency:
        String(currency).toUpperCase()
    }
  ).format(
    Number(amount || 0)
  );
}


/* =========================================
   NOTICES
========================================= */

function showNotice(
  message,
  type = "error"
) {

  notice.className =
    `notice ${type}`;

  notice.textContent =
    message;
}


function clearNotice() {

  notice.className =
    "notice";

  notice.textContent =
    "";
}


/* =========================================
   PROMOTION DISPLAY
========================================= */

function resetPromoDisplay() {

  if (promoSummary) {
    promoSummary.hidden = true;
  }

  if (sumDiscount) {
    sumDiscount.textContent =
      "−$0.00";
  }

  if (promoSummaryLabel) {
    promoSummaryLabel.textContent =
      "FIRST15 — 15% Off";
  }

  if (promoMessage) {

    promoMessage.textContent =
      "First-time customer? Use code FIRST15 for 15% off.";

    promoMessage.className = "";
  }
}


function showSpecialPromoMessage() {

  if (promoSummary) {
    promoSummary.hidden = true;
  }

  if (promoMessage) {

    promoMessage.textContent =
      "Promo codes do not apply to the $150 EWR → Manhattan special.";

    promoMessage.className = "";
  }
}


function showPromoResult(data) {

  if (data.fixedOffer) {

    showSpecialPromoMessage();
    return;
  }

  if (
    data.promotion &&
    Number(data.discount) > 0
  ) {

    if (promoSummary) {
      promoSummary.hidden = false;
    }

    if (promoSummaryLabel) {

      promoSummaryLabel.textContent =
        data.promotion.label ||
        `${data.promotion.code || "Promo"} applied`;
    }

    if (sumDiscount) {

      sumDiscount.textContent =
        `−${formatMoney(
          data.discount,
          data.currency
        )}`;
    }

    if (promoMessage) {

      promoMessage.textContent =
        `${data.promotion.code || "Promo code"} applied successfully.`;

      promoMessage.className =
        "promo-success";
    }

    return;
  }

  if (promoSummary) {
    promoSummary.hidden = true;
  }

  if (
    promoCode &&
    promoCode.value.trim()
  ) {

    if (promoMessage) {

      promoMessage.textContent =
        "Enter FIRST15 and click Apply for 15% off your first ride.";

      promoMessage.className = "";
    }
  }
}


/* =========================================
   RESET QUOTE
========================================= */

function resetQuote() {

  currentQuote = null;

  payBtn.disabled = true;

  sumMiles.textContent = "—";
  sumMinutes.textContent = "—";
  sumTotal.textContent = "—";

  sumVehicle.textContent =
    vehicle.options[
      vehicle.selectedIndex
    ]?.textContent ||
    "Black SUV";

  if (promoSummary) {
    promoSummary.hidden = true;
  }
}


/* =========================================
   SPECIAL OFFER
========================================= */

function specialOfferActive() {

  return Boolean(
    offerCode &&
    offerCode.value ===
      "EWR_MANHATTAN_SUV"
  );
}


function clearSpecialOffer() {

  if (offerCode) {
    offerCode.value = "";
  }

  if (promoCode) {
    promoCode.disabled = false;
  }

  if (applyPromoBtn) {
    applyPromoBtn.disabled = false;
  }

  resetPromoDisplay();
}


function activateEwrManhattanSpecial() {

  selectTripType("airport");

  if (offerCode) {
    offerCode.value =
      "EWR_MANHATTAN_SUV";
  }

  pickup.value =
    "Newark Liberty International Airport (EWR), 3 Brewster Rd, Newark, NJ 07114";

  dropoff.value = "";

  vehicle.value = "suv";
  vehicle.disabled = true;

  resetPassengerOptions();
  resetQuote();

  if (promoCode) {

    promoCode.value = "";
    promoCode.disabled = true;
  }

  if (applyPromoBtn) {
    applyPromoBtn.disabled = true;
  }

  showSpecialPromoMessage();

  clearNotice();

  showNotice(
    "EWR → Manhattan $150 Black SUV special selected. Enter your Manhattan destination.",
    "success"
  );

  setTimeout(
    () => {
      dropoff.focus();
    },
    250
  );
}


if (ewrManhattanSpecialBtn) {

  ewrManhattanSpecialBtn.addEventListener(
    "click",
    () => {

      activateEwrManhattanSpecial();
    }
  );
}


/* =========================================
   TRIP TYPE
========================================= */

function selectTripType(type) {

  tripTypeInput.value = type;

  tripTabs.forEach(
    (button) => {

      button.classList.toggle(
        "active",
        button.dataset.tripType === type
      );
    }
  );

  dropoffField.classList.remove(
    "hidden-field"
  );

  dropoff.required = true;

  returnFields.classList.add(
    "hidden-field"
  );

  returnDate.required = false;
  returnTime.required = false;

  hourlyField.classList.add(
    "hidden-field"
  );

  flightField.classList.add(
    "hidden-field"
  );

  vehicle.disabled = false;

  if (type === "roundtrip") {

    returnFields.classList.remove(
      "hidden-field"
    );

    returnDate.required = true;
    returnTime.required = true;
  }

  if (type === "airport") {

    flightField.classList.remove(
      "hidden-field"
    );
  }

  if (type === "hourly") {

    hourlyField.classList.remove(
      "hidden-field"
    );

    vehicle.value = "suv";
    vehicle.disabled = true;
  }

  resetPassengerOptions();
  resetQuote();
}


tripTabs.forEach(
  (button) => {

    button.addEventListener(
      "click",
      () => {

        clearSpecialOffer();

        selectTripType(
          button.dataset.tripType
        );
      }
    );
  }
);


/* =========================================
   PASSENGER LIMITS
========================================= */

function resetPassengerOptions() {

  const tripType =
    tripTypeInput.value;

  let maximum =
    vehicle.value === "sedan"
      ? 3
      : 6;

  if (tripType === "hourly") {
    maximum = 6;
  }

  Array.from(
    passengers.options
  ).forEach(
    (option) => {

      const number =
        Number(option.value);

      option.hidden =
        number > maximum;

      option.disabled =
        number > maximum;
    }
  );

  if (
    Number(passengers.value) >
    maximum
  ) {

    passengers.value =
      String(maximum);
  }
}


vehicle.addEventListener(
  "change",
  () => {

    if (specialOfferActive()) {
      clearSpecialOffer();
    }

    resetPassengerOptions();
    resetQuote();
  }
);


/* =========================================
   DATE RULES
========================================= */

function localDateString() {

  const now =
    new Date();

  now.setMinutes(
    now.getMinutes() -
    now.getTimezoneOffset()
  );

  return now
    .toISOString()
    .slice(0, 10);
}


function configureDates() {

  const today =
    localDateString();

  dateInput.min =
    today;

  returnDate.min =
    today;

  dateInput.addEventListener(
    "change",
    () => {

      returnDate.min =
        dateInput.value ||
        today;

      if (
        returnDate.value &&
        returnDate.value <
          returnDate.min
      ) {

        returnDate.value =
          returnDate.min;
      }
    }
  );
}


/* =========================================
   ADDRESS AUTOCOMPLETE
========================================= */

async function findAddresses(
  query
) {

  if (
    query.trim().length < 3
  ) {
    return [];
  }

  try {

    const response =
      await fetch(
        `/api/address-suggestions?q=${encodeURIComponent(query)}`
      );

    if (!response.ok) {
      return [];
    }

    const data =
      await response.json();

    return Array.isArray(
      data.suggestions
    )
      ? data.suggestions
      : [];

  } catch (_) {

    return [];
  }
}


function renderSuggestions(
  container,
  input,
  suggestions
) {

  container.innerHTML = "";

  suggestions.forEach(
    (item) => {

      const suggestion =
        document.createElement(
          "div"
        );

      suggestion.className =
        "address-suggestion";

      const description =
        typeof item === "string"
          ? item
          : item.description;

      suggestion.textContent =
        description;

      suggestion.addEventListener(
        "mousedown",
        (event) => {

          event.preventDefault();

          input.value =
            description;

          container.innerHTML =
            "";

          resetQuote();
        }
      );

      container.appendChild(
        suggestion
      );
    }
  );
}


function enableAddressAutocomplete(
  input,
  container,
  key
) {

  if (!input || !container) {
    return;
  }

  input.addEventListener(
    "input",
    () => {

      clearTimeout(
        suggestionTimers[key]
      );

      const query =
        input.value.trim();

      if (query.length < 3) {

        container.innerHTML =
          "";

        return;
      }

      suggestionTimers[key] =
        setTimeout(
          async () => {

            const results =
              await findAddresses(
                query
              );

            renderSuggestions(
              container,
              input,
              results
            );
          },
          300
        );
    }
  );

  input.addEventListener(
    "blur",
    () => {

      setTimeout(
        () => {

          container.innerHTML =
            "";
        },
        150
      );
    }
  );
}


/* =========================================
   QUOTE
========================================= */

async function requestQuote() {

  clearNotice();

  quoteBtn.disabled = true;

  quoteBtn.textContent =
    "Calculating…";

  payBtn.disabled = true;

  currentQuote = null;

  try {

    const wasDisabled =
      vehicle.disabled;

    vehicle.disabled = false;

    const valid =
      form.reportValidity();

    if (!valid) {

      vehicle.disabled =
        wasDisabled;

      return null;
    }

    const bookingData =
      getFormData();

    vehicle.disabled =
      wasDisabled;

    const response =
      await fetch(
        "/api/quote",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(
              bookingData
            )
        }
      );

    const data =
      await response.json();

    if (!response.ok) {

      throw new Error(
        data.error ||
        "Unable to calculate quote."
      );
    }

    currentQuote =
      data;

    sumVehicle.textContent =
      data.vehicle;

    if (
      data.miles === null ||
      data.miles === undefined
    ) {

      sumMiles.textContent =
        "Hourly";

    } else {

      sumMiles.textContent =
        `${data.miles} mi`;
    }

    if (
      data.minutes === null ||
      data.minutes === undefined
    ) {

      sumMinutes.textContent =
        `${hours.value} hours`;

    } else {

      sumMinutes.textContent =
        `${data.minutes} min`;
    }

    sumTotal.textContent =
      formatMoney(
        data.total,
        data.currency
      );

    showPromoResult(data);

    payBtn.disabled =
      false;

    if (data.fixedOffer) {

      showNotice(
        "$150 EWR → Manhattan Black SUV special applied.",
        "success"
      );

    } else if (
      data.promotion &&
      Number(data.discount) > 0
    ) {

      showNotice(
        `${data.promotion.code} applied — you saved ${formatMoney(
          data.discount,
          data.currency
        )}.`,
        "success"
      );

    } else {

      showNotice(
        "Quote ready. Continue to secure payment.",
        "success"
      );
    }

    return data;

  } catch (error) {

    if (promoSummary) {
      promoSummary.hidden = true;
    }

    showNotice(
      error.message ||
      "Unable to calculate quote."
    );

    return null;

  } finally {

    quoteBtn.disabled =
      false;

    quoteBtn.textContent =
      "Get Quote";
  }
}


quoteBtn.addEventListener(
  "click",
  requestQuote
);


/* =========================================
   APPLY PROMO CODE
========================================= */

if (applyPromoBtn) {

  applyPromoBtn.addEventListener(
    "click",
    async () => {

      if (specialOfferActive()) {

        showSpecialPromoMessage();

        showNotice(
          "FIRST15 cannot be combined with the $150 EWR → Manhattan special."
        );

        return;
      }

      if (!promoCode) {
        return;
      }

      const code =
        promoCode.value
          .trim()
          .toUpperCase();

      promoCode.value =
        code;

      if (!code) {

        if (promoMessage) {

          promoMessage.textContent =
            "Enter a promo code first.";

          promoMessage.className =
            "promo-error";
        }

        return;
      }

      applyPromoBtn.disabled =
        true;

      applyPromoBtn.textContent =
        "Applying…";

      try {

        await requestQuote();

      } finally {

        applyPromoBtn.disabled =
          false;

        applyPromoBtn.textContent =
          "Apply";
      }
    }
  );
}


/* =========================================
   RESET QUOTE WHEN BOOKING CHANGES
========================================= */

form.addEventListener(
  "input",
  (event) => {

    if (
      event.target === promoCode
    ) {

      if (promoCode) {

        promoCode.value =
          promoCode.value
            .toUpperCase();
      }

      if (!specialOfferActive()) {
        resetPromoDisplay();
      }
    }

    if (currentQuote) {
      resetQuote();
    }
  }
);


/* =========================================
   STRIPE CHECKOUT
========================================= */

form.addEventListener(
  "submit",
  async (event) => {

    event.preventDefault();

    clearNotice();

    if (!currentQuote) {

      const quote =
        await requestQuote();

      if (!quote) {
        return;
      }
    }

    payBtn.disabled =
      true;

    payBtn.textContent =
      "Opening secure checkout…";

    try {

      const wasDisabled =
        vehicle.disabled;

      vehicle.disabled = false;

      const bookingData =
        getFormData();

      vehicle.disabled =
        wasDisabled;

      const response =
        await fetch(
          "/api/checkout",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify(
                bookingData
              )
          }
        );

      const data =
        await response.json();

      if (!response.ok) {

        throw new Error(
          data.error ||
          "Unable to start checkout."
        );
      }

      if (!data.url) {

        throw new Error(
          "Secure checkout link was not returned."
        );
      }

      window.location.href =
        data.url;

    } catch (error) {

      showNotice(
        error.message ||
        "Unable to start checkout."
      );

      payBtn.disabled =
        false;

      payBtn.textContent =
        "Reserve & Pay";
    }
  }
);


/* =========================================
   FLEET BOOK BUTTONS
========================================= */

document
  .querySelectorAll(
    "[data-select-vehicle]"
  )
  .forEach(
    (button) => {

      button.addEventListener(
        "click",
        () => {

          clearSpecialOffer();

          const selected =
            button.dataset
              .selectVehicle;

          if (
            tripTypeInput.value ===
            "hourly"
          ) {

            vehicle.value =
              "suv";

          } else {

            vehicle.disabled =
              false;

            vehicle.value =
              selected;
          }

          resetPassengerOptions();
          resetQuote();
        }
      );
    }
  );


/* =========================================
   PUBLIC CONTACT INFO
========================================= */

async function loadPublicConfig() {

  try {

    const response =
      await fetch(
        "/api/public-config"
      );

    if (!response.ok) {
      return;
    }

    const config =
      await response.json();

    const contactBlock =
      document.getElementById(
        "contactBlock"
      );

    if (contactBlock) {

      contactBlock.textContent =
        `${config.companyPhone || ""} • ${config.companyEmail || ""}`;
    }

  } catch (_) {

    /*
      Contact information failing
      should not stop booking.
    */
  }
}


/* =========================================
   INITIALIZE WEBSITE
========================================= */

async function initialize() {

  configureDates();

  selectTripType(
    "oneway"
  );

  resetPassengerOptions();

  resetPromoDisplay();

  enableAddressAutocomplete(
    pickup,
    pickupSuggestions,
    "pickup"
  );

  enableAddressAutocomplete(
    dropoff,
    dropoffSuggestions,
    "dropoff"
  );

  await loadPublicConfig();

  const params =
    new URLSearchParams(
      window.location.search
    );

  if (
    params.get("cancelled")
  ) {

    showNotice(
      "Payment was cancelled. Your card was not charged."
    );
  }
}


initialize();
