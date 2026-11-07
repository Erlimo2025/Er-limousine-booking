(() => {
  'use strict';

  const el = id => document.getElementById(id);
  const panel = el('reservationRequestsPanel'), view = el('reservationRequestsView');
  const status = el('reservationRequestsStatus'), list = el('reservationRequestsList');
  const refresh = el('reservationRequestsRefresh'), more = el('reservationRequestsMore');
  const endpoint = '/api/admin/reservation-requests';
  const labels = {pickup_schedule: 'Pickup date or time change', locations: 'Pickup or destination change',
    cancellation: 'Cancellation', amendment: 'Reservation change'};
  const {changesText, fareText, cancellationText, refundStates, reasons, price} = window.erReservationSelfService;
  const pending = new Set();
  let fetchAdmin, authenticated = false, generation = 0, cursor = null;

  function node(tag, value, className) {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = String(value);
    if (className) element.className = className;
    return element;
  }

  async function decide(request, decision, actions, message) {
    if (!authenticated || pending.has(request.id)) return;
    const prompt = decision === 'approved' && request.kind === 'cancellation'
      ? 'Approve and cancel this reservation? Any refund requires a separate owner decision. No refund will be issued by this action.'
      : decision === 'approved' ? 'Approve this change request? Follow up separately on availability and trip changes.'
      : 'Decline this reservation request? The reservation will stay active.';
    if (!window.confirm(prompt)) return;
    const current = generation;
    pending.add(request.id);
    for (const button of actions.children) button.disabled = true;
    try {
      const path = '/decision';
      const body = {status: decision, confirmed: true};
      await fetchAdmin(endpoint + '/' + encodeURIComponent(request.id) + path, {
        method: 'POST', body: JSON.stringify(body)
      });
      if (authenticated && current === generation) {
        const loaded = await load();
        if (loaded) status.textContent = 'Decision recorded.';
      }
    } catch (error) {
      if (authenticated && current === generation) message.textContent = error.message;
    } finally {
      pending.delete(request.id);
      for (const button of actions.children) button.disabled = false;
    }
  }

  function render(request) {
    const trip = request.reservation;
    const card = node('article', undefined, 'manage-queue-card');
    const fare = new Intl.NumberFormat('en-US', {style: 'currency', currency: trip.currency}).format(trip.total);
    const tripStatus = trip.status.replaceAll('_', ' ');
    const paymentStatus = trip.paymentVerificationPending ? 'verification pending' : trip.paymentStatus;
    card.append(node('h3', labels[request.kind] + ' · ' + request.status));
    card.append(node('p', 'Reservation ' + trip.reference + ' · ' + request.source));
    card.append(node('p', 'Current trip: ' + trip.pickup + ' → ' + trip.dropoff));
    card.append(node('p', TripDateFormat.trip(trip.date, trip.time) + ' · ' + trip.vehicle));
    card.append(node('p', 'Booking ' + tripStatus + ' · Payment ' + paymentStatus + ' · Accepted fare ' + fare));
    if (request.kind === 'pickup_schedule') {
      card.append(node('p', 'Requested pickup: ' + TripDateFormat.trip(request.details.date, request.details.time)));
    }
    if (request.details.pickup) card.append(node('p', 'Requested pickup: ' + request.details.pickup));
    if (request.details.dropoff) card.append(node('p', 'Requested destination: ' + request.details.dropoff));
    if (request.kind === 'amendment') {
      for (const line of [...changesText(request.details), ...fareText(request.details)].filter(Boolean)) card.append(node('p', line));
      card.append(node('p', 'Dispatch must verify the schedule and vehicle availability before following up.'));
    }
    const terms = request.details.terms;
    if (terms) {
      for (const line of [...cancellationText(terms), reasons[terms.review]].filter(Boolean)) card.append(node('p', line));
    }
    card.append(node('p', 'Submitted ' + TripDateFormat.instant(request.submittedAt)));
    if (request.cancellationAppliedAt) card.append(node('p', 'Cancellation applied. Any refund requires a separate owner decision.'));
    if (request.reviewedAt) {
      card.append(node('p', 'Decision recorded ' + TripDateFormat.instant(request.reviewedAt) + ' · Admin ' + request.reviewer));
    }
    if (request.status === 'pending') {
      const actions = node('div', undefined, 'manage-actions'), message = node('p');
      message.setAttribute('role', 'status');
      const approvals = [['Approve request', 'approved']];
      for (const [label, decision] of [...approvals, ['Decline request', 'declined']]) {
        const button = node('button', label, 'btn btn-secondary');
        button.type = 'button';
        button.addEventListener('click', () => void decide(request, decision, actions, message));
        actions.append(button);
      }
      card.append(actions, message);
    }
    return card;
  }

  function renderSettlement(settlement) {
    const card = node('article', undefined, 'manage-queue-card');
    card.append(node('h3', 'Cancellation · ' + (refundStates[settlement.state] || 'Refund needs review')));
    card.append(node('p', 'Reservation ' + settlement.reference + ' · ' + settlement.origin));
    for (const line of cancellationText(settlement)) card.append(node('p', line));

    card.append(node('p', 'Cancelled ' + TripDateFormat.instant(settlement.cancelledAt)));
    if (settlement.reviewer) card.append(node('p', 'Verified by Admin ' + settlement.reviewer + ' · ' + settlement.verificationNote));
    if (settlement.evidence) card.append(node('p', 'Reconciliation · ' + settlement.evidence.replaceAll('_', ' ')));
    if (settlement.lastAttemptAt) card.append(node('p', 'Last check · ' + TripDateFormat.instant(settlement.lastAttemptAt)));
    if (settlement.nextAttemptAt) card.append(node('p', 'Next check · ' + TripDateFormat.instant(settlement.nextAttemptAt)));
    if (settlement.escalatedAt) card.append(node('p', 'Escalated · ' + TripDateFormat.instant(settlement.escalatedAt)));
    if (settlement.canRecheck) {
      const button = node('button', 'Recheck Stripe refund', 'btn btn-secondary');
      const message = node('p');
      button.type = 'button';
      message.setAttribute('role', 'status');
      button.addEventListener('click', async () => {
        if (!authenticated || button.disabled) return;
        const current = generation;
        button.disabled = true;
        try {
          await fetchAdmin(endpoint + '/settlements/' + encodeURIComponent(settlement.reference) + '/recheck', {
            method: 'POST', body: '{}'
          });
          if (authenticated && current === generation && await load()) status.textContent = 'Stripe recheck recorded.';
        } catch (error) {
          if (authenticated && current === generation) message.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
      card.append(button, message);
    }
    return card;
  }

  async function load(append = false) {
    if (!authenticated) return false;
    const current = ++generation;
    if (!append) {
      list.replaceChildren();
      cursor = null;
      more.hidden = true;
    }
    refresh.disabled = true;
    more.disabled = true;
    status.textContent = 'Loading requests…';
    try {
      const settlements = ['settlements', 'reconciliation'].includes(view.value);
      const params = new URLSearchParams(view.value === 'settlements' ? {} : {status: view.value});
      if (append && cursor) params.set('cursor', cursor);
      const data = await fetchAdmin(endpoint + (settlements ? '/settlements' : '') + '?' + params);
      if (!authenticated || current !== generation) return false;
      list.append(...(settlements ? data.settlements.map(renderSettlement) : data.requests.map(render)));
      cursor = data.nextCursor;
      more.hidden = !cursor;
      status.textContent = list.children.length ? '' : 'No requests in this view.';
      return true;
    } catch (error) {
      if (authenticated && current === generation) status.textContent = error.message;
      return false;
    } finally {
      if (current === generation) {
        refresh.disabled = false;
        more.disabled = false;
      }
    }
  }

  function setAuthenticated(value, request) {
    authenticated = value;
    fetchAdmin = request || fetchAdmin;
    generation++;
    panel.hidden = !value;
    list.replaceChildren();
    cursor = null;
    status.textContent = '';
    refresh.disabled = false;
    more.hidden = true;
    if (!value) {
      panel.open = false;
      view.value = 'pending';
    } else if (panel.open) void load();
  }

  view.addEventListener('change', () => void load());
  refresh.addEventListener('click', () => void load());
  more.addEventListener('click', () => void load(true));
  panel.addEventListener('toggle', () => { if (panel.open && !list.children.length) void load(); });
  window.erReservationRequests = {setAuthenticated};
  window.addEventListener('pagehide', () => setAuthenticated(false));
})();
