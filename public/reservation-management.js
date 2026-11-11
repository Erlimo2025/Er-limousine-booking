(() => {
  'use strict';

  const base = '/api/booking/manage';
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const el = id => document.getElementById(id);
  const access = el('manageAccess'), verify = el('manageVerify'), content = el('manageContent');
  const status = el('manageStatus'), details = el('manageDetails'), requests = el('manageRequests');
  const requestForm = el('manageRequestForm'), pay = el('managePay'), signOut = el('manageSignOut');
  const stopEditor = globalThis.BookingStops?.createEditor(el('manageStopEditor'),'request-stop');
  let editingStops = false;

  const bookingLabels = {
    awaiting_payment: 'Awaiting payment', confirmed: 'Confirmed', assigned: 'Chauffeur assigned',
    driver_en_route: 'Chauffeur en route', passenger_on_board: 'In progress', completed: 'Completed', cancelled: 'Cancelled'
  };
  const requestLabels = {
    pickup_schedule: 'Pickup date or time change', locations: 'Pickup or destination change', cancellation: 'Cancellation',
    amendment: 'Reservation change'
  };
  const decisionLabels = {pending: 'Pending review', approved: 'Approved', declined: 'Declined'};
  const payLabels = {paid: 'Paid', unpaid: 'Unpaid', failed: 'Payment failed'};
  const refundLabels = {processing: 'Refund processing', confirmed: 'Refund confirmed', review_required: 'Refund review required', failed: 'Refund review required'};
  let generation = 0, busy = false, reservation = null, retry = null;
  let token = null;
  const reference = new URLSearchParams(location.search).get('reservation');
  let accountReference = uuid.test(reference) ? reference.toLowerCase() : null;
  const endpoint = () => accountReference ? base + '/account/' + accountReference : base + '/guest';

  function node(tag, value) {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = String(value);
    return element;
  }

  async function api(path, body) {
    const options = {credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error'};
    if (body !== undefined) {
      options.method = 'POST';
      options.headers = {'Content-Type': 'application/json'};
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Request unavailable.'), {status: response.status});
    return data;
  }

  const managedActions = window.erReservationSelfService.create({api, endpoint, act, reload: load, status});

  function requestDescription(request) {
    if (request.kind === 'pickup_schedule') return TripDateFormat.trip(request.details.date, request.details.time);
    if (request.kind === 'locations') {
      const stops = request.details.stops;
      const route = Array.isArray(stops) ? (stops.length ?
        stops.map((stop,index) => 'Stop '+(index+1)+': '+stop.address+' ('+stop.waitMinutes+' min expected)') :
        ['Remove all intermediate stops']) : [];
      return [request.details.pickup && 'Pickup: ' + request.details.pickup,
        ...route, request.details.dropoff && 'Destination: ' + request.details.dropoff].filter(Boolean).join(' · ');
    }
    return '';
  }

  function render(data) {
    if (reservation?.reference !== data.reservation.reference) resetStopRequest();
    reservation = data.reservation;
    access.hidden = true;
    verify.hidden = true;
    content.hidden = false;
    pay.hidden = reservation.canPay !== true;
    signOut.hidden = !!accountReference;
    details.replaceChildren();
    function add(label, value) {
      const group = node('div');
      const description = node('dd');
      description.append(value);
      group.append(node('dt', label), description);
      details.append(group);
    }
    const reference = reservation.bookingReference || reservation.reference;
    add('Booking reference', globalThis.BookingReference?.control(reference) || reference);
    add('Booking status', bookingLabels[reservation.status] || 'Unavailable');
    add('Pickup', reservation.pickup);
    for (const stop of reservation.stopSummary?.stops || []) add('Stop '+stop.sequence,BookingStops.stopText(stop));
    add(reservation.stopSummary?'Final destination':'Destination', reservation.dropoff);
    add('Pickup date and time', TripDateFormat.trip(reservation.date, reservation.time));
    if (reservation.returnDate) add('Return pickup', TripDateFormat.trip(reservation.returnDate, reservation.returnTime));
    add('Vehicle', reservation.vehicle);
    add('Passengers', reservation.passengers);
    add('Accepted total', new Intl.NumberFormat('en-US', {style: 'currency', currency: reservation.currency}).format(reservation.total));
    add('Payment status', refundLabels[reservation.refundStatus] ||
      (reservation.paymentVerificationPending ? 'Payment verification in progress' : payLabels[reservation.paymentStatus] || 'Unavailable'));

    const pending = data.requests.some(request => request.status === 'pending');
    const canRequestStops = Array.isArray(reservation.stopTemplate);
    const previewEnabled = !!data.selfService?.changePreviewsEnabled;
    requestForm.hidden = (previewEnabled && !canRequestStops) || pending ||
      !(reservation.canRequest || reservation.canRequestCancellation);
    if (pending || !canRequestStops) resetStopRequest();
    for (const option of el('manageKind').options) {
      option.disabled = previewEnabled && canRequestStops ? option.value !== 'locations' :
        !reservation.canRequest && option.value !== 'cancellation';
      if (option.value === 'locations') option.textContent = canRequestStops ?
        'Change pickup, destination, or stops' : 'Change pickup or destination';
    }
    if (previewEnabled && canRequestStops) el('manageKind').value = 'locations';
    else if (!reservation.canRequest && reservation.canRequestCancellation) el('manageKind').value = 'cancellation';
    updateFields();
    managedActions.render(data);
    el('manageRequestAvailability').textContent = pending ? 'A request is awaiting owner review.' :
      reservation.canRequest || reservation.canRequestCancellation ? '' : 'Online requests are unavailable for this reservation.';
    if (!el('manageDate').value) el('manageDate').value = reservation.date;
    if (!el('manageTime').value) el('manageTime').value = reservation.time;
    requests.replaceChildren();
    for (const request of data.requests) {
      const item = node('li');
      item.append(node('strong', requestLabels[request.kind] + ' · ' + decisionLabels[request.status]));
      const description = requestDescription(request);
      if (description) item.append(node('p', description));
      if (request.kind === 'amendment') {
        for (const line of [...window.erReservationSelfService.changesText(request.details),
          ...window.erReservationSelfService.fareText(request.details)].filter(Boolean)) item.append(node('p', line));
      }
      if (request.details.terms) {
        for (const line of window.erReservationSelfService.cancellationText(request.details.terms)) item.append(node('p', line));
      }
      item.append(node('p', 'Submitted ' + TripDateFormat.instant(request.submittedAt)));
      if (request.reviewedAt) item.append(node('p', 'Decision recorded ' + TripDateFormat.instant(request.reviewedAt)));
      if (request.cancellationAppliedAt) item.append(node('p', 'Cancellation approved. Any refund requires a separate owner decision.'));
      if (request.status === 'approved' && !request.cancellationAppliedAt && !(request.kind === 'cancellation' && data.cancellation)) item.append(node('p', 'Contact the office to confirm how your approved request will be handled.'));
      requests.append(item);
    }
    if (!data.requests.length) requests.append(node('li', 'No requests submitted.'));
  }

  function showAccess() {
    content.hidden = true;
    access.hidden = false;
    verify.hidden = true;
    reservation = null;
    resetStopRequest();
    details.replaceChildren();
    requests.replaceChildren();
    retry = null;
    requestForm.reset();
    updateFields();
    managedActions.reset();
    pay.hidden = true;
    signOut.hidden = true;
  }

  async function load() {
    const current = generation;
    try {
      const data = await api(endpoint());
      if (current === generation) render(data);
      return true;
    } catch (error) {
      if (current !== generation) return false;
      showAccess();
      if (accountReference) status.textContent = 'Sign in to the owning account from My Trips to view this reservation.';
      else if (error.status !== 404) status.textContent = 'Unable to load reservation status. Please try again.';
      return false;
    }
  }

  async function act(button, action) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    const current = generation;
    status.textContent = '';
    try {
      await action(() => current === generation);
    } catch (error) {
      if (current === generation) {
        if (reservation && (error.status === 401 || error.status === 404)) showAccess();
        status.textContent = error.status ? error.message : 'Unable to complete the request. Please try again.';
      }
    } finally {
      if (current === generation) {
        busy = false;
        button.disabled = false;
      }
    }
  }

  el('manageLinkForm').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    void act(form.querySelector('button'), async current => {
      const data = await api(base + '/verification/request', {
        reference: el('manageReference').value.trim(), email: el('manageEmail').value.trim()
      });
      if (current()) {
        form.reset();
        status.textContent = data.message;
      }
    });
  });

  el('manageVerifyButton').addEventListener('click', event => {
    void act(event.currentTarget, async current => {
      if (!token) return;
      const submitted = token;
      token = null;
      try {
        await api(base + '/verification/exchange', {token: submitted});
        if (current()) await load();
      } catch (error) {
        if (current()) showAccess();
        throw error;
      }
    });
  });

  function resetStopRequest() {
    editingStops = false;
    stopEditor?.replace();
    stopEditor?.setEnabled(false);
    el('manageEditStops').hidden = false;
  }

  el('manageEditStops').addEventListener('click', () => {
    if (!Array.isArray(reservation?.stopTemplate)) return;
    editingStops = true;
    stopEditor?.replace(reservation.stopTemplate);
    updateFields();
    el('manageStopEditor').querySelector('input,button')?.focus();
  });

  function updateFields() {
    const kind = el('manageKind').value;
    const showStops = kind === 'locations' && Array.isArray(reservation?.stopTemplate);
    el('manageStopsControls').hidden = !showStops;
    el('manageEditStops').hidden = editingStops;
    stopEditor?.setEnabled(showStops && editingStops);
    el('manageSchedule').hidden = kind !== 'pickup_schedule';
    el('manageLocations').hidden = kind !== 'locations';
    el('manageDate').required = el('manageTime').required = kind === 'pickup_schedule';
  }
  el('manageKind').addEventListener('change', updateFields);
  updateFields();

  requestForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!reservation || requestForm.hidden) return;
    const invalidStop = stopEditor?.invalidAddress();
    if (invalidStop) { invalidStop.reportValidity(); return; }
    void act(el('manageSubmitRequest'), async current => {
      const kind = el('manageKind').value;
      const body = {kind, confirmed: el('manageConfirmed').checked};
      if (kind === 'pickup_schedule') Object.assign(body, {date: el('manageDate').value, time: el('manageTime').value});
      if (kind === 'locations') Object.assign(body, {pickup: el('managePickup').value, dropoff: el('manageDropoff').value,
        ...(editingStops ? {stops:stopEditor.values()} : {})});
      const key = JSON.stringify(body);
      if (retry?.key !== key) retry = {key, id: crypto.randomUUID()};
      await api(endpoint() + '/requests', {...body, requestId: retry.id});
      if (current()) {
        requestForm.reset();
        resetStopRequest();
        updateFields();
        retry = null;
        if (await load() && current()) status.textContent = 'Request sent for owner review.';
      }
    });
  });

  pay.addEventListener('click', () => {
    if (!reservation?.canPay) return;
    void act(pay, async current => {
      const id = encodeURIComponent(reservation.reference);
      const path = accountReference ? '/api/customer/trips/' + id + '/payment' : '/api/booking/' + id + '/checkout';
      try {
        const data = await api(path, {});
        if (!current()) return;
        const checkout = new URL(data.url);
        if (checkout.protocol !== 'https:' || checkout.username || checkout.password) throw Error('Invalid payment URL.');
        location.assign(checkout.href);
      } catch (error) {
        if (current() && error.status === 409) await load();
        throw error;
      }
    });
  });

  el('manageRefresh').addEventListener('click', event => void act(event.currentTarget, load));
  signOut.addEventListener('click', () => {
    if (busy) return;
    showAccess();
    void act(signOut, async current => {
      await api(base + '/guest/sign-out', {});
      if (current()) status.textContent = 'Guest access ended.';
    });
  });

  function resetPrivateView() {
    generation++;
    busy = false;
    token = null;
    showAccess();
    el('manageLinkForm').reset();
    status.textContent = '';
    for (const button of document.querySelectorAll('.reservation-management button')) button.disabled = false;
  }

  function openVerificationLink() {
    if (!location.hash.startsWith('#verify=')) return;
    const candidate = location.hash.slice(8);
    history.replaceState(null, '', location.pathname);
    resetPrivateView();
    accountReference = null;
    if (/^[A-Za-z0-9_-]{43}$/.test(candidate)) {
      token = candidate;
      access.hidden = true;
      verify.hidden = false;
    } else {
      status.textContent = 'This verification link is invalid. Request a new link.';
    }
  }

  openVerificationLink();
  window.addEventListener('hashchange', openVerificationLink);
  window.addEventListener('pageshow', () => { if (!token) void load(); });
  window.addEventListener('pagehide', resetPrivateView);
})();
