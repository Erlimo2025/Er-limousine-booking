const form = document.getElementById("bookingForm");
const quoteBtn = document.getElementById("quoteBtn");
const payBtn = document.getElementById("payBtn");
const notice = document.getElementById("notice");

let currentQuote = null;

const sumVehicle = document.getElementById("sumVehicle");
const sumMiles = document.getElementById("sumMiles");
const sumMinutes = document.getElementById("sumMinutes");
const sumTotal = document.getElementById("sumTotal");

function formData() {
  return Object.fromEntries(new FormData(form).entries());
}

function showNotice(message, type = "error") {
  notice.className = `notice ${type}`;
  notice.textContent = message;
}

function clearNotice() {
  notice.className = "notice";
  notice.textContent = "";
}

async function requestQuote() {
  clearNotice();
  quoteBtn.disabled = true;
  quoteBtn.textContent = "Calculating…";
  payBtn.disabled = true;
  currentQuote = null;

  try {
    if (!form.reportValidity()) return null;

    const response = await fetch("/api/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData())
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to calculate quote.");

    currentQuote = data;
    sumVehicle.textContent = data.vehicle;
    sumMiles.textContent = `${data.miles} mi`;
    sumMinutes.textContent = `${data.minutes} min`;
    sumTotal.textContent = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: data.currency.toUpperCase()
    }).format(data.total);

    payBtn.disabled = false;
    showNotice("Quote ready. Continue to secure payment.", "success");
    return data;
  } catch (err) {
    showNotice(err.message);
    return null;
  } finally {
    quoteBtn.disabled = false;
    quoteBtn.textContent = "Calculate quote";
  }
}

quoteBtn.addEventListener("click", requestQuote);

form.addEventListener("input", () => {
  if (currentQuote) {
    currentQuote = null;
    payBtn.disabled = true;
    sumMiles.textContent = "—";
    sumMinutes.textContent = "—";
    sumTotal.textContent = "—";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearNotice();

  if (!currentQuote) {
    const quote = await requestQuote();
    if (!quote) return;
  }

  payBtn.disabled = true;
  payBtn.textContent = "Opening checkout…";

  try {
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData())
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to start checkout.");
    window.location.href = data.url;
  } catch (err) {
    showNotice(err.message);
    payBtn.disabled = false;
    payBtn.textContent = "Reserve & pay";
  }
});

(async function init() {
  const today = new Date();
  const local = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
  document.getElementById("date").min = local;

  try {
    const config = await fetch("/api/public-config").then((r) => r.json());
    document.getElementById("contactBlock").textContent =
      `${config.companyPhone} • ${config.companyEmail}`;
  } catch (_) {}

  const params = new URLSearchParams(location.search);
  if (params.get("cancelled")) {
    showNotice("Payment was cancelled. Your card was not charged.");
  }
})();
