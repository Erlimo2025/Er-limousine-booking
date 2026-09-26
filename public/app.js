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

let currentQuote = null;
let suggestionTimers = {};


/* =========================================
   FORM DATA
========================================= */

function getFormData() {
  return Object.fromEntries(
    new FormData(form).entries()
  );
}


/* =========================================
   NOTICES
========================================= */

function showNotice(message, type = "error") {
  notice.className = `notice ${type}`;
  notice.textContent = message;
}

function clearNotice() {
  notice.className = "notice";
  notice.textContent = "";
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
    vehicle.options[vehicle.selectedIndex]
      ?.textContent || "Black SUV";
}


/* =========================================
   TRIP TYPE
========================================= */

function selectTripType(type) {

  tripTypeInput.value = type;

  tripTabs.forEach((button) => {

    button.classList.toggle(
      "active",
      button.dataset.tripType === type
    );

  });


  /*
    Reset trip-specific fields first.
  */

  dropoffField.classList.remove("hidden-field");
  dropoff.required = true;

  returnFields.classList.add("hidden-field");
  returnDate.required = false;
  returnTime.required = false;

  hourlyField.classList.add("hidden-field");

  flightField.classList.add("hidden-field");

  vehicle.disabled = false;


  /* ROUND TRIP */

  if (type === "roundtrip") {

    returnFields.classList.remove("hidden-field");

    returnDate.required = true;
    returnTime.required = true;

  }


  /* AIRPORT */

  if (type === "airport") {

    flightField.classList.remove("hidden-field");

  }


  /* HOURLY */

  if (type === "hourly") {

    hourlyField.classList.remove("hidden-field");

    /*
      Hourly service is Black SUV only.
    */

    vehicle.value = "suv";
    vehicle.disabled = true;

  }


  resetPassengerOptions();
  resetQuote();
}


tripTabs.forEach((button) => {

  button.addEventListener("click", () => {

    selectTripType(
      button.dataset.tripType
    );

  });

});


/* =========================================
   PASSENGER LIMITS
========================================= */

function resetPassengerOptions() {

  const tripType = tripTypeInput.value;

  let maximum =
    vehicle.value === "sedan" ? 3 : 6;


  /*
    Hourly bookings always use SUV.
  */

  if (tripType === "hourly") {
    maximum = 6;
  }


  Array.from(passengers.options)
    .forEach((option) => {

      const number = Number(option.value);

      option.hidden = number > maximum;
      option.disabled = number > maximum;

    });


  if (Number(passengers.value) > maximum) {
    passengers.value = String(maximum);
  }

}


vehicle.addEventListener(
  "change",
  resetPassengerOptions
);


/* =========================================
   DATE RULES
========================================= */

function localDateString() {

  const now = new Date();

  now.setMinutes(
    now.getMinutes() -
    now.getTimezoneOffset()
  );

  return now
    .toISOString()
    .slice(0, 10);

}


function configureDates() {

  const today = localDateString();

  dateInput.min = today;
  returnDate.min = today;


  dateInput.addEventListener(
    "change",
    () => {

      returnDate.min =
        dateInput.value || today;

      if (
        returnDate.value &&
        returnDate.value < returnDate.min
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

async function findAddresses(query) {

  if (query.trim().length < 3) {
    return [];
  }


  try {

    const response = await fetch(
      `/api/address-suggestions?q=${encodeURIComponent(query)}`
    );


    if (!response.ok) {
      return [];
    }


    const data = await response.json();


    return Array.isArray(data.suggestions)
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


  suggestions.forEach((item) => {

    const suggestion =
      document.createElement("div");

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

        container.innerHTML = "";

        resetQuote();

      }
    );


    container.appendChild(
      suggestion
    );

  });

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

        container.innerHTML = "";
        return;

      }


      suggestionTimers[key] =
        setTimeout(
          async () => {

            const results =
              await findAddresses(query);


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

          container.innerHTML = "";

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

    /*
      A disabled select does not appear
      in FormData.

      Hourly service locks the vehicle
      to Black SUV, so temporarily enable
      it while reading the form.
    */

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


    currentQuote = data;


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
      new Intl.NumberFormat(
        "en-US",
        {
          style: "currency",

          currency:
            String(
              data.currency || "usd"
            ).toUpperCase()
        }
      ).format(data.total);


    payBtn.disabled = false;


    showNotice(
      "Quote ready. Continue to secure payment.",
      "success"
    );


    return data;


  } catch (error) {

    showNotice(
      error.message ||
      "Unable to calculate quote."
    );

    return null;


  } finally {

    quoteBtn.disabled = false;

    quoteBtn.textContent =
      "Get Quote";

  }

}


quoteBtn.addEventListener(
  "click",
  requestQuote
);


/* =========================================
   RESET QUOTE WHEN BOOKING CHANGES
========================================= */

form.addEventListener(
  "input",
  () => {

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


    payBtn.disabled = true;

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

      payBtn.disabled = false;

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
  .forEach((button) => {

    button.addEventListener(
      "click",
      () => {

        const selected =
          button.dataset.selectVehicle;


        /*
          Do not allow Sedan selection
          while Hourly service is active.
        */

        if (
          tripTypeInput.value === "hourly"
        ) {

          vehicle.value = "suv";

        } else {

          vehicle.value = selected;

        }


        resetPassengerOptions();
        resetQuote();

      }
    );

  });


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
      Contact information failing to load
      should not stop the booking form.
    */

  }

}


/* =========================================
   INITIALIZE WEBSITE
========================================= */

async function initialize() {

  configureDates();

  selectTripType("oneway");

  resetPassengerOptions();


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
