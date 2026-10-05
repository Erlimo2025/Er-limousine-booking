const form = document.getElementById("bookingForm");
const quoteBtn = document.getElementById("quoteBtn");
const payBtn = document.getElementById("payBtn");
const notice = document.getElementById("notice");

const tripTypeInput = document.getElementById("tripType");
const tripTabs = document.querySelectorAll(".trip-tab");

const pickup = document.getElementById("pickup");
const pickupTerminalField = document.getElementById("pickupTerminalField");
const pickupTerminal = document.getElementById("pickupTerminal");
const ewrTerminalChoices = Object.freeze({
  general:{id:"ChIJ7wzsxeFSwokRhvLXxTe087M",text:"Newark Liberty International Airport (EWR)"},
  a:{id:"ChIJ2dQDPZNSwokRVJr9XE2SPt0",text:"Newark Liberty International Airport Terminal A"},
  b:{id:"ChIJ-6uTxfZSwokR-VfW-WSM53k",text:"Newark Liberty International Airport Terminal B"},
  c:{id:"ChIJMYEleJSwokRawcDBeH8NVg",text:"Newark Liberty International Airport Terminal C"}
});
function syncPickupTerminal() {
  const match=Object.entries(ewrTerminalChoices).find(([,entry])=>entry.id===pickup.dataset.placeId);
  pickupTerminalField.classList.toggle("hidden-field",!match);
  pickupTerminal.disabled=!match;
  pickupTerminal.value=match && match[0]!=="general" ? match[0] : "";
}
pickupTerminal.addEventListener("change",()=>{
  const selected=ewrTerminalChoices[pickupTerminal.value || "general"];
  if (!selected || pickupTerminal.disabled) return;
  pickup.dataset.placeId=selected.id;
  pickup.value=selected.text;
  resetQuote();
});
const dropoff = document.getElementById("dropoff");
const dropoffTerminalField = document.getElementById("dropoffTerminalField");
const dropoffTerminal = document.getElementById("dropoffTerminal");
function syncDropoffTerminal() {
  const match=Object.entries(ewrTerminalChoices).find(([,entry])=>entry.id===dropoff.dataset.placeId);
  dropoffTerminalField.classList.toggle("hidden-field",!match);
  dropoffTerminal.disabled=!match;
  dropoffTerminal.value=match && match[0]!=="general" ? match[0] : "";
}
dropoffTerminal.addEventListener("change",()=>{
  const selected=ewrTerminalChoices[dropoffTerminal.value || "general"];
  if (!selected || dropoffTerminal.disabled) return;
  dropoff.dataset.placeId=selected.id;
  dropoff.value=selected.text;
  resetQuote();
});
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

const mobileBooking = window.matchMedia("(max-width: 650px)");
const bookingPanel = document.getElementById("book");
const tripStep = document.getElementById("bookingTripStep");
const customerStep = document.getElementById("bookingCustomerStep");
const mobileSpecial = document.querySelector(".airport-special");
const headerActions = document.querySelector(".top-bar-actions");
const specialPosition = document.createComment("Original desktop special position");
const actionsPosition = document.createComment("Original desktop account links position");
mobileSpecial.before(specialPosition);
headerActions.before(actionsPosition);
const menuToggle = document.querySelector(".mobile-menu-toggle");
const navigation = document.querySelector(".nav");
const specialPrice = mobileSpecial.querySelector(".airport-special-price");
const desktopSpecialPrice = specialPrice.textContent;
const suburbanOption = vehicle.querySelector('option[value="suv"]');
const desktopSuburbanLabel = suburbanOption.textContent;
const mobileStats = Array.from(document.querySelectorAll("[data-mobile-stat]"), element => ({element, original: element.textContent}));

function arrangeMobileHomepage() {
  mobileStats.forEach(({element, original}) => {
    element.textContent = mobileBooking.matches ? element.dataset.mobileStat : original;
  });
  if (mobileBooking.matches) {
    suburbanOption.textContent = "Suburban Premier";
    const vehicleLabel = document.createElement("span");
    vehicleLabel.className = "special-vehicle-label";
    vehicleLabel.textContent = "LUXURY SUV";
    const priceLabel = document.createElement("span");
    priceLabel.className = "special-price-value";
    priceLabel.textContent = "$150 FLAT RATE";
    specialPrice.replaceChildren(vehicleLabel, priceLabel);
    bookingPanel.after(mobileSpecial);
    document.querySelector(".nav-inner").append(headerActions);
  } else {
    suburbanOption.textContent = desktopSuburbanLabel;
    specialPrice.textContent = desktopSpecialPrice;
    specialPosition.after(mobileSpecial);
    actionsPosition.after(headerActions);
  }
  navigation.classList.remove("mobile-menu-open");
  menuToggle.setAttribute("aria-expanded", "false");
}
arrangeMobileHomepage();
mobileBooking.addEventListener("change", arrangeMobileHomepage);
menuToggle.addEventListener("click", () => {
  const expanded = navigation.classList.toggle("mobile-menu-open");
  menuToggle.setAttribute("aria-expanded", String(expanded));
});
document.getElementById("mainNavigation").addEventListener("click", event => {
  if (event.target.closest("a")) {
    navigation.classList.remove("mobile-menu-open");
    menuToggle.setAttribute("aria-expanded", "false");
  }
});

function showBookingStep(step, focus = false) {
  bookingPanel.dataset.mobileStep = String(step);
  document.getElementById("bookingStepLabel").textContent = step === 2
    ? "Step 2 of 2 — Your Information"
    : "Step 1 of 2 — Trip Details";
  if (mobileBooking.matches && focus) {
    bookingPanel.scrollIntoView({block: "start", behavior: "smooth"});
    document.getElementById(step === 2 ? "firstName" : "pickup").focus({preventScroll: true});
  }
}

function continueBooking() {
  for (const input of tripStep.querySelectorAll("input, select")) {
    if (!input.disabled && !input.checkValidity()) {
      input.reportValidity();
      return;
    }
  }
  showBookingStep(2, true);
}

document.getElementById("bookingContinue").addEventListener("click", continueBooking);
document.getElementById("bookingBack").addEventListener("click", () => showBookingStep(1, true));
form.addEventListener("invalid", event => {
  if (mobileBooking.matches) showBookingStep(tripStep.contains(event.target) ? 1 : 2);
}, true);
form.addEventListener("keydown", event => {
  if (mobileBooking.matches && bookingPanel.dataset.mobileStep !== "2" && event.key === "Enter" && event.target.matches("input")) {
    event.preventDefault();
    continueBooking();
  }
});
mobileBooking.addEventListener("change", () => showBookingStep(1));

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
const sumMilesLabel = document.getElementById("sumMilesLabel");
const sumMinutesLabel = document.getElementById("sumMinutesLabel");
const sumTotalLabel = document.getElementById("sumTotalLabel");
const quoteArea = document.querySelector(".quote-area");

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
let hourlyVehicles = {};

function updateHourlyRates() {
  if (tripTypeInput.value !== "hourly") return;
  const rate = hourlyVehicles[vehicle.value]?.hourlyRate;
  if (!Number.isFinite(rate)) return;
  const label = vehicle.value === "suv" ? desktopSuburbanLabel.trim() : vehicle.options[vehicle.selectedIndex].textContent.trim();
  document.getElementById("hourlyRateInfo").textContent = `${label} • $${rate}/hour • 3-hour minimum`;
  Array.from(hours.options).forEach(option => {
    option.textContent = `${option.value} Hours — ${formatMoney(Number(option.value) * rate, "usd")}`;
  });
}

hours.addEventListener("change", resetQuote);


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

  if (pickup.dataset.placeId) data.pickupPlaceId = pickup.dataset.placeId;
  if (!pickupTerminal.disabled) data.pickupTerminal = pickupTerminal.value || "general";
  if (data.tripType !== "hourly" && !dropoffTerminal.disabled) {
    data.dropoffPlaceId = dropoff.dataset.placeId;
    data.dropoffTerminal = dropoffTerminal.value || "general";
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
  quoteArea.classList.remove("has-completed-quote");

  payBtn.disabled = true;

  sumMiles.textContent = "—";
  sumMinutes.textContent = "—";
  sumTotal.textContent = "—";
  sumMilesLabel.textContent = "Distance";
  sumMinutesLabel.textContent = "Estimated Drive Time";
  sumTotalLabel.textContent = "Total";

  sumVehicle.textContent =
    vehicle.value === "suv" ? "Luxury SUV" : vehicle.options[
      vehicle.selectedIndex
    ]?.textContent ||
    "Luxury SUV";

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

  showBookingStep(1);

  selectTripType("airport");

  if (offerCode) {
    offerCode.value =
      "EWR_MANHATTAN_SUV";
  }

  pickup.value =
    "Newark Liberty International Airport (EWR), 3 Brewster Rd, Newark, NJ 07114";

  pickup.dataset.placeId = ewrTerminalChoices.general.id;
  syncPickupTerminal();
  dropoff.value = "";
  delete dropoff.dataset.placeId;
  syncDropoffTerminal();

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
    "EWR → Manhattan $150 Chevrolet Suburban Premier special selected. Enter your Manhattan destination.",
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

  showBookingStep(1);

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

    updateHourlyRates();
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

  let maximum = 6;

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

    updateHourlyRates();
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
          input.dataset.placeId = typeof item === "object" ? item.placeId || "" : "";
          if (input === pickup) syncPickupTerminal();
          if (input === dropoff) syncDropoffTerminal();

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

      delete input.dataset.placeId;
      if (input === pickup) syncPickupTerminal();
      if (input === dropoff) syncDropoffTerminal();
      clearTimeout(
        suggestionTimers[key]
      );

      const typedQuery = input.value.trim();
      const query = specialOfferActive() && /^(?:terminal\s+)?[abc]$/i.test(typedQuery)
        ? `Newark Liberty International Airport Terminal ${typedQuery.slice(-1).toUpperCase()}` : typedQuery;

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

async function requestQuote(event) {

  const showMobileSummary = event?.currentTarget === quoteBtn || quoteArea.classList.contains("has-completed-quote");
  quoteArea.classList.remove("has-completed-quote");

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
      data.vehicleKey === "suv" ? "Luxury SUV" : data.vehicle;

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
        data.hourlyRate
          ? `${data.hours} hours • $${data.hourlyRate}/hour`
          : `${hours.value} hours`;

    } else {

      sumMinutes.textContent =
        `${data.minutes} min`;
    }

    sumTotal.textContent =
      formatMoney(
        data.total,
        data.currency
      );

    // Reuse the same four summary cells; only Round Trip quote content changes.
    sumMilesLabel.textContent = data.roundTrip ? "Outbound fare" : "Distance";
    sumMinutesLabel.textContent = data.roundTrip ? "Return fare" : "Estimated Drive Time";
    sumTotalLabel.textContent = data.roundTrip ? "Round Trip total" : "Total";
    if (data.roundTrip) {
      sumMiles.textContent = formatMoney(data.roundTrip.outbound.fare, data.currency);
      sumMinutes.textContent = formatMoney(data.roundTrip.return.fare, data.currency);
    }

    showPromoResult(data);

    if (showMobileSummary) quoteArea.classList.add("has-completed-quote");

    payBtn.disabled =
      false;

    if (data.fixedOffer) {

      showNotice(
        "$150 EWR → Manhattan Chevrolet Suburban Premier special applied.",
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

          vehicle.disabled = false;
          vehicle.value = selected;
          updateHourlyRates();
          showBookingStep(1);

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

    hourlyVehicles = Object.fromEntries((config.vehicles || []).map(item => [item.key, item]));
    updateHourlyRates();

    const topPhone = document.getElementById("topPhone");
    const phoneNumber = String(config.companyPhone || "").trim();
    if (topPhone && phoneNumber) {
      document.getElementById("topPhoneNumber").textContent = phoneNumber;
      topPhone.href = `tel:${phoneNumber.replace(/[^+\d]/g, "")}`;
      topPhone.hidden = false;
      const callNote = document.getElementById("topCallNote");
      callNote.href = topPhone.href;
      callNote.hidden = false;
    }

    const contactBlock =
      document.getElementById(
        "contactBlock"
      );

    if (contactBlock) {

      const phoneLink = document.createElement("a");
      phoneLink.textContent = config.companyPhone || "";
      phoneLink.href = `tel:${String(config.companyPhone || "").replace(/[^+\d]/g, "")}`;
      const emailLink = document.createElement("a");
      emailLink.textContent = config.companyEmail || "";
      emailLink.href = `mailto:${config.companyEmail || ""}`;
      contactBlock.replaceChildren(phoneLink, document.createTextNode(" • "), emailLink);
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
