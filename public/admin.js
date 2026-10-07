const tokenInput = document.getElementById("token");
const loadBtn = document.getElementById("loadBtn");
const bookingsEl = document.getElementById("bookings");
const notice = document.getElementById("notice");

const loginField = document.getElementById("adminLoginField");
const logoutBtn = document.getElementById("logoutBtn");
let authenticated = false;
let authGeneration = 0;
let searchGeneration=0,nextCursor=null,activeQuery='';
const filters=document.getElementById('reservationFilters'),moreBtn=document.getElementById('moreBookings');
const filterIds={status:'filterStatus',payment:'filterPayment',timing:'filterTiming',airport:'filterAirport',vehicle:'filterVehicle'};

// Delete credentials left by the former implementation; never read/store them.
for (const store of ["localStorage", "sessionStorage"]) {
  try { window[store].removeItem("er_admin_token"); } catch (_) { /* Storage may be disabled. */ }
}
tokenInput.value = "";

function setLoggedIn(value) {
  authenticated = value;
  tokenInput.value = "";
  loginField.classList.toggle("hidden-field", value);
  logoutBtn.classList.toggle("hidden-field", !value);
  loadBtn.textContent = value ? "Load bookings" : "Admin login";
  filters.hidden=!value;
  if (!value) {
    authGeneration++;
    searchGeneration++;nextCursor=null;moreBtn.hidden=true;filters.reset();document.getElementById('activeFilters').textContent='';
    bookingsEl.innerHTML = "";
  }
}

async function adminFetch(url, options = {}) {
  const generation=authGeneration;
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: {"Content-Type": "application/json", ...options.headers}
  });
  const data = await response.json();
  if (!response.ok) {
    if (generation===authGeneration && (response.status === 401 || response.status === 403)) setLoggedIn(false);
    throw new Error(data.error || "Request failed. Please try again.");
  }
  return data;
}

function esc(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showNotice(message, type = "error") {
  notice.className = `notice ${type}`;
  notice.textContent = message;
}

function filterQuery(){
 const query=new URLSearchParams({search:document.getElementById('reservationSearch').value.trim(),limit:'25'});
 const labels=[];
 for(const [key,id]of Object.entries(filterIds)){const select=document.getElementById(id);query.set(key,select.value);labels.push(select.options[select.selectedIndex].textContent);}
 document.getElementById('activeFilters').textContent='Filters: '+labels.join(' · ')+(query.get('search')?' · Search: '+query.get('search'):'');return query.toString();
}
async function loadBookings(more=false) {
  if (!authenticated) return;
  const generation = authGeneration;
  const request=++searchGeneration;
  if(!more){activeQuery=filterQuery();nextCursor=null;bookingsEl.innerHTML='';moreBtn.hidden=true;}
  const query=activeQuery+(more&&nextCursor?'&cursor='+encodeURIComponent(nextCursor):'');
  moreBtn.disabled=true;document.getElementById('applyFilters').disabled=true;
  loadBtn.disabled = true;
  loadBtn.textContent = "Loading...";
  try {
    const data = await adminFetch('/api/bookings/search?'+query);
    if (!authenticated || generation !== authGeneration || request!==searchGeneration) return;
    notice.className = "notice";
    if(more)bookingsEl.insertAdjacentHTML('beforeend',data.bookings.map(renderBooking).join(''));
    else bookingsEl.innerHTML = data.bookings.length?data.bookings.map(renderBooking).join(''):'<div class="booking-item">No matching reservations.</div>';
    nextCursor=data.nextCursor;moreBtn.hidden=!nextCursor;
  } catch (err) {
    if(generation!==authGeneration || request!==searchGeneration)return;
    showNotice(err.message);
  } finally {
    if(generation===authGeneration && request===searchGeneration){moreBtn.disabled=false;document.getElementById('applyFilters').disabled=false;
    loadBtn.disabled = false;
    loadBtn.textContent = authenticated ? "Load bookings" : "Admin login";
    }
  }
}

async function loginAndLoad() {
  if (authenticated) return loadBookings();
  if (!tokenInput.value.trim()) return showNotice("Enter your admin credential.");
  loadBtn.disabled = true;
  // Credential exists only in the initial request; clear the password field immediately.
  const payload = JSON.stringify({token: tokenInput.value.trim()});
  tokenInput.value = "";
  try {
    await adminFetch("/api/admin/login", {method: "POST", body: payload});
    setLoggedIn(true);
    await loadBookings();
  } catch (err) {
    setLoggedIn(false);
    showNotice(err.message);
  } finally {
    loadBtn.disabled = false;
  }
}

async function restoreSession() {
  setLoggedIn(false);
  loadBtn.disabled = true;
  try {
    await adminFetch("/api/admin/session");
    setLoggedIn(true);
    await loadBookings();
  } catch (_) {
    setLoggedIn(false);
  } finally {
    loadBtn.disabled = false;
  }
}

async function logout() {
  loadBtn.disabled = true;
  logoutBtn.disabled = true;
  authGeneration++;
  bookingsEl.innerHTML = "";
  try {
    await adminFetch("/api/admin/logout", {method: "POST", body: "{}"});
    setLoggedIn(false);
    showNotice("Signed out.", "success");
  } catch (err) {
    showNotice(err.message);
  } finally {
    loadBtn.disabled = false;
    logoutBtn.disabled = false;
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
          ${b.paymentVerificationPending?'<span class="badge">Payment verification in progress</span>':''}
          ${b.refundStatus?`<span class="badge">Refund: ${esc(b.refundStatus)}</span>`:''}
          ${b.paymentReviewRequired ? '<span class="badge">Payment review required</span>' : ''}
        </div>
      </div>

      <p><strong>${esc(b.trip.date)} ${esc(b.trip.time)}</strong> — ${esc(b.quote.vehicle)} — $${total}</p>
      <p>${esc(b.trip.pickup)} → ${esc(b.trip.dropoff)}</p>
      <p class="dispatch-reference">Reference: ${esc(b.id)}${b.trip.flightNumber?' · Flight: '+esc(b.trip.flightNumber):''}</p>

      ${b.checkoutAttempt?.quote?.promotion?.code === "FIRST15" ? `
        <p><strong>FIRST15 reconciliation:</strong> ${esc(b.checkoutAttempt.state || "review_required")}
        ${b.checkoutAttempt.state === "review_required" ? "— Provider verification required; eligibility remains protected." : ""}</p>
        <button class="btn btn-secondary reconcileBtn">Check FIRST15 payment state</button>` : ""}
      <div class="admin-controls">
        <select class="status">
          ${["awaiting_payment","confirmed","assigned","driver_en_route","passenger_on_board","completed","cancelled"]
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
  if(event.target.classList.contains("reconcileBtn")) {
    event.target.disabled=true;
    try {
      const id=event.target.closest('.booking-item').dataset.id;
      await adminFetch('/api/bookings/'+encodeURIComponent(id)+'/reconcile',{method:'POST',body:'{}'});
      showNotice('Payment-state check completed. Unresolved cases require provider verification.','success');
      await loadBookings();
    } catch(err) {showNotice(err.message);} finally {event.target.disabled=false;}
    return;
  }
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
    const data = await adminFetch("/api/bookings/" + encodeURIComponent(id), {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    showNotice("Dispatch updated.", "success");
    await loadBookings();
  } catch (err) {
    showNotice(err.message);
  } finally {
    event.target.disabled = false;
    event.target.textContent = "Save dispatch";
  }
});

loadBtn.addEventListener("click", loginAndLoad);
filters.addEventListener('submit',event=>{event.preventDefault();loadBookings();});
document.getElementById('clearFilters').addEventListener('click',()=>{filters.reset();loadBookings();});
moreBtn.addEventListener('click',()=>{if(!moreBtn.disabled&&nextCursor)loadBookings(true);});
logoutBtn.addEventListener("click", logout);
window.addEventListener("pagehide", () => {
  tokenInput.value = "";
  authGeneration++;
  searchGeneration++;nextCursor=null;moreBtn.hidden=true;filters.reset();document.getElementById('activeFilters').textContent='';
  bookingsEl.innerHTML = "";
});
window.addEventListener("pageshow", event => { if (event.persisted) restoreSession(); });
restoreSession();
