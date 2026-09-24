const tokenInput = document.getElementById("token");
const loadBtn = document.getElementById("loadBtn");
const bookingsEl = document.getElementById("bookings");
const notice = document.getElementById("notice");

tokenInput.value = localStorage.getItem("er_admin_token") || "";

function esc(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${tokenInput.value.trim()}`
  };
}

function showNotice(message, type = "error") {
  notice.className = `notice ${type}`;
  notice.textContent = message;
}

async function loadBookings() {
  const token = tokenInput.value.trim();
  if (!token) return showNotice("Enter your admin token.");

  localStorage.setItem("er_admin_token", token);
  loadBtn.disabled = true;
  loadBtn.textContent = "Loading…";

  try {
    const response = await fetch("/api/bookings", { headers: authHeaders() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load bookings.");

    notice.className = "notice";
    bookingsEl.innerHTML = data.length
      ? data.map(renderBooking).join("")
      : `<div class="booking-item">No bookings yet.</div>`;
  } catch (err) {
    showNotice(err.message);
  } finally {
    loadBtn.disabled = false;
    loadBtn.textContent = "Load bookings";
  }
}

function renderBooking(b) {
  const total = Number(b.quote && b.quote.total || 0).toFixed(2);
  const d = b.dispatch || {};
  return `
    <article class="booking-item" data-id="${esc(b.id)}">
      <div class="booking-top">
        <div>
          <strong>${esc(b.customer.firstName)} ${esc(b.customer.lastName)}</strong>
          <div style="color:#b8b4ab">${esc(b.customer.phone)} • ${esc(b.customer.email)}</div>
        </div>
        <div>
          <span class="badge">${esc(b.status)}</span>
          <span class="badge">${esc(b.paymentStatus)}</span>
        </div>
      </div>

      <p><strong>${esc(b.trip.date)} ${esc(b.trip.time)}</strong> — ${esc(b.quote.vehicle)} — $${total}</p>
      <p>${esc(b.trip.pickup)} → ${esc(b.trip.dropoff)}</p>

      <div class="admin-controls">
        <select class="status">
          ${["confirmed","assigned","driver_en_route","passenger_on_board","completed","cancelled"]
            .map(s => `<option value="${s}" ${b.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
        <input class="driver" placeholder="Driver" value="${esc(d.driver)}">
        <input class="driverPhone" placeholder="Driver phone" value="${esc(d.driverPhone)}">
        <input class="vehicle" placeholder="Vehicle" value="${esc(d.vehicle)}">
        <input class="plate" placeholder="Plate" value="${esc(d.plate)}">
      </div>
      <div class="hero-actions">
        <button class="btn btn-secondary saveBtn">Save dispatch</button>
      </div>
    </article>
  `;
}

bookingsEl.addEventListener("click", async (event) => {
  if (!event.target.classList.contains("saveBtn")) return;

  const card = event.target.closest(".booking-item");
  const id = card.dataset.id;
  event.target.disabled = true;
  event.target.textContent = "Saving…";

  const payload = {
    status: card.querySelector(".status").value,
    dispatch: {
      driver: card.querySelector(".driver").value,
      driverPhone: card.querySelector(".driverPhone").value,
      vehicle: card.querySelector(".vehicle").value,
      plate: card.querySelector(".plate").value
    }
  };

  try {
    const response = await fetch("/api/bookings/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to save.");
    showNotice("Dispatch updated.", "success");
    await loadBookings();
  } catch (err) {
    showNotice(err.message);
  } finally {
    event.target.disabled = false;
    event.target.textContent = "Save dispatch";
  }
});

loadBtn.addEventListener("click", loadBookings);
