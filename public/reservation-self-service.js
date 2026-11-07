(() => {
  'use strict';
  const price = cents => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(cents / 100);
  const el = id => document.getElementById(id);
  const fields = ['date', 'time', 'pickup', 'dropoff', 'vehicle', 'passengers', 'luggage', 'flightNumber', 'pickupTerminal', 'dropoffTerminal'];
  const label = {
    date: 'Pickup date', time: 'Pickup time', pickup: 'Pickup', dropoff: 'Destination', vehicle: 'Vehicle',
    passengers: 'Passengers', luggage: 'Luggage', flightNumber: 'Flight number', pickupTerminal: 'EWR pickup terminal',
    dropoffTerminal: 'EWR drop-off terminal'
  };
  const reasons = {
    within_24_hours: 'Your reservation stays active until the owner approves cancellation. Any refund requires a separate owner decision.',
    service_started: 'Started or completed trips need authorized owner review. Any refund requires a separate owner decision.',
    payment_review: 'Dispatch must verify payment before processing this cancellation.',
    legacy_policy: 'Dispatch will review your original cancellation terms and any applicable refund.'
  };
  const refundStates = {
    no_refund: 'No refund due', prepared: 'Refund initiated', submitted_unknown: 'Refund initiated · status unverified',
    provider_identified: 'Refund processing', confirmed: 'Refund confirmed',
    failed: 'Refund failed · Dispatch review', review_required: 'Reconciliation required'
  };
  const vehicle = {suv: 'Chevrolet Suburban', escalade: 'Cadillac Escalade'};

  function lines(container, messages) {
    container.replaceChildren();
    for (const message of messages.filter(Boolean)) {
      const row = document.createElement('p');
      row.textContent = message;
      container.append(row);
    }
  }

  function changesText(details) {
    if (!details?.changes) return [];
    return Object.entries(details.changes).map(([key, value]) => {
      if (key === 'date') value = TripDateFormat.date(value);
      if (key === 'time') value = TripDateFormat.time(value);
      if (key === 'vehicle') value = vehicle[value] || value;
      if (key.endsWith('Terminal')) value = value === 'general' ? 'General airport' : String(value).toUpperCase();
      return label[key] + ' · ' + (value === '' ? 'Remove' : value);
    });
  }

  function fareText(details) {
    if (!details || !Number.isSafeInteger(details.originalCents)) return [];
    return ['Original fare · ' + price(details.originalCents),
      details.newCents === null ? 'New fare · Dispatch review needed' : 'Proposed fare · ' + price(details.newCents),
      details.differenceCents === null ? '' : 'Difference · ' + price(details.differenceCents)];
  }

  function cancellationText(terms) {
    if (!terms) return [];
    const lines = ['Accepted fare · ' + price(terms.fareCents)];
    if (terms.review || terms.refundCents === null) {
      return [...lines, 'Cancellation and any refund · Owner review required'];
    }
    if (terms.legacySettlement) lines.push('Previously recorded retained amount · ' + price(terms.retainedCents));
    else lines.push('Cancellation fee · $0.00');
    lines.push((terms.state === 'confirmed' ? 'Refunded · ' : 'Expected refund · ') + price(terms.refundCents));
    return lines;
  }

  function create({api, endpoint, act, reload, status}) {
    const section = el('managedActions'), editor = el('managedChangeForm'), cancellation = el('managedCancelControls');
    const changesQuote = el('managedChangeQuote'), cancellationQuote = el('managedCancelQuote');
    const reviewChange = el('managedChangeReview'), reviewCancellation = el('managedCancelReview');
    const autoCancel = el('managedCancelConfirm'), manualCancel = el('managedCancelManual');
    const changeConsent = el('managedChangeConsent'), cancelConsent = el('managedCancelConsent');
    const result = el('managedCancellationResult');
    let settings, currentChange, currentCancellation, changeGeneration = 0;

    function clearChange() {
      changeGeneration++;
      currentChange = null;
      changeConsent.checked = false;
      reviewChange.hidden = true;
      changesQuote.replaceChildren();
    }

    function clearCancellation() {
      currentCancellation = null;
      cancelConsent.checked = false;
      reviewCancellation.hidden = true;
      cancellationQuote.replaceChildren();
    }

    function reset() {
      settings = null;
      section.hidden = true;
      result.hidden = true;
      result.replaceChildren();
      editor.reset();
      clearChange();
      clearCancellation();
    }

    function render(data) {
      reset();
      settings = data.selfService;
      if (settings && (settings.canChange || settings.canCancel)) {
        section.hidden = false;
        editor.hidden = !settings.canChange;
        cancellation.hidden = !settings.canCancel;
        el('managedChange-flightNumber').value = settings.flightNumber;
      }
      if (data.cancellation) {
        const c = data.cancellation;
        result.hidden = false;
        lines(result, ['Reservation cancelled', ...cancellationText(c), refundStates[c.state]]);
      }
    }

    editor.addEventListener('input', event => {
      if (event.target !== changeConsent) clearChange();
    });
    editor.addEventListener('submit', event => {
      event.preventDefault();
      if (!settings?.canChange) return;
      const fieldsToPrice = {};
      for (const key of fields) {
        const value = el('managedChange-' + key).value.trim();
        if (key === 'flightNumber') {
          if (value !== settings.flightNumber) fieldsToPrice[key] = value;
        } else if (value) fieldsToPrice[key] = ['passengers', 'luggage'].includes(key) ? Number(value) : value;
      }
      void act(el('managedPreviewChange'), async current => {
        clearChange();
        const generation = changeGeneration;
        const {preview} = await api(endpoint() + '/changes/preview', fieldsToPrice);
        if (!current() || generation !== changeGeneration) return;
        currentChange = {...preview, requestId: crypto.randomUUID()};
        lines(changesQuote, [...changesText(preview), ...fareText(preview),
          preview.review === 'within_24_hours' ? 'Changes within 24 hours need Dispatch approval.' : 'Dispatch must verify vehicle availability.',
          preview.pricingReview === 'existing_promotion' && 'Dispatch will review the existing promotion.',
          preview.luggageReview && 'Dispatch must confirm luggage capacity.']);
        reviewChange.hidden = false;
      });
    });

    el('managedSubmitChange').addEventListener('click', event => {
      if (!currentChange || !changeConsent.checked) {
        status.textContent = 'Confirm that you reviewed the proposed fare and change details.';
        return;
      }
      const preview = currentChange;
      void act(event.currentTarget, async current => {
        await api(endpoint() + '/changes/confirm', {previewId: preview.id, revision: preview.revision,
          requestId: preview.requestId, confirmed: true});
        if (current() && await reload() && current()) status.textContent = 'Change request sent to Dispatch.';
      });
    });

    el('managedPreviewCancel').addEventListener('click', event => {
      if (!settings?.canCancel) return;
      void act(event.currentTarget, async current => {
        clearCancellation();
        const {terms} = await api(endpoint() + '/cancellation/preview', {});
        if (!current()) return;
        currentCancellation = {...terms, requestId: crypto.randomUUID()};
        const needsOwner = !!terms.review || !settings?.autoCancellationsEnabled;
        lines(cancellationQuote, [...cancellationText(terms), reasons[terms.review],
          needsOwner && !terms.review && reasons.within_24_hours]);
        el('managedCancelConsentLabel').textContent = needsOwner ?
          'I confirm this request for Dispatch review.' : 'I confirm cancellation and the expected refund shown above.';
        reviewCancellation.hidden = false;
        autoCancel.hidden = needsOwner;
        manualCancel.hidden = !autoCancel.hidden;
      });
    });

    function confirmCancellation(event, ownerReview) {
      if (!currentCancellation || !cancelConsent.checked) {
        status.textContent = ownerReview ? 'Confirm your request for Dispatch review.' :
          'Confirm cancellation and review the expected refund.';
        return;
      }
      const terms = currentCancellation;
      void act(event.currentTarget, async current => {
        try {
          const response = await api(endpoint() + '/cancellation/confirm', {requestId: terms.requestId,
            revision: terms.revision, confirmed: true, ownerReview});
          if (current() && await reload() && current()) {
            status.textContent = response.cancellation ? 'Reservation cancelled.' : 'Cancellation request sent to Dispatch.';
          }
        } catch (error) {
          if (current() && !ownerReview && [409, 503].includes(error.status)) manualCancel.hidden = false;
          throw error;
        }
      });
    }
    autoCancel.addEventListener('click', event => confirmCancellation(event, false));
    manualCancel.addEventListener('click', event => confirmCancellation(event, true));
    return {reset, render};
  }

  window.erReservationSelfService = {create, changesText, fareText, cancellationText, refundStates, reasons, price};
})();
