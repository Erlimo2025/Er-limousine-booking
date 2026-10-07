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
  const trip=b.trip;
  const location=value=>String(value || '').replace(/\b(Terminal\s+([ABC]|[1-9][0-9]?))(?:\s*,\s*Terminal\s+\2(?=\s*(?:,|$)))+/gi,'$1');
  const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value || '')?new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z')):'Date unavailable';
  const time=value=>{const parts=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(value || '');return parts?`${Number(parts[1])%12 || 12}:${parts[2]} ${Number(parts[1])>=12?'PM':'AM'}`:'Time unavailable';};
  const badge=(text,tone)=>`<span class="badge dispatch-badge ${tone}">${esc(text)}</span>`;
  const statusLabels={awaiting_payment:'Awaiting Payment',confirmed:'Confirmed',assigned:'Assigned',driver_en_route:'Driver En Route',passenger_on_board:'Passenger On Board',completed:'Completed',cancelled:'Cancelled'};
  const cancelled=b.status==='cancelled',completed=b.status==='completed';
  const review=b.paymentReviewRequired===true || b.checkoutAttempt?.state==='review_required';
  const processing=b.paymentVerificationPending===true || b.checkoutAttempt?.state==='submitted_unknown';
  const paid=b.paymentStatus==='paid';
  const paymentLabel=paid?'Paid':review?'Payment Review':processing?'Payment Processing':b.paymentStatus==='unpaid'?'Unpaid':b.paymentStatus==='failed'?'Payment Failed':'Payment Status Unavailable';
  const refundLabels={processing:'Refund Processing',confirmed:'Refund Confirmed',review_required:'Refund Review',failed:'Refund Failed · Review'};
  const airports=[['Pickup',trip.pickupAirport],['Drop-off',trip.dropoffAirport]].filter(([,a])=>a && ['EWR','JFK','LGA'].includes(a.code)).map(([side,a])=>`<span class="dispatch-airport"><small>${side}</small> ${esc(a.code)}${/^Terminal (?:[ABC]|[1-9][0-9]?)$/.test(a.terminal || '')?' • '+esc(a.terminal.toUpperCase()):''}</span>`).join('');
  const rawPhone=String(b.customer.phone || '').trim();
  const dialText=rawPhone.normalize('NFKC').replace(/[\u2010-\u2015\u2212]/g,'-');
  const phoneMatch=/[\x00-\x1f\x7f]/.test(rawPhone)?null:/^(\+?[0-9().\s-]+?)(?:\s*(?:x|ext\.?|#)\s*([0-9]{1,6}))?$/i.exec(dialText);
  const digits=phoneMatch?phoneMatch[1].replace(/\D/g,''):'',phoneSafe=digits.length>=7 && digits.length<=15;
  const phoneTarget=phoneSafe?'tel:'+(phoneMatch[1].startsWith('+') || digits.length===11 && digits.startsWith('1')?'+':digits.length===10?'+1':'')+digits+(phoneMatch[2]?';ext='+phoneMatch[2]:''):null;
  const usDigits=digits.length===11 && digits.startsWith('1')?digits.slice(1):digits;
  const phone=phoneSafe && /^\+?[0-9]{10,11}$/.test(phoneMatch[1].trim()) && usDigits.length===10?(digits.length===11?'+1 ':'')+'('+usDigits.slice(0,3)+') '+usDigits.slice(3,6)+'-'+usDigits.slice(6)+(phoneMatch[2]?' ext. '+phoneMatch[2]:''):rawPhone;
  const email=String(b.customer.email || '').trim(),emailSafe=email.length<=254 && /^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+\.[^\s<>@\x00-\x1f\x7f]+$/.test(email);
  const contact=(value,href,cls)=>href?`<a class="${cls}" href="${esc(href)}" aria-label="${cls==='dispatch-phone'?'Call':'Email'} ${esc(value)}">${cls==='dispatch-phone'?'Call ':''}${esc(value)}</a>`:`<span class="${cls}">${esc(value)}</span>`;
  const tripTypes={oneway:'One way',airport:'Airport transfer',roundtrip:'Round trip',hourly:'Hourly'};
  const notes=typeof trip.notes==='string'?trip.notes:'';
  return `
    <article class="booking-item dispatch-card${cancelled?' dispatch-card-cancelled':completed?' dispatch-card-completed':''}" data-id="${esc(b.id)}">
      <div class="dispatch-card-heading">
        <div class="dispatch-pickup-time"><span class="dispatch-label">PICKUP · NEW YORK TIME</span><time datetime="${esc(trip.date)}">${esc(date(trip.date))}</time><strong><time datetime="${esc(trip.time)}">${esc(time(trip.time))}</time></strong></div>
        <div class="dispatch-statuses" aria-label="Reservation and payment status">
          ${badge(statusLabels[b.status] || 'Status unavailable',cancelled?'badge-cancelled':completed?'badge-muted':'badge-reservation')}
          ${badge(paymentLabel,paid?'badge-paid':review || b.paymentStatus==='failed'?'badge-review':processing?'badge-processing':'badge-unpaid')}
          ${paid && review?badge('Payment Review','badge-review'):''}
          ${refundLabels[b.refundStatus]?badge(refundLabels[b.refundStatus],b.refundStatus==='confirmed'?'badge-paid':b.refundStatus==='processing'?'badge-processing':'badge-review'):''}
        </div>
      </div>
      ${cancelled?'<p class="dispatch-cancelled-notice">CANCELLED — DO NOT DISPATCH</p>':''}
      ${airports?`<div class="dispatch-airports">${airports}</div>`:''}
      <div class="dispatch-route"><div><span class="dispatch-label">Pickup</span><p>${esc(location(trip.pickup))}</p></div><span class="dispatch-route-arrow" aria-hidden="true">→</span><div><span class="dispatch-label">Destination</span><p>${esc(location(trip.dropoff))}</p></div></div>
      <div class="dispatch-contact"><h3>${esc(b.customer.firstName)} ${esc(b.customer.lastName)}</h3><div>${contact(phone,phoneTarget,'dispatch-phone')}${contact(email,emailSafe?'mailto:'+encodeURIComponent(email):null,'dispatch-email')}</div></div>
      <dl class="dispatch-facts"><div><dt>Vehicle</dt><dd>${esc(trip.vehicle==='suv'?'Luxury SUV / Suburban':b.quote.vehicle)}</dd></div><div><dt>Passengers</dt><dd>${esc(trip.passengers)}</dd></div><div><dt>Fare</dt><dd class="dispatch-fare">$${total}</dd></div><div><dt>Trip type</dt><dd>${esc(tripTypes[trip.tripType] || 'Other')}${trip.tripType==='hourly' && trip.hours?' · '+esc(trip.hours)+' hours':''}</dd></div></dl>
      ${trip.tripType==='roundtrip' && trip.returnDate && trip.returnTime?`<p class="dispatch-secondary"><span class="dispatch-label">Return · New York time</span> ${esc(date(trip.returnDate))} · ${esc(time(trip.returnTime))}</p>`:''}
      ${trip.flightNumber || trip.airline?`<p class="dispatch-flight">${trip.flightNumber?'<span class="dispatch-label">Flight</span> '+esc(trip.flightNumber):''}${trip.airline?' <span class="dispatch-label">Airline</span> '+esc(trip.airline):''}</p>`:''}
      ${notes?`<details class="dispatch-notes"><summary>Customer notes <span class="dispatch-note-preview">${esc(notes.slice(0,100))}${notes.length>100?'…':''}</span></summary><p>${esc(notes)}</p></details>`:''}
      <p class="dispatch-reference"><span class="dispatch-label">Reservation ID</span> ${esc(b.id)}</p>
      <details class="dispatch-editor"><summary>Manage Dispatch</summary>
      ${b.checkoutAttempt?.quote?.promotion?.code === "FIRST15" ? `
        <p class="dispatch-secondary"><strong>FIRST15 reconciliation:</strong> ${esc(({prepared:'Not submitted',submitted_unknown:'Provider response pending',session_identified:'Payment session identified',confirmed_paid:'Payment confirmed',confirmed_unpaid:'Unpaid confirmed',review_required:'Review required'})[b.checkoutAttempt.state] || 'Review required')}
        ${b.checkoutAttempt.state === "review_required" ? "— Provider verification required; eligibility remains protected." : ""}</p>
        <button class="btn btn-secondary reconcileBtn">Check FIRST15 payment state</button>` : ""}
      <div class="admin-controls">
        <label>Reservation status<select class="status">
          ${["awaiting_payment","confirmed","assigned","driver_en_route","passenger_on_board","completed","cancelled"]
            .map(s => `<option value="${s}" ${b.status === s ? "selected" : ""}>${statusLabels[s]}</option>`).join("")}
        </select></label>
        <label>Chauffeur<input class="driver" placeholder="Driver" value="${esc(d.driver)}"></label>
        <label>Chauffeur phone<input class="driverPhone" placeholder="Driver phone" value="${esc(d.driverPhone)}"></label>
        <label>Assigned vehicle<input class="vehicle" placeholder="Vehicle" value="${esc(d.vehicle)}"></label>
        <label>License plate<input class="plate" placeholder="Plate" value="${esc(d.plate)}"></label>
      </div>
      <div class="hero-actions">
        <button class="btn btn-secondary saveBtn">Save dispatch</button>
      </div>
      </details>
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
document.getElementById('clearFilters').addEventListener('click',()=>{
  filters.reset();document.getElementById('reservationSearch').value='';
  // Set dispatch defaults explicitly, even if the browser retains select state.
  for(const [key,value]of Object.entries({status:'active',payment:'all',timing:'upcoming',airport:'all',vehicle:'all'}))document.getElementById(filterIds[key]).value=value;
  loadBookings(false);
});
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
