(() => {
  'use strict';
  function amountCents(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value.trim())) return null;
    const [units, fraction = ''] = value.trim().split('.');
    return Number(units) * 100 + Number(fraction.padEnd(2, '0'));
  }
  function settledTotals(rows) {
    let debits = 0, credits = 0, pending = false, invalid = false, count = 0;
    for (const row of rows) {
      const amount = amountCents(row.amount);
      if (amount === null) { invalid = true; continue; }
      if (row.status !== 'settled') { pending = true; continue; }
      if (row.type === 'credit') credits += amount; else debits += amount;
      count++;
    }
    return {debits, credits, net: debits - credits, pending, invalid, count};
  }
  const panel = document.getElementById('tvPanel');
  if (!panel) return;
  const el = name => document.getElementById('tv' + name);
  const money = value => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(value / 100);
  const localTime = value => new Intl.DateTimeFormat('en-US', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York'}).format(new Date(value));
  const node = (tag, value, cls) => { const item = document.createElement(tag); if (value !== undefined) item.textContent = value; if (cls) item.className = cls; return item; };
  let authenticated = false, ready = false, generation = 0, pending, request, requestId, snapshot;
  const comparisons = new Map();
  function clearResult() {
    snapshot = null; comparisons.clear(); el('Results').replaceChildren(); el('Rows').replaceChildren();
    el('CompareDirection').replaceChildren(); el('Comparison').hidden = true; el('Summary').value = ''; el('Totals').textContent = ''; el('Review').textContent = '';
  }
  function invalidate() {
    generation++; pending?.abort(); pending = null; requestId = null; clearResult();
    el('Estimate').disabled = !ready; el('Status').textContent = '';
  }
  async function setAuthenticated(value, adminRequest) {
    if (!value) {
      authenticated = false; ready = false; invalidate(); panel.hidden = true; panel.open = false;
      el('Form').reset(); el('Comparison').reset(); el('ReturnFields').hidden = true;
      el('Warnings').replaceChildren(); el('Fleet').textContent = ''; return;
    }
    if (authenticated) return;
    authenticated = true; request = adminRequest;
    const current = ++generation; pending = new AbortController();
    try {
      const config = await request('/api/admin/toll-validation/config', {signal: pending.signal});
      if (!authenticated || current !== generation || config.enabled !== true || !config.fleet || !Array.isArray(config.warnings)) return;
      ready = true; panel.hidden = false; el('Estimate').disabled = false;
      const f = config.fleet;
      el('Fleet').textContent = `${f.label} · ${f.account} · ${f.vehicleClass} · ${f.plateCategory} · Not TLC licensed. Commercial and congestion coverage remain unverified.`;
      el('Warnings').replaceChildren(...config.warnings.map(value => node('li', value)));
    } catch (_) { /* This optional tool never blocks ordinary dispatch or exposes a provider error. */ }
    finally { if (current === generation) pending = null; }
  }
  function renderRoutes() {
    const header = node('p', `Captured ${localTime(snapshot.capturedAt)} (New York) / ${snapshot.capturedAt}. ${snapshot.reused ? 'Retry reused the original result.' : 'New estimate.'} Customer toll addition: $0.00.`);
    el('Results').replaceChildren(header);
    snapshot.routes.forEach((route, index) => {
      const box = node('section', undefined, 'tv-route'), details = node('dl');
      const attribution = node('p', 'Google Maps', 'tv-attribution'); attribution.translate = false; box.append(attribution);
      box.append(node('h3', route.direction === 'return' ? 'Return — Google-returned route' : 'Outbound — Google-returned route'));
      const row = (name, value) => details.append(node('dt', name), node('dd', value));
      row('Pickup', route.origin.address); row('Destination', route.destination.address);
      if (route.via) row('Requested via', route.via.address);
      row('Departure', localTime(route.departureTime) + ' (New York) / ' + route.departureTime);
      row('Route summary', route.description);
      row('Distance / time', (route.distanceMeters / 1609.344).toFixed(2) + ' mi / ' + Math.ceil(route.durationSeconds / 60) + ' min');
      row('Google assumptions', `${snapshot.googleAssumptions.emissionType}; US_NJ_EZPASSNJ; DRIVE. Business / 2Ax / NJ OL are metadata, not Google rate verification.`);
      const toll = route.originalGoogleTolls;
      row('Original Google toll total', toll.status === 'estimated' ? money(toll.amountCents) : toll.status === 'not_reported' ? 'No toll estimate reported — not a verified $0' : 'Unknown / invalid toll estimate — needs review');
      box.append(details, node('p', 'Google generated this driving route. The requested crossing is not independently verified; no congestion component or credit is assumed to be included or excluded.'));
      const turns = node('details'); turns.append(node('summary', 'Google route instructions'));
      const list = node('ol'); list.append(...route.instructions.map(value => node('li', value))); turns.append(list);
      if (!route.instructions.length) turns.append(node('p', 'No instruction evidence returned; the crossing remains unverified.'));
      if (route.instructionsTruncated) turns.append(node('p', 'Instruction list shortened; do not treat it as complete crossing evidence.'));
      box.append(turns, ...route.providerWarnings.map(value => node('p', value))); el('Results').append(box);
      const option = node('option', route.direction === 'return' ? 'Return' : 'Outbound'); option.value = String(index); el('CompareDirection').append(option);
      comparisons.set(index, {date: '', time: '', daily: 'unknown', credits: 'unknown', matched: false, rows: []});
    });
    el('Comparison').hidden = false; el('CompareDirection').value = '0'; renderComparison();
  }
  const currentComparison = () => comparisons.get(Number(el('CompareDirection').value));
  function renderComparison() {
    const model = currentComparison(); if (!model) return;
    for (const [name, key] of [['ActualDate', 'date'], ['ActualTime', 'time'], ['Daily', 'daily'], ['Credits', 'credits']]) el(name).value = model[key];
    el('Matched').checked = model.matched; el('Rows').replaceChildren();
    model.rows.forEach((entry, index) => {
      const line = node('div', undefined, 'tv-row');
      function field(label, key, options) {
        const wrap = node('label', label, key === 'description' ? 'tv-description' : undefined);
        const input = node(options ? 'select' : 'input');
        if (options) for (const [value, caption] of options) { const option = node('option', caption); option.value = value; input.append(option); }
        else { input.type = 'text'; input.maxLength = key === 'amount' ? 9 : 80; input.autocomplete = 'off'; if (key === 'amount') input.inputMode = 'decimal'; }
        input.value = entry[key]; input.addEventListener(options ? 'change' : 'input', () => { entry[key] = input.value; updateComparison(); });
        wrap.append(input); line.append(wrap);
      }
      field('Entry type', 'type', [['charge', 'Charge'], ['credit', 'Credit']]); field('Toll / credit description', 'description'); field('Amount USD', 'amount');
      field('Settlement', 'status', [['pending', 'Pending'], ['settled', 'Settled']]);
      const remove = node('button', 'Remove', 'btn btn-secondary'); remove.type = 'button';
      remove.addEventListener('click', () => { model.rows.splice(index, 1); renderComparison(); }); line.append(remove); el('Rows').append(line);
    });
    el('Add').disabled = model.rows.length >= 30; updateComparison();
  }
  function updateComparison() {
    const model = currentComparison(); if (!model || !snapshot) return;
    const route = snapshot.routes[Number(el('CompareDirection').value)], totals = settledTotals(model.rows), google = route.originalGoogleTolls;
    const difference = !totals.invalid && totals.count && google.status === 'estimated' ? totals.net - google.amountCents : null;
    el('Totals').textContent = `Settled debits ${money(totals.debits)} − settled credits ${money(totals.credits)} = settled subtotal ${money(totals.net)}. ` +
      (difference === null ? 'Difference unavailable until there are valid settled entries and a numeric Google estimate.' : `Actual minus original Google: ${difference > 0 ? '+' : ''}${money(difference)}.`);
    const review = ['Manual comparison only; commercial-rate and congestion coverage remain unverified.'];
    if (!model.rows.length || !totals.count) review.push('No settled transaction total entered.');
    if (totals.invalid) review.push('Enter non-negative USD amounts with at most two decimal places.');
    if (totals.pending) review.push('Pending amounts are excluded; this is not the final trip total.');
    if (totals.net < 0) review.push('Credits exceed the selected debits; check that the transactions belong together.');
    if (!model.matched || !model.date || !model.time) review.push('Actual route, travel date and time still need matching.');
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(route.departureTime)).map(part => [part.type, part.value]));
    if (model.date && model.date !== `${parts.year}-${parts.month}-${parts.day}`) review.push('Actual date differs from the estimated departure date.');
    if (model.time && model.time !== `${parts.hour}:${parts.minute}`) review.push('Actual departure time differs; check the applicable toll-point times and tariff windows.');
    if (new Date(route.departureTime).getTime() > Date.now()) review.push('Departure is still future: these amounts are reference observations until the actual trip is settled.');
    if (model.daily === 'unknown') review.push('Manhattan daily-entry history is unknown.');
    if (model.daily === 'paid') review.push('Do not charge another standard daily congestion toll for the same vehicle/day; reconcile any amount already in Google\u2019s total manually.');
    if (model.credits !== 'reconciled') review.push('Applicable credits are unknown, missing or pending.');
    el('Review').textContent = review.join(' ');
    el('Summary').value = [
      'TOLL VALIDATION — ESTIMATE ONLY — NO CUSTOMER BILLING', `Reference: ${requestId}`, `Captured: ${snapshot.capturedAt}`,
      `${snapshot.fleet.label}; NJ E-ZPass Business; 2Ax; NJ OL; not TLC licensed`,
      `Google pass/fuel: US_NJ_EZPASSNJ / ${snapshot.googleAssumptions.emissionType}`,
      `${route.direction}: ${route.origin.address} → ${route.destination.address}${route.via ? ' via requested point ' + route.via.address : ''}`,
      `Departure: ${route.departureTime}; Google route: ${route.description}; crossing not independently verified`,
      `Original Google tolls: ${google.status === 'estimated' ? money(google.amountCents) : google.status}`,
      `Actual travel: ${model.date || 'unknown'} ${model.time || 'unknown'} New York; daily-entry context: ${model.daily}; credits: ${model.credits}`,
      ...model.rows.map(row => `${row.status}: ${row.type} ${row.amount || '?'} USD — ${row.description}`), el('Totals').textContent, el('Review').textContent
    ].join('\n');
  }
  el('Form').addEventListener('input', () => { invalidate(); el('ReturnFields').hidden = el('Directions').value !== 'both'; });
  el('Directions').addEventListener('change', () => { invalidate(); el('ReturnFields').hidden = el('Directions').value !== 'both'; });
  el('New').addEventListener('click', invalidate);
  el('Form').addEventListener('submit', async event => {
    event.preventDefault(); if (!authenticated || !ready || el('Estimate').disabled) return;
    const current = generation; let completed = false; pending = new AbortController(); requestId ||= crypto.randomUUID();
    el('Estimate').disabled = true; el('Status').textContent = 'Estimating route tolls…';
    const both = el('Directions').value === 'both';
    const body = {requestId, pickup: el('Pickup').value, dropoff: el('Dropoff').value, via: el('Via').value,
      date: el('Date').value, time: el('Time').value, directions: el('Directions').value,
      returnDate: both ? el('ReturnDate').value : '', returnTime: both ? el('ReturnTime').value : '',
      vehicle: el('Vehicle').value, emissionType: el('Fuel').value};
    try {
      const data = await request('/api/admin/toll-validation/estimate', {method: 'POST', body: JSON.stringify(body), signal: pending.signal});
      if (!authenticated || current !== generation) return;
      if (data.estimateOnly !== true || data.checkoutAllowed !== false || !Array.isArray(data.routes) || !data.routes.length || data.routes.length > 2) throw Error('Toll validation response unavailable.');
      clearResult(); snapshot = data; renderRoutes(); completed = true; el('Status').textContent = 'Estimate ready. No fare or payment was changed.';
    } catch (error) { if (authenticated && current === generation) el('Status').textContent = error.message || 'Toll validation unavailable.'; }
    finally { if (current === generation) { pending = null; el('Estimate').disabled = completed || !ready; } }
  });
  el('Comparison').addEventListener('submit', event => event.preventDefault());
  el('CompareDirection').addEventListener('change', renderComparison);
  for (const [name, key] of [['ActualDate', 'date'], ['ActualTime', 'time'], ['Daily', 'daily'], ['Credits', 'credits'], ['Matched', 'matched']]) {
    el(name).addEventListener(name === 'ActualDate' || name === 'ActualTime' ? 'input' : 'change', () => {
      const model = currentComparison(); if (model) { model[key] = name === 'Matched' ? el(name).checked : el(name).value; updateComparison(); }
    });
  }
  el('Add').addEventListener('click', () => { const model = currentComparison(); if (model && model.rows.length < 30) { model.rows.push({type: 'charge', description: '', amount: '', status: 'pending'}); renderComparison(); } });
  window.addEventListener('pagehide', () => setAuthenticated(false));
  window.erTollValidation = {setAuthenticated};
})();
