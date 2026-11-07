const form = document.getElementById("bookingForm");
const quoteBtn = document.getElementById("quoteBtn");
const payBtn = document.getElementById("payBtn");
const payLaterBtn=document.getElementById("payLaterBtn");
const cancelPolicyPanel = document.getElementById("cancelPolicyPanel");
const cancelPolicyAccepted = document.getElementById("cancelPolicyAccepted");
cancelPolicyAccepted?.addEventListener("change", updatePaymentControls);
let reservationBusy=false;
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
  if(typeof pickupLocation!=='undefined' && pickupLocation)pickupLocation.cancel();
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
const summaryStep = document.getElementById("bookingSummaryStep");
let activeBookingStep = 1;
let quoteRequestGeneration = 0;
let quoteController = null;
let quotedFormKey = null;

const bookingContactMemory = (() => {
  const key = "er_booking_contact_v1";
  const optIn = document.getElementById("rememberBookingContact");
  const forget = document.getElementById("forgetBookingContact");
  const status = document.getElementById("rememberBookingStatus");
  const fields = [["firstName", 80], ["lastName", 80], ["email", 160], ["phone", 60]]
    .map(([id, limit]) => ({id, limit, input: document.getElementById(id)}));
  if (!optIn || !forget || !status || fields.some(({input}) => !input)) return null;

  const restored = new Map();
  let edited = false;
  let checkedByCustomer = false;
  let restoreAttempted = false;

  for (const {input} of fields) {
    const recordEdit = () => {
      edited = true;
      restored.delete(input);
    };
    input.addEventListener("input", recordEdit);
    input.addEventListener("change", recordEdit);
  }

  optIn.checked = false;
  optIn.addEventListener("change", event => {
    checkedByCustomer = event.isTrusted && optIn.checked;
    status.textContent = "";
  });
  const isOptedIn = () => checkedByCustomer && optIn.checked;

  forget.addEventListener("click", () => {
    edited = true;
    optIn.checked = false;
    checkedByCustomer = false;
    try {
      window.localStorage.removeItem(key);
    } catch (_) {
      status.textContent = "Your browser could not remove the saved details. Clear this site’s data to remove them.";
      return;
    }
    let cleared = false;
    for (const [input, value] of restored) {
      if (input.value !== value) continue;
      input.value = "";
      cleared = true;
    }
    if (cleared) resetQuote();
    restored.clear();
    forget.hidden = true;
    status.textContent = "Saved details removed from this browser.";
    optIn.focus();
  });

  const canRestore = () => activeBookingStep === 2 && !edited && fields.every(({input}) => input.value === "");

  async function restore() {
    if (restoreAttempted) return;
    restoreAttempted = true;
    let raw;
    try {
      raw = window.localStorage.getItem(key);
    } catch (_) {
      optIn.disabled = true;
      status.textContent = "This browser does not allow saving details. You can still continue booking.";
      return;
    }
    forget.hidden = raw === null;
    if (!raw || raw.length > 4096 || !canRestore()) return;
    try {
      const details = JSON.parse(raw);
      if (!details || typeof details !== "object" || Object.keys(details).length !== fields.length ||
          fields.some(({id, limit}) => !Object.hasOwn(details, id) || typeof details[id] !== "string" ||
            !details[id].trim() || details[id].length > limit || /[<>\x00-\x1f\x7f]/.test(details[id]))) return;
      const response = await fetch("/api/customer/booking-contact", {
        cache: "no-store", credentials: "same-origin", redirect: "error"
      });
      if (!response.ok || (await response.json())?.allowRememberedContact !== true ||
          !canRestore() || window.localStorage.getItem(key) !== raw) return;
      // Restore the full contact together, never mix saved details with a different contact.
      for (const {id, input} of fields) {
        input.value = details[id];
        restored.set(input, input.value);
      }
    } catch (_) {
      // An unreadable record or unavailable session check leaves manual entry available.
    }
  }

  function save(bookingData) {
    if (!isOptedIn()) return;
    try {
      const details = Object.fromEntries(fields.map(({id}) => [id, bookingData[id].trim()]));
      window.localStorage.setItem(key, JSON.stringify(details));
      forget.hidden = false;
      status.textContent = "";
    } catch (_) {
      status.textContent = "Your browser could not save these details on this device.";
    }
  }

  return {restore, isOptedIn, save};
})();

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
    priceLabel.textContent = "$150 FLAT RATE · TOLLS INCLUDED";
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
  if (reservationBusy) return;
  if (step === 3 && !hasCurrentQuote()) step = 2;
  activeBookingStep = step;
  bookingPanel.dataset.bookingStep = String(step);
  tripStep.hidden = step !== 1;
  customerStep.hidden = step !== 2;
  summaryStep.hidden = step !== 3;
  if(typeof BookingDateControls!=='undefined')BookingDateControls.refresh(form);
  document.getElementById("bookingBack").hidden = step === 1;
  document.getElementById("bookingStepLabel").textContent =
    `Step ${step} of 3 — ${["Trip Details", "Customer Information", "Trip Summary & Payment"][step - 1]}`;
  updatePaymentControls();
  if (focus) {
    bookingPanel.scrollIntoView({block: "start", behavior: "smooth"});
    document.getElementById(step === 3 ? "bookingSummaryHeading" : step === 2 ? "firstName" : "pickup").focus({preventScroll: true});
  }
}

function validateBookingStep(panel, step) {
  if (step === 1 && typeof pickupLocation !== 'undefined' && pickupLocation && !pickupLocation.validate()) {
    showBookingStep(1);
    return false;
  }
  for (const input of panel.querySelectorAll("input, select, textarea")) {
    if (input.disabled) continue;
    input.setCustomValidity(input.required && !input.value.trim() ? "Please complete this field." : "");
    if (!input.checkValidity()) {
      showBookingStep(step);
      input.reportValidity();
      return false;
    }
  }
  return true;
}

function continueBooking() {
  if (reservationBusy || !validateBookingStep(tripStep, 1)) return;
  // Leaving Trip Details accepts the address currently shown, not a later GPS result.
  if (typeof pickupLocation !== 'undefined' && pickupLocation) pickupLocation.cancel();
  showBookingStep(2, true);
  void bookingContactMemory?.restore();
}

document.getElementById("bookingContinue").addEventListener("click", continueBooking);
document.getElementById("bookingBack").addEventListener("click", () => {
  if (reservationBusy) return;
  const previous = activeBookingStep === 3 ? 2 : 1;
  resetQuote();
  clearNotice();
  showBookingStep(previous, true);
});
document.getElementById("bookingEditTrip").addEventListener("click", () => {
  if (reservationBusy) return;
  resetQuote();
  clearNotice();
  showBookingStep(1, true);
});
form.addEventListener("invalid", event => {
  showBookingStep(tripStep.contains(event.target) ? 1 : 2);
}, true);
form.addEventListener("keydown", event => {
  if (event.key === "Enter" && event.target.id !== "rememberBookingContact" && event.target.matches("input")) {
    event.preventDefault();
    if (activeBookingStep === 1) continueBooking();
    else if (activeBookingStep === 2) void requestQuote({currentTarget: quoteBtn});
  }
});

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

const pickupLocation=typeof createPickupLocation==='function'?createPickupLocation({
  input:pickup,button:document.getElementById('currentLocationBtn'),status:document.getElementById('pickupLocationStatus'),
  review:document.getElementById('pickupLocationReview'),proposed:document.getElementById('pickupLocationProposed'),
  confirmButton:document.getElementById('confirmPickupLocation'),editButton:document.getElementById('editPickupLocation'),
  beforeStart(){pickup._addressGeneration=(pickup._addressGeneration || 0)+1;clearTimeout(suggestionTimers.pickup);pickupSuggestions.innerHTML='';pickupLocation.clearOption();},
  onSelect(address){pickup._addressGeneration=(pickup._addressGeneration || 0)+1;pickup.value=address.description;delete pickup.dataset.placeId;if(address.placeId)pickup.dataset.placeId=address.placeId;syncPickupTerminal();pickupSuggestions.innerHTML='';pickupLocation.clearOption();resetQuote();}
}):null;
form.addEventListener('reset',()=>{if(pickupLocation)pickupLocation.cancel();});

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

  // The fixed-offer selector is disabled visually but still belongs to this form.
  data.vehicle = vehicle.value;

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
  if(bookAgainFlowReference)data.bookingFlow=bookAgainFlowReference;
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

function renderBookingPolicy(policy) {
  if (!cancelPolicyPanel || !cancelPolicyAccepted) return;
  const visible = typeof policy?.version === "string" && typeof policy.summary === "string" &&
    Array.isArray(policy.tiers) && policy.tiers.length > 0 && policy.tiers.every(tier => typeof tier?.text === "string");
  cancelPolicyPanel.hidden = !visible;
  cancelPolicyAccepted.checked = false;
  document.getElementById("cancelPolicySummary").textContent = visible ? policy.summary : "";
  const tiers = visible ? policy.tiers.map(tier => {
    const item = document.createElement("li");
    item.textContent = tier.text;
    return item;
  }) : [];
  document.getElementById("cancelPolicyTiers").replaceChildren(...tiers);
}

function hasPolicyConsent() {
  return cancelPolicyPanel?.hidden === false && cancelPolicyAccepted?.checked === true &&
    typeof currentQuote?.cancellationPolicy?.version === "string";
}

function resetQuote() {
  quoteRequestGeneration++;
  if (quoteController) quoteController.abort();
  quoteController = null;
  quotedFormKey = null;
  currentQuote = null;
  renderBookingPolicy(null);
  quoteArea.classList.remove("has-completed-quote");

  updatePaymentControls();
  quoteBtn.disabled = reservationBusy;
  // Keep the button text node in place when blur runs during a WebKit click.
  const continueLabel = "CONTINUE TO TRIP SUMMARY →";
  if (quoteBtn.textContent !== continueLabel) quoteBtn.textContent = continueLabel;

  sumMiles.textContent = "—";
  sumMinutes.textContent = "—";
  sumTotal.textContent = "—";
  sumMilesLabel.textContent = "Distance";
  sumMinutesLabel.textContent = "Estimated Drive Time";
  sumTotalLabel.textContent = "Total";
  if(typeof renderFareBreakdown==='function')renderFareBreakdown(null);

  sumVehicle.textContent =
    vehicle.value === "suv" ? "Luxury SUV" : vehicle.options[
      vehicle.selectedIndex
    ]?.textContent ||
    "Luxury SUV";

  if (promoSummary) {
    promoSummary.hidden = true;
  }
  if (activeBookingStep === 3 && !reservationBusy) {
    showBookingStep(2);
    showNotice("Your booking details changed. Continue to Trip Summary for an updated quote.");
  }
}

function tollQuoteUnavailable(data) {
  return data?.checkoutAllowed===false || data?.tollStatus==='review_required' ||
    !!data?.tolls && !['none','estimated','waived','included'].includes(data.tolls.status);
}
function hasCurrentQuote() {
  return !!currentQuote && !tollQuoteUnavailable(currentQuote) && quotedFormKey === JSON.stringify(getFormData());
}

function updatePaymentControls() {
  const disabled = reservationBusy || activeBookingStep !== 3 || !hasCurrentQuote() || !hasPolicyConsent();
  quoteBtn.disabled = reservationBusy || !!quoteController;
  payBtn.disabled = disabled;
  if (payLaterBtn) payLaterBtn.disabled = disabled;
  document.getElementById("bookingBack").disabled = reservationBusy;
  document.getElementById("bookingEditTrip").disabled = reservationBusy;
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
  if (reservationBusy) return;
  if(typeof pickupLocation!=='undefined' && pickupLocation)pickupLocation.cancel();

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
  if (reservationBusy) return;
  if(typeof pickupLocation!=='undefined' && pickupLocation)pickupLocation.cancel();

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

  if(input===pickup && typeof pickupLocation!=='undefined' && pickupLocation)pickupLocation.addOption(container);

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

          input._addressGeneration=(input._addressGeneration || 0)+1;
          if(input===pickup && typeof pickupLocation!=='undefined' && pickupLocation)pickupLocation.cancel();

          input.value =
            description;
          input.dataset.placeId = typeof item === "object" ? item.placeId || "" : "";
          if (input === pickup) syncPickupTerminal();
          if (input === dropoff) syncDropoffTerminal();

          container.innerHTML =
            "";

          if(input===pickup && typeof pickupLocation!=='undefined' && pickupLocation)pickupLocation.clearOption();

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

      const generation=input._addressGeneration=(input._addressGeneration || 0)+1;
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

        if(input===pickup && typeof pickupLocation!=='undefined' && pickupLocation)renderSuggestions(container,input,[]);

        return;
      }

      suggestionTimers[key] =
        setTimeout(
          async () => {

            const results =
              await findAddresses(
                query
              );

            if(generation!==input._addressGeneration || input.value.trim()!==typedQuery || input._addressFocused===false)return;

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
      input._addressFocused=false;

      setTimeout(
        () => {
          if(input._addressFocused)return;

          container.innerHTML =
            "";
          if(input===pickup && typeof pickupLocation!=='undefined' && pickupLocation)pickupLocation.clearOption();
        },
        150
      );
    }
  );
  input.addEventListener('focus',()=>{
    input._addressFocused=true;
    if(input===pickup && typeof pickupLocation!=='undefined' && pickupLocation)renderSuggestions(container,input,[]);
  });
}


/* =========================================
   QUOTE
========================================= */

function renderFareBreakdown(data, review = false) {
  const container=document.getElementById('fareBreakdown');
  if(!container)return;
  const policyNotice=document.getElementById('tollPolicyNotice');
  if(policyNotice&&policyNotice!==container)policyNotice.textContent=data?.pricingBreakdown?'Tolls are estimated or included. No toll charges will be added to your accepted total.':'Your fare is calculated securely before payment.';
  container.replaceChildren();container.hidden=true;
  if(review||tollQuoteUnavailable(data)){container.textContent='Toll estimate unavailable — contact us for a final quote';container.hidden=false;return;}
  const p=data?.pricingBreakdown;
  const amount=value=>formatMoney(value/100,data.currency);
  const row=(label,value)=>{const item=document.createElement('div'),name=document.createElement('span'),price=document.createElement('strong');item.className='fare-breakdown-row';name.textContent=label;price.textContent=value;item.append(name,price);container.append(item);};
  if(!p || p.version!==1){
    if(!data)return;
    // Legacy/flag-off and hourly quotes have no separate toll snapshot. Display
    // their server total unchanged, without inventing a zero-dollar toll estimate.
    row('Trip Fare',formatMoney(data.total,data.currency));row('Tolls','Included');
    container.hidden=false;return;
  }
  const fare=Number.isSafeInteger(p.totalCents)?p.totalCents-(p.tollsCents||0):p.tripFareCents+p.surcharges.reduce((n,s)=>n+s.amountCents,0)-p.discountCents+p.gratuityCents;
  row('Trip Fare',amount(fare));
  row('Tolls',p.tollsIncluded?'Included':amount(p.tollsCents||0));
  container.hidden=false;
}

async function requestQuote(event) {
  if (reservationBusy || quoteController) return null;
  const goToSummary = event?.currentTarget === quoteBtn;
  const saveContact = goToSummary && bookingContactMemory?.isOptedIn();
  resetQuote();
  const generation = quoteRequestGeneration;
  clearNotice();

  quoteBtn.disabled = true;

  quoteBtn.textContent =
    "Calculating…";

  payBtn.disabled = true;

  currentQuote = null;

  try {

    if (!validateBookingStep(tripStep, 1) || !validateBookingStep(customerStep, 2)) {
      return null;
    }

    const bookingData =
      getFormData();

    const requestKey = JSON.stringify(bookingData);
    const controller = new AbortController();
    quoteController = controller;

    const response =
      await fetch(
        "/api/quote",
        {
          method: "POST",
          cache: "no-store",
          signal: controller.signal,

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

    if (generation !== quoteRequestGeneration) return null;
    if (requestKey !== JSON.stringify(getFormData())) {
      resetQuote();
      showNotice("Your booking details changed. Continue to Trip Summary for an updated quote.");
      return null;
    }

    if (!response.ok) {
      if(data.code==='TOLL_ESTIMATE_UNAVAILABLE'){
        sumMiles.textContent='—';sumMinutes.textContent='—';sumMilesLabel.textContent='Distance';sumMinutesLabel.textContent='Estimated Drive Time';
        sumTotal.textContent='Contact us';sumTotalLabel.textContent='Final quote required';
        if(typeof renderFareBreakdown==='function')renderFareBreakdown(null,true);
      }

      throw new Error(
        data.error ||
        "Unable to calculate quote."
      );
    }

    if(tollQuoteUnavailable(data)){
      sumTotal.textContent='Contact us';sumTotalLabel.textContent='Final quote required';
      renderFareBreakdown(null,true);
      throw new Error('Toll estimate unavailable — contact us for a final quote');
    }
    if (!Number.isFinite(data.total) || data.total <= 0) throw new Error("Unable to calculate quote. Please try again.");

    currentQuote =
      data;
    quotedFormKey = requestKey;
    renderBookingPolicy(data.cancellationPolicy);

    sumVehicle.textContent =
      data.vehicleKey === "suv" ? "Luxury SUV" : data.vehicle;

    if (
      data.miles === null ||
      data.miles === undefined
    ) {

      sumMiles.textContent = "As directed";

    } else {

      sumMiles.textContent =
        `${data.miles} mi`;
    }

    if (
      data.minutes === null ||
      data.minutes === undefined
    ) {

      sumMinutes.textContent = `${data.hours || hours.value} hours reserved`;

    } else {

      sumMinutes.textContent =
        `${data.minutes} min`;
    }

    sumTotal.textContent =
      formatMoney(
        data.total,
        data.currency
      );

    sumMilesLabel.textContent = data.roundTrip ? "Distance (round trip)" : "Distance";
    sumMinutesLabel.textContent = data.roundTrip ? "Estimated Drive Time (round trip)" : "Estimated Drive Time";
    sumTotalLabel.textContent = "Total";
    document.getElementById("sumPickup").textContent = bookingData.pickup;
    document.getElementById("sumDestination").textContent = bookingData.dropoff;
    document.getElementById("sumPickupTime").textContent = TripDateFormat.trip(bookingData.date,bookingData.time);
    document.getElementById("summaryReturnRow").hidden = bookingData.tripType !== "roundtrip";
    document.getElementById("sumReturnTime").textContent = bookingData.tripType === "roundtrip"
      ? TripDateFormat.trip(bookingData.returnDate,bookingData.returnTime) : "—";

    showPromoResult(data);
    if(typeof renderFareBreakdown==='function')renderFareBreakdown(data);
    if(promoSummary)promoSummary.hidden=true;
    quoteArea.classList.add("has-completed-quote");
    if (goToSummary) {
      if (saveContact) bookingContactMemory.save(bookingData);
      showBookingStep(3, true);
    }
    updatePaymentControls();

    if (data.fixedOffer) {

      showNotice(
        "$150 EWR → Manhattan Chevrolet Suburban Premier special applied. Tolls included.",
        "success"
      );

    } else if (
      data.promotion &&
      Number(data.discount) > 0
    ) {

      showNotice(
        `${data.promotion.code} applied. Your discount is included in Trip Fare.`,
        "success"
      );

    } else if (!goToSummary) {

      showNotice(
        "Quote ready. Review your trip before reserving.",
        "success"
      );
    }

    return data;

  } catch (error) {
    if (generation !== quoteRequestGeneration) return null;
    currentQuote = null;
    quotedFormKey = null;
    updatePaymentControls();

    if (promoSummary) {
      promoSummary.hidden = true;
    }

    showNotice(
      error.message ||
      "Unable to calculate quote."
    );

    return null;

  } finally {
    if (generation === quoteRequestGeneration) {
      quoteController = null;
      quoteBtn.disabled = false;
      quoteBtn.textContent = "CONTINUE TO TRIP SUMMARY →";
    }
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
    if (event.target === cancelPolicyAccepted || event.target.id === "rememberBookingContact") return;

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

    event.target.setCustomValidity?.("");
    resetQuote();
  }
);
form.addEventListener("change", event => {
  if (event.target !== cancelPolicyAccepted && event.target.id !== "rememberBookingContact") resetQuote();
});


/* =========================================
   STRIPE CHECKOUT
========================================= */

form.addEventListener(
  "submit",
  async (event) => {

    event.preventDefault();
    if(reservationBusy)return;
    const paymentChoice=event.submitter?.id==='payLaterBtn'?'later':'now';

    clearNotice();

    if (activeBookingStep !== 3 || !hasCurrentQuote()) {
      resetQuote();
      showBookingStep(activeBookingStep === 1 ? 1 : 2, true);
      showNotice("Continue to Trip Summary and review an updated quote before reserving.");
      return;
    }
    if (!hasPolicyConsent()) {
      showNotice("Review and accept the cancellation and refund policy before reserving.");
      if (!cancelPolicyPanel?.hidden) cancelPolicyAccepted?.focus();
      return;
    }
    if (!validateBookingStep(tripStep, 1) || !validateBookingStep(customerStep, 2)) return;
    reservationBusy=true;
    updatePaymentControls();
    const paymentQuote = currentQuote;

    payBtn.disabled =
      true;

    payBtn.textContent =
      paymentChoice==='later'?'Reserving your trip…':"Opening secure checkout…";
    if(payLaterBtn)payLaterBtn.disabled=true;

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
                {...bookingData,paymentChoice,
                  cancellationPolicyAcceptance:{version:paymentQuote.cancellationPolicy.version,accepted:true},
                  ...(paymentQuote.quoteRevision?{quoteRevision:paymentQuote.quoteRevision}:{})}
              )
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        if(response.status===409 && data.error==='Your quote changed. Please get a new quote before reserving.' ||
          response.status===400 && data.error==='Review and accept the current cancellation and refund policy before reserving.')resetQuote();
        if(data.code==='TOLL_ESTIMATE_UNAVAILABLE'){
          resetQuote();sumTotal.textContent='Contact us';sumTotalLabel.textContent='Final quote required';
          if(typeof renderFareBreakdown==='function')renderFareBreakdown(null,true);
        }

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

      payBtn.textContent =
        "RESERVE & PAY NOW";
      reservationBusy=false;
      if (!hasCurrentQuote()) showBookingStep(2, true);
      updatePaymentControls();
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
          if (reservationBusy) return;

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

let bookAgainGeneration=0,bookAgainFlowReference=null,bookAgainPendingSource=null;
function applyBookAgainTemplate(template,flowReference){
 if(typeof pickupLocation!=='undefined' && pickupLocation)pickupLocation.cancel();
 if(typeof flowReference!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-f0-9]{64}$/.test(flowReference))throw new Error('Template unavailable.');
 if(template?.offerCode!==undefined && template.offerCode!=='EWR_MANHATTAN_SUV')throw new Error('Template unavailable.');
 if(!template || !['oneway','airport','roundtrip','hourly'].includes(template.tripType) || !['suv','escalade'].includes(template.vehicle) ||
  typeof template.pickup!=='string' || !template.pickup.trim() || typeof template.dropoff!=='string' || !template.dropoff.trim() || !Number.isInteger(template.passengers) || template.passengers<1 || template.passengers>6 ||
  template.tripType==='hourly' && ![3,3.5,4,4.5,5,5.5,6,7,8].includes(template.hours))throw new Error('Template unavailable.');
 form.reset();bookAgainFlowReference=flowReference;clearSpecialOffer();selectTripType(template.tripType);
 pickup.value=template.pickup;dropoff.value=template.dropoff;
 delete pickup.dataset.placeId;delete dropoff.dataset.placeId;
 for(const [input,key] of [[pickup,'pickupPlaceId'],[dropoff,'dropoffPlaceId']])if(typeof template[key]==='string' && /^[A-Za-z0-9_-]{1,255}$/.test(template[key]))input.dataset.placeId=template[key];
 vehicle.disabled=false;vehicle.value=template.vehicle;resetPassengerOptions();passengers.value=String(template.passengers);
 if(template.tripType==='hourly')hours.value=String(template.hours);
 for(const input of [dateInput,timeInput,returnDate,returnTime])input.value='';
 dateInput.required=true;timeInput.required=true;
 // form.reset also clears customer details, old flight/notes and all payment intent.
 if(promoCode)promoCode.value='';if(offerCode)offerCode.value='';
 // Keep the existing selection without resetting Terminal A/B/C or destination.
 if(template.offerCode==='EWR_MANHATTAN_SUV'){
  offerCode.value=template.offerCode;vehicle.disabled=true;
  if(promoCode)promoCode.disabled=true;if(applyPromoBtn)applyPromoBtn.disabled=true;
  showSpecialPromoMessage();
 }
 syncPickupTerminal();syncDropoffTerminal();updateHourlyRates();resetQuote();showBookingStep(1);
 showNotice('Trip details copied. Choose a new pickup date and time, review your trip, then get a new quote.','success');
 if(typeof BookingDateControls!=='undefined')BookingDateControls.focus(dateInput);else dateInput.focus();
}
async function loadBookAgainTemplate(sourceOverride=null){
 const params=new URLSearchParams(window.location.search),source=sourceOverride || params.get('bookAgain');if(source===null)return;
 params.delete('bookAgain');const query=params.toString();window.history.replaceState(null,'',window.location.pathname+(query?'?'+query:'')+window.location.hash);
 const generation=++bookAgainGeneration;bookAgainPendingSource=source;resetQuote();quoteBtn.disabled=true;
 try{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(source))throw new Error('Template unavailable.');
  const response=await fetch('/api/customer/trips/'+encodeURIComponent(source)+'/book-again',{credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer'});
  if(generation!==bookAgainGeneration)return;
  if(response.status===401){bookAgainPendingSource=null;window.location.assign('/account.html');return;}
  if(!response.ok)throw new Error('Template unavailable.');
  const result=await response.json();if(generation!==bookAgainGeneration)return;applyBookAgainTemplate(result.template,result.flowReference);bookAgainPendingSource=null;
 }catch(_){if(generation===bookAgainGeneration){bookAgainPendingSource=null;showNotice('Unable to reuse this trip. Please enter your trip details to start a new booking.');}}
 finally{if(generation===bookAgainGeneration)quoteBtn.disabled=false;}
}
window.addEventListener('pagehide',()=>{bookAgainGeneration++;});
// Recover only an unfinished template read; never create a reservation on restore.
window.addEventListener('pageshow',event=>{
 if(event.persisted && (bookAgainPendingSource || !bookAgainFlowReference && new URLSearchParams(window.location.search).has('bookAgain')))void loadBookAgainTemplate(bookAgainPendingSource);
});

async function initialize() {
  // A public landing link selects the existing offer UI, never price authority.
  const ewrLandingEntry = window.location.hash === '#ewr-manhattan-special' &&
    !new URLSearchParams(window.location.search).has('bookAgain');

  configureDates();
  if(typeof BookingDateControls!=='undefined')BookingDateControls.mount(form);

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

  const initialBookingGeneration=bookAgainGeneration;
  await loadPublicConfig();
  if(initialBookingGeneration===bookAgainGeneration){
    await loadBookAgainTemplate();
    if(ewrLandingEntry && initialBookingGeneration===bookAgainGeneration && window.location.hash==='#ewr-manhattan-special'){
      activateEwrManhattanSpecial();
      window.history.replaceState(null,'',window.location.pathname+window.location.search+'#book');
      document.getElementById('book').scrollIntoView({block:'start'});
    }
  }

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

// Restore booking controls after browser Back; payment status is never inferred here.
window.addEventListener('pageshow',event=>{
 if(!event.persisted)return;
 reservationBusy=false;payBtn.textContent='RESERVE & PAY NOW';
 resetQuote();
 if(activeBookingStep===3)showBookingStep(2);
});
