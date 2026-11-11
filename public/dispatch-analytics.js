(() => {
  'use strict';

  const endpoint = '/api/admin/business-analytics';
  const byId = id => document.getElementById(id);
  const panel = byId('businessAnalytics');
  const dateForm = byId('analyticsDates'), tripForm = byId('analyticsTripFilters');
  const preset = byId('analyticsPreset'), from = byId('analyticsFrom'), to = byId('analyticsTo');
  const status = byId('analyticsStatus'), results = byId('analyticsResults');
  const reportStatus = byId('analyticsReportStatus'), report = byId('analyticsTripReport');
  const csvButton = byId('analyticsCsv'), pager = byId('analyticsPager');
  const previous = byId('analyticsPrevious'), next = byId('analyticsNext');
  const integerFormat = new Intl.NumberFormat('en-US');
  const shortDate = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric'});
  const monthDate = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', month: 'short', year: 'numeric'});
  const fullDate = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric'});
  const reportFields = {search: 'analyticsSearch', status: 'analyticsTripStatus', payment: 'analyticsPayment',
    vehicle: 'analyticsVehicle', sort: 'analyticsSort', order: 'analyticsOrder'};
  const paymentLabels = {
    unpaid: 'Unpaid', failed: 'Payment failed', processing: 'Processing', paid: 'Paid',
    partially_paid: 'Partially paid', refunded: 'Refunded', partially_refunded: 'Partially refunded', review: 'Review required'
  };
  const operational = [
    ['bookingsReceived', 'Bookings received'], ['completedRides', 'Completed rides'],
    ['cancelledRides', 'Cancelled rides'], ['upcomingRides', 'Upcoming rides'],
    ['pendingReservations', 'Pending reservations'], ['pendingRequests', 'Pending customer requests'],
    ['approvedRequests', 'Approved customer requests'], ['declinedRequests', 'Declined customer requests']
  ];
  const financial = [
    ['grossAcceptedCents', 'Gross accepted booking value', 'money'], ['completedValueCents', 'Gross completed-trip value', 'money'],
    ['collectedCents', 'Actual payments collected', 'money'], ['refundsCents', 'Completed refunds', 'money'],
    ['netCollectedCents', 'Net collected payments', 'money'], ['collectibleCents', 'Unpaid collectible balances', 'money'],
    ['averageCompletedCents', 'Average completed-trip fare', 'money'], ['cancellationRateBasisPoints', 'Cancellation rate', 'percent']
  ];
  let api, openTrip, applied, reportFilters, page = 1, summaryTask, reportTask, exportTask;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  }

  const parseDay = day => new Date(day + 'T12:00:00Z');
  const formatted = day => fullDate.format(parseDay(day));
  const periodLabel = period => formatted(period.from) + (period.to === period.from ? '' : ' – ' + formatted(period.to));
  const words = status => status ? status[0].toUpperCase() + status.slice(1).replaceAll('_', ' ') : 'Unavailable';

  function formatPercent(basisPoints, signed = false) {
    const points = BigInt(basisPoints);
    const magnitude = points < 0n ? -points : points;
    const decimals = String(magnitude % 100n).padStart(2, '0').replace(/0+$/, '');
    const sign = points < 0n ? '−' : signed && points > 0n ? '+' : '';
    return sign + integerFormat.format(magnitude / 100n) + (decimals ? '.' + decimals : '') + '%';
  }

  function format(value, type) {
    if (value === null || value === undefined) return 'Unavailable';
    if (type === 'percent') return formatPercent(value);
    if (type !== 'money') return integerFormat.format(value);
    const cents = BigInt(value), abs = cents < 0n ? -cents : cents;
    return (cents < 0n ? '−' : '') + '$' + integerFormat.format(abs / 100n) + '.' + String(abs % 100n).padStart(2, '0');
  }

  function metricGroup(title, descriptors, values) {
    const group = node('section', undefined, 'ba-metric-group');
    const list = node('dl', undefined, 'ba-metric-grid');
    for (const [key, label, type] of descriptors) {
      const card = node('div', undefined, 'ba-metric');
      card.dataset.metric = key;
      const value = node('dd', format(values[key], type));
      if (values[key] === null) value.className = 'ba-unavailable';
      card.append(node('dt', label), value);
      list.append(card);
    }
    group.append(node('h3', title), list);
    return group;
  }

  function changeLabel(change) {
    if (change.kind === 'no_change') return 'No change';
    if (change.kind === 'no_prior_activity') return 'No prior activity';
    if (change.kind === 'below_precision') {
      return change.direction === 'decrease' ? 'Decrease under 0.01%' : 'Increase under 0.01%';
    }
    return change.kind === 'percent' ? formatPercent(change.basisPoints, true) : 'Unavailable';
  }

  function renderComparison(data) {
    const target = byId('analyticsComparison');
    const comparison = data.comparison;
    target.replaceChildren();
    if (!comparison) {
      target.append(node('p', 'Prior period unavailable.', 'ba-note'));
      return;
    }
    const {unit, count} = comparison.basis;
    const [basisLabel, periodUnit] = unit === 'month' ?
      ['Equivalent calendar periods', 'full calendar month'] : ['Equal calendar-day lengths', 'day'];
    const length = integerFormat.format(count) + ' ' + periodUnit + (count === 1 ? '' : 's') + ' each';
    target.append(node('p', 'Compared with ' + periodLabel(comparison.range) + ' · ' + basisLabel + ' (' + length + ')', 'ba-note'));
    const grid = node('div', undefined, 'ba-comparison');
    for (const [key, label, type] of [operational[0], operational[1], financial[1], financial[2]]) {
      const card = node('article', undefined, 'ba-comparison-card');
      const current = data.summary[key], prior = comparison.summary[key];
      const max = Math.max(1, Number(current), Number(prior));
      const delta = node('p', changeLabel(comparison.growth[key]), 'ba-change');
      card.append(node('h4', label), delta,
        barRow('Selected', current, type, max, 'gold'), barRow('Previous', prior, type, max, 'blue'));
      grid.append(card);
    }
    target.append(grid);
  }

  function barRow(label, value, type, max, tone) {
    const row = node('div', undefined, 'ba-bar-row');
    row.append(node('span', label, 'ba-bar-name'), node('strong', format(value, type)));
    if (value !== null) {
      const meter = node('meter', undefined, 'ba-meter ba-meter-' + tone);
      meter.min = 0;
      meter.max = max;
      meter.value = Number(value);
      meter.setAttribute('aria-label', label);
      meter.setAttribute('aria-valuetext', format(value, type));
      row.append(meter);
    }
    return row;
  }

  function chartDate(bucket, unit) {
    if (unit === 'month') return monthDate.format(parseDay(bucket.from));
    if (bucket.from === bucket.to) return shortDate.format(parseDay(bucket.from));
    return shortDate.format(parseDay(bucket.from)) + ' – ' + shortDate.format(parseDay(bucket.to));
  }

  function chart(title, buckets, unit, series, type) {
    const card = node('section', undefined, 'ba-chart');
    const heading = node('h4', title);
    card.append(heading);
    if (!buckets.length || !buckets.some(bucket => series.some(([key]) => bucket[key] === null || Number(bucket[key]) > 0))) {
      card.append(node('p', 'No activity in this period.', 'ba-note'));
      return card;
    }
    const max = buckets.reduce((peak, bucket) =>
      series.reduce((value, [key]) => Math.max(value, Number(bucket[key])), peak), 1);
    const list = node('ol', undefined, 'ba-chart-periods');
    if (buckets.length > 4) {
      list.tabIndex = 0;
      list.setAttribute('aria-label', title + ' by ' + unit);
    }
    for (const bucket of buckets) {
      const row = node('li', undefined, 'ba-chart-period');
      row.append(node('p', chartDate(bucket, unit), 'ba-chart-date'));
      for (const [key, label, tone] of series) row.append(barRow(label, bucket[key], type, max, tone));
      list.append(row);
    }
    card.append(list);
    return card;
  }

  function renderSummary(data) {
    byId('analyticsPeriod').textContent = periodLabel(data.range);
    byId('analyticsMetrics').replaceChildren(
      metricGroup('Bookings & requests', operational, data.summary),
      metricGroup('Fares & payments', financial, data.summary)
    );
    const coverage = byId('analyticsCoverage');
    const {paymentGaps, refundGaps, unknownBalances} = data.summary.coverage;
    const missing = [];
    if (paymentGaps) missing.push(integerFormat.format(paymentGaps) + ' payment evidence gaps');
    if (refundGaps) missing.push(integerFormat.format(refundGaps) + ' refund evidence or timing gaps');
    if (unknownBalances) missing.push(integerFormat.format(unknownBalances) + ' balances needing review');
    coverage.hidden = missing.length === 0;
    coverage.textContent = missing.length ? 'Unavailable totals have incomplete records in this period. ' + missing.join(' · ') + '.' : '';
    renderComparison(data);
    const unit = data.granularity;
    const labels = {day: 'Daily', week: 'Weekly', month: 'Monthly'};
    const sparse = data.activity.sparse || data.completedValue.sparse;
    byId('analyticsGranularity').textContent = labels[unit] + ' activity · Completed-trip value is monthly' +
      (sparse ? ' · Empty months omitted for long ranges' : '');
    const buckets = data.activity.buckets;
    byId('analyticsCharts').replaceChildren(
      chart('Completed rides over time', buckets, unit, [['completed', 'Completed', 'gold']]),
      chart('Monthly gross completed-trip value', data.completedValue.buckets, 'month', [['cents', 'Completed fares', 'gold']], 'money'),
      chart('Actual payments collected', buckets, unit, [['collectedCents', 'Collected', 'green']], 'money'),
      chart('Cancelled versus completed bookings', buckets, unit, [['completed', 'Completed', 'gold'], ['cancelled', 'Cancelled', 'red']]),
      chart('Customer request activity', buckets, unit, [['pendingRequests', 'Pending', 'blue'],
        ['approvedRequests', 'Approved', 'green'], ['declinedRequests', 'Declined', 'red']])
    );
  }

  function renderTrips(trips) {
    report.replaceChildren();
    if (!trips.length) return;
    const labels = ['Booking reference', 'Pickup date', 'Pickup', 'Destination', 'Vehicle', 'Trip status',
      'Payment status', 'Accepted fare', 'Captured payments', 'Refunded amount'];
    const table = node('table', undefined, 'ba-trip-table');
    table.setAttribute('aria-label', 'Detailed Trip Report');
    const head = node('thead'), headings = node('tr'), body = node('tbody');
    for (const label of [...labels, 'Dispatch']) {
      const th = node('th', label);
      th.scope = 'col';
      headings.append(th);
    }
    head.append(headings);
    for (const trip of trips) {
      const values = [trip.reference, formatted(trip.pickupDate), trip.pickup, trip.destination, trip.vehicleLabel,
        words(trip.status), paymentLabels[trip.paymentStatus] || 'Unavailable', format(trip.fareCents, 'money'),
        format(trip.capturedCents, 'money'), format(trip.refundedCents, 'money')];
      const row = node('tr');
      for (const [index, value] of values.entries()) {
        const cell = node('td', value ?? 'Unavailable');
        cell.dataset.label = labels[index];
        row.append(cell);
      }
      const action = node('td', undefined, 'ba-open-trip');
      const open = node('button', 'Open in Dispatch', 'btn btn-secondary');
      open.type = 'button';
      open.setAttribute('aria-label', 'Open ' + trip.reference + ' in Dispatch');
      open.addEventListener('click', () => { if (openTrip) void openTrip(trip); });
      action.append(open);
      row.append(action);
      body.append(row);
    }
    table.append(head, body);
    report.append(table);
  }

  const url = (path, values) => endpoint + path + '?' + new URLSearchParams(values);
  const controls = () => Object.fromEntries(Object.entries(reportFields).map(([key, id]) => [key, byId(id).value.trim()]));

  async function loadTrips(requestedPage) {
    if (!api || !applied || !reportFilters) return;
    reportTask?.abort();
    exportTask?.abort();
    exportTask = null;
    const task = reportTask = new AbortController();
    report.replaceChildren();
    csvButton.disabled = true;
    pager.hidden = true;
    reportStatus.textContent = 'Loading trips…';
    try {
      const data = await api(url('/trips', {...applied, ...reportFilters, page: requestedPage}), {signal: task.signal});
      if (reportTask !== task) return;
      page = data.page;
      renderTrips(data.trips);
      reportStatus.textContent = data.trips.length ? '' : 'No trips match the applied dates and filters.';
      pager.hidden = page === 1 && !data.hasNext;
      previous.disabled = page === 1;
      next.disabled = !data.hasNext;
      byId('analyticsPage').textContent = 'Page ' + integerFormat.format(page);
      csvButton.disabled = !(data.trips.length || page > 1);
    } catch (error) {
      if (reportTask === task && !task.signal.aborted) reportStatus.textContent = error.message || 'Unable to load trips.';
    } finally {
      if (reportTask === task) reportTask = null;
    }
  }

  async function loadDates() {
    if (!api) return;
    summaryTask?.abort();
    reportTask?.abort();
    exportTask?.abort();
    reportTask = exportTask = null;
    const task = summaryTask = new AbortController();
    const selected = preset.value === 'custom' ? {preset: 'custom', from: from.value, to: to.value} : {preset: preset.value};
    applied = null;
    results.hidden = true;
    report.replaceChildren();
    status.textContent = 'Loading analytics…';
    try {
      const data = await api(url('', selected), {signal: task.signal});
      if (summaryTask !== task) return;
      from.value = data.range.from;
      to.value = data.range.to;
      renderSummary(data);
      applied = data.range;
      reportFilters = controls();
      status.textContent = '';
      results.hidden = false;
      await loadTrips(1);
    } catch (error) {
      if (summaryTask === task && !task.signal.aborted) status.textContent = error.message || 'Unable to load analytics.';
    } finally {
      if (summaryTask === task) summaryTask = null;
    }
  }

  async function download() {
    if (!api || !applied || !reportFilters || csvButton.disabled) return;
    const task = exportTask = new AbortController();
    const selection = applied;
    csvButton.disabled = true;
    reportStatus.textContent = 'Preparing CSV…';
    try {
      const blob = await api(url('/trips.csv', {...selection, ...reportFilters}), {asBlob: true, signal: task.signal});
      if (exportTask !== task) return;
      if (!blob.type.startsWith('text/csv')) throw new Error('Unable to download the trip report.');
      const href = URL.createObjectURL(blob);
      const link = node('a');
      link.href = href;
      link.download = 'er-dispatch-trips-' + selection.from + '_' + selection.to + '.csv';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      reportStatus.textContent = 'CSV downloaded.';
    } catch (error) {
      if (exportTask === task && !task.signal.aborted) reportStatus.textContent = error.message || 'Unable to download the trip report.';
    } finally {
      if (exportTask === task) {
        exportTask = null;
        csvButton.disabled = false;
      }
    }
  }

  dateForm.addEventListener('submit', event => { event.preventDefault(); void loadDates(); });
  for (const input of [from, to]) input.addEventListener('input', () => { preset.value = 'custom'; });
  preset.addEventListener('change', () => {
    if (preset.value === 'custom') from.focus();
    else void loadDates();
  });
  byId('analyticsReset').addEventListener('click', () => {
    dateForm.reset();
    tripForm.reset();
    void loadDates();
  });
  tripForm.addEventListener('submit', event => {
    event.preventDefault();
    reportFilters = controls();
    void loadTrips(1);
  });
  previous.addEventListener('click', () => { if (!previous.disabled) void loadTrips(page - 1); });
  next.addEventListener('click', () => { if (!next.disabled) void loadTrips(page + 1); });
  csvButton.addEventListener('click', () => void download());
  panel.addEventListener('toggle', () => { if (panel.open && api && !applied && !summaryTask) void loadDates(); });

  window.erBusinessAnalytics = {setAuthenticated(authenticated, fetchAdmin, openDispatchTrip) {
    panel.hidden = !authenticated;
    if (authenticated) {
      api = fetchAdmin;
      openTrip = openDispatchTrip;
      return;
    }
    summaryTask?.abort();
    reportTask?.abort();
    exportTask?.abort();
    summaryTask = reportTask = exportTask = null;
    api = openTrip = applied = reportFilters = null;
    panel.open = false;
    results.hidden = true;
    dateForm.reset();
    tripForm.reset();
    csvButton.disabled = true;
    status.textContent = reportStatus.textContent = '';
    for (const id of ['analyticsMetrics', 'analyticsCoverage', 'analyticsComparison', 'analyticsCharts', 'analyticsTripReport']) {
      byId(id).replaceChildren();
    }
  }};
})();
