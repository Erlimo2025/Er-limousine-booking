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
  const currentTab = byId('analyticsCurrentTab'), chartsTab = byId('analyticsChartsTab');
  const chartsPanel = byId('analyticsChartsView'), chartsResults = byId('chartsResults'), chartsStatus = byId('chartsStatus');
  const chartsPreset = byId('chartsPreset'), chartsFrom = byId('chartsFrom'), chartsTo = byId('chartsTo');
  const scrollArea = panel.closest('main');
  const chartTargets = ['chartsMetrics', 'chartsTrend', 'chartsServices', 'chartsRecent', 'chartsPaymentStatuses'];
  const pickupTime = new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit'});
  const axisMonth = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', month: 'short'});
  const serviceLabels = new Map([
    ['airport', ['Airport transfer', '#176de8']], ['hourly', ['Hourly service', '#279957']],
    ['point-to-point', ['Point to point', '#7839c2']], ['ewr-manhattan', ['EWR → Manhattan', '#e99b15']],
    ['unclassified', ['Unclassified', '#63708b']]
  ]);
  const chartStates = [
    ['paid', '#279957'], ['processing', '#176de8'], ['refunded', '#7839c2'],
    ['unpaid', '#e99b15'], ['review', '#63708b'], ['partially_paid', '#b87616'],
    ['partially_refunded', '#9c57d3'], ['failed', '#d52853']
  ];
  let api, openTrip, applied, appliedPreset, reportFilters, page = 1, summaryTask, reportTask, exportTask;
  let chartsTask, chartsDeadline, chartsTimer, chartsRequest, currentScroll = 0, pendingCurrentDates;
  let chartsReady = false, chartsSuspended = false, chartsBlurred = false;
  chartsPreset.append(...Array.from(preset.options, option => option.cloneNode(true)));

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

  const dateSelection = (quick, start, end) => quick === 'custom' ?
    {preset: 'custom', from: start, to: end} : {preset: quick};

  async function loadDates(selected = dateSelection(preset.value, from.value, to.value), keepReportFilters = false) {
    if (!api) return;
    summaryTask?.abort();
    reportTask?.abort();
    exportTask?.abort();
    reportTask = exportTask = null;
    const task = summaryTask = new AbortController();
    const requestedPreset = preset.value;
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
      appliedPreset = requestedPreset;
      if (!keepReportFilters || !reportFilters) reportFilters = controls();
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

  function share(part, total) {
    return total > 0n ? (BigInt(part) * 10000n + total / 2n) / total : 0n;
  }

  const money = cents => format(cents, 'money');
  const chartMessage = message => node('p', message, 'bac-message');
  const noTrips = 'No reservations within the selected pickup dates.';
  const noPayments = 'No verified payments in this period.';
  const unavailablePayments = 'Unavailable — payment evidence is incomplete.';

  function renderChartMetrics(summary, reservationCount) {
    const metrics = [
      ['collectedCents', 'Payments Collected', money(summary.collectedCents), 'Verified captures', '$', 'green'],
      ['paidReservations', 'Paid Reservations', format(summary.paidReservations), 'In selected pickup dates', '▤', 'blue'],
      ['processingReservations', 'Processing', format(summary.processingReservations), 'Payment or refund pending', '◷', 'amber'],
      ['cancelledReservations', 'Cancelled', format(summary.cancelledReservations),
        reservationCount ? formatPercent(share(summary.cancelledReservations, BigInt(reservationCount))) + ' of reservations' : 'In selected pickup dates', '×', 'red'],
      ['refundEvents', 'Refunded', format(summary.refundEvents), 'Confirmed refund events · ' + money(summary.refundsCents), '↶', 'purple'],
      ['collectibleCents', 'Unpaid Balances', money(summary.collectibleCents), 'Outstanding collectible', '≋', 'amber']
    ];
    const cards = metrics.map(([key, label, value, hint, symbol, tone]) => {
      const card = node('div', undefined, 'bac-metric bac-metric-' + tone);
      card.dataset.chartMetric = key;
      const icon = node('span', symbol, 'bac-metric-icon');
      icon.setAttribute('aria-hidden', 'true');
      const amount = node('dd', value, 'bac-metric-value');
      if (summary[key] == null) amount.dataset.unavailable = '';
      card.append(node('dt', label), amount, node('dd', hint, 'bac-metric-hint'));
      card.firstChild.append(icon);
      return card;
    });
    const target = byId('chartsMetrics');
    target.replaceChildren(...cards);
    const totals = byId('chartsFinancialContext');
    const net = node('span', 'Net collected payments ');
    net.append(node('strong', money(summary.netCollectedCents)));
    const gross = node('span', 'Gross accepted booking value ');
    gross.append(node('strong', money(summary.grossAcceptedCents)));
    totals.replaceChildren(net, gross);
  }

  function renderTrend(trend, total) {
    const target = byId('chartsTrend');
    target.replaceChildren();
    if (!trend || total === null) { target.append(chartMessage(unavailablePayments)); return; }
    if (BigInt(total) === 0n) { target.append(chartMessage(noPayments)); return; }
    const {buckets, granularity} = trend;
    const cents = buckets.map(bucket => BigInt(bucket.collectedCents));
    if (cents.reduce((sum, amount) => sum + amount, 0n) !== BigInt(total)) {
      target.append(chartMessage(unavailablePayments));
      return;
    }
    const peak = cents.reduce((max, value) => max < value ? value : max, 0n);
    const magnitude = 10n ** BigInt(peak.toString().length - 1);
    const rounded = ((peak + magnitude - 1n) / magnitude) * magnitude;
    const axisStep = (rounded + 3n) / 4n;
    const axis = node('div', undefined, 'bac-axis');
    for (let tick = 4n; tick >= 0n; tick--) axis.append(node('span', money(tick * axisStep).replace(/\.00$/, '')));
    const long = granularity === 'month' && buckets.length > 24;
    const spansYears = buckets[0].from.slice(0, 4) !== buckets.at(-1).from.slice(0, 4);
    const ticks = [3, 5, 8, 12].map(limit => {
      const count = Math.min(buckets.length, limit);
      return new Set(Array.from({length: count}, (_, index) =>
        Math.round(index * (buckets.length - 1) / Math.max(1, count - 1))));
    });
    const scroll = node('div', undefined, 'bac-trend-scroll');
    const plot = node('div', undefined, long ? 'bac-plot bac-plot-long' : 'bac-plot');
    plot.setAttribute('aria-hidden', 'true');
    plot.style.setProperty('--bac-buckets', buckets.length);
    const bars = node('ol', undefined, 'bac-bars');
    const exact = node('details', undefined, 'bac-trend-values');
    const values = node('ol', undefined, 'bac-trend-data');
    exact.append(node('summary', 'View exact trend values'), values);
    for (const [index, bucket] of buckets.entries()) {
      const label = chartDate(bucket, granularity);
      const value = money(cents[index]);
      const item = node('li', undefined, 'bac-bar-item');
      item.title = label + ' · ' + value;
      const track = node('div', undefined, 'bac-bar-track');
      const bar = node('span', undefined, 'bac-vertical-bar');
      bar.style.setProperty('--bac-height', formatPercent(share(cents[index], axisStep * 4n)));
      track.append(bar);
      const day = parseDay(bucket.from);
      const tick = node('span', spansYears ? label : granularity === 'month' ? axisMonth.format(day) : shortDate.format(day), 'bac-bar-label');
      ticks.forEach((indices, size) => { if (indices.has(index)) tick.classList.add('bac-tick-' + size); });
      if (long && (index % 2 === 0 || index === buckets.length - 1)) tick.classList.add('bac-tick-long');
      item.append(track, tick);
      bars.append(item);
      values.append(node('li', label + ' · ' + value));
    }
    plot.append(axis, bars);
    scroll.append(plot);
    if (long) {
      scroll.tabIndex = 0;
      scroll.setAttribute('aria-label', 'Scrollable payments chart. Exact values follow.');
    }
    target.append(scroll, exact);
  }

  function renderServices(services, total) {
    const target = byId('chartsServices');
    target.replaceChildren();
    if (!services || total === null) { target.append(chartMessage(unavailablePayments)); return; }
    const asCents = BigInt(total);
    if (!asCents) { target.append(chartMessage(noPayments)); return; }
    if (services.reduce((sum, entry) => sum + BigInt(entry.cents), 0n) !== asCents) {
      target.append(chartMessage(unavailablePayments));
      return;
    }
    const layout = node('div', undefined, 'bac-service-breakdown');
    const donut = node('div', undefined, 'bac-donut');
    const center = node('div', undefined, 'bac-donut-center');
    donut.setAttribute('aria-hidden', 'true');
    center.append(node('strong', money(total)), node('span', 'Collected'));
    donut.append(center);
    const legend = node('ul', undefined, 'bac-legend');
    legend.setAttribute('aria-label', 'Verified payments collected by service, total ' + money(total));
    const order = new Map(Array.from(serviceLabels.keys(), (key, i) => [key, i]));
    const slices = [];
    let cumulative = 0n;
    for (const entry of [...services].sort((a, b) => (order.get(a.service) ?? 4) - (order.get(b.service) ?? 4))) {
      const [label, color] = serviceLabels.get(entry.service) || serviceLabels.get('unclassified');
      const start = share(cumulative, asCents);
      cumulative += BigInt(entry.cents);
      slices.push(color + ' ' + formatPercent(start) + ' ' + formatPercent(share(cumulative, asCents)));
      const row = node('li');
      const swatch = node('span', undefined, 'bac-swatch');
      swatch.setAttribute('aria-hidden', 'true');
      swatch.style.setProperty('--bac-color', color);
      row.append(swatch, node('span', label), node('span', formatPercent(share(entry.cents, asCents))), node('strong', money(entry.cents)));
      legend.append(row);
    }
    donut.style.setProperty('--bac-slices', 'conic-gradient(' + slices.join(', ') + ')');
    layout.append(donut, legend);
    target.append(layout);
  }

  function renderRecent(trips) {
    const target = byId('chartsRecent');
    target.replaceChildren();
    if (!trips.length) { target.append(chartMessage(noTrips)); return; }
    const labels = ['Booking reference', 'Trip date', 'Service', 'Payment status', 'Accepted Fare'];
    const table = node('table', undefined, 'bac-recent-table');
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', 'Recent Reservations');
    const head = node('thead'), headings = node('tr'), body = node('tbody');
    for (const label of labels) {
      const heading = node('th', label);
      heading.scope = 'col';
      headings.append(heading);
    }
    head.append(headings);
    body.setAttribute('role', 'rowgroup');
    for (const trip of trips) {
      const row = node('tr');
      row.setAttribute('role', 'row');
      const ref = node('button', trip.reference, 'bac-reference');
      ref.type = 'button';
      ref.setAttribute('aria-label', 'Open ' + trip.reference + ' in Dispatch');
      ref.addEventListener('click', () => {
        selectAnalyticsView(false);
        if (openTrip) void openTrip(trip);
      });
      const scheduled = node('span', formatted(trip.pickupDate));
      if (trip.pickupAt) scheduled.append(node('span', pickupTime.format(new Date(trip.pickupAt)), 'bac-trip-time'));
      const payment = node('span');
      const paymentKey = Object.hasOwn(paymentLabels, trip.paymentStatus) ? trip.paymentStatus : 'review';
      payment.append(node('span', paymentLabels[paymentKey], 'bac-badge bac-payment-' + paymentKey));
      if (trip.status === 'cancelled') payment.append(node('span', 'Cancelled reservation', 'bac-trip-cancelled'));
      const values = [ref, scheduled, node('span', (serviceLabels.get(trip.service) || serviceLabels.get('unclassified'))[0]),
        payment, node('strong', money(trip.fareCents))];
      for (const [index, value] of values.entries()) {
        const cell = node('td');
        cell.setAttribute('role', 'cell');
        cell.dataset.label = labels[index];
        cell.append(value);
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    target.append(table);
  }

  function chartStatusBar(label, count, total, color) {
    const row = node('li', undefined, 'bac-status-row');
    const percent = formatPercent(share(count, BigInt(total)));
    const track = node('span', undefined, 'bac-status-track');
    const fill = node('span', undefined, 'bac-status-fill');
    track.setAttribute('aria-hidden', 'true');
    fill.style.setProperty('--bac-percent', percent);
    fill.style.setProperty('--bac-color', color);
    track.append(fill);
    row.append(node('span', label), track, node('strong', format(count) + ' (' + percent + ')'));
    return row;
  }

  function renderChartStatuses(statuses, total, cancelled) {
    const target = byId('chartsPaymentStatuses');
    target.replaceChildren();
    if (!total) { target.append(chartMessage(noTrips)); return; }
    const list = node('ul', undefined, 'bac-status-list');
    for (const [key, color] of chartStates) {
      const count = statuses[key];
      if (count || !['partially_paid', 'partially_refunded', 'failed'].includes(key)) {
        list.append(chartStatusBar(paymentLabels[key], count, total, color));
      }
    }
    const outcome = node('div', undefined, 'bac-cancellations');
    const cancellationList = node('ul', undefined, 'bac-status-list');
    cancellationList.append(chartStatusBar('Cancelled', cancelled, total, '#d52853'));
    outcome.append(node('h3', 'Reservation outcome · Separate from payment status'), cancellationList);
    target.append(list, outcome);
  }

  function stopChartsRequest() {
    chartsTask?.abort();
    chartsTask = null;
    chartsPanel.removeAttribute('aria-busy');
  }

  function clearCharts() {
    stopChartsRequest();
    clearTimeout(chartsTimer);
    chartsTimer = null;
    chartsReady = false;
    chartsResults.hidden = true;
    chartsStatus.textContent = '';
    for (const id of [...chartTargets, 'chartsFinancialContext']) byId(id).replaceChildren();
    byId('chartsDateControl').open = false;
  }

  function resetCharts() {
    clearCharts();
    chartsDeadline = chartsRequest = null;
    chartsSuspended = false;
  }

  function chartsInForeground() {
    return api && !chartsPanel.hidden && !document.hidden && !chartsBlurred;
  }

  function chartsTimeRemaining() {
    return Math.min(chartsDeadline.wall - Date.now(), chartsDeadline.monotonic - performance.now());
  }

  async function checkChartsSession(task) {
    const wall = Date.now(), monotonic = performance.now();
    const session = await api('/api/admin/session?mode=charts', {signal: task.signal});
    if (chartsTask !== task || !chartsInForeground()) return false;
    const remaining = session.expiresAt - session.serverNow;
    if (session.authenticated !== true || !Number.isSafeInteger(session.expiresAt) ||
        !Number.isSafeInteger(session.serverNow) || remaining <= 0) {
      throw new Error('Unable to verify your Dispatch session.');
    }
    // Anchor at request start so network delays cannot move cleanup past the server deadline.
    chartsDeadline = {wall: wall + remaining, monotonic: monotonic + remaining};
    if (chartsTimeRemaining() <= 0) throw new Error('Session verification took too long.');
    return true;
  }

  function offerChartsReload(message) {
    chartsStatus.textContent = message;
    if (!chartsRequest) return;
    const reload = node('button', 'Reload charts', 'bac-link');
    reload.type = 'button';
    reload.addEventListener('click', () => void loadCharts(chartsRequest.selection, chartsRequest.applyDates));
    chartsStatus.append(' ', reload);
  }

  function handleChartsFailure(error, task, expired = false) {
    // adminFetch clears auth synchronously when the server rejects the session.
    if (!api && error.message === 'Unauthorized') {
      showNotice(expired ? 'Your Dispatch session expired or is no longer authorized. Sign in again.' :
        'Your Dispatch session is no longer authorized. Sign in again.');
    }
    if (chartsTask !== task || task.signal.aborted) return;
    clearCharts();
    offerChartsReload(error.message || 'Unable to verify your Dispatch session.');
  }

  function scheduleChartsExpiry() {
    clearTimeout(chartsTimer);
    chartsTimer = setTimeout(() => {
      if (chartsTimeRemaining() > 0) scheduleChartsExpiry();
      else expireCharts();
    }, Math.max(0, chartsTimeRemaining()));
  }

  function revealCharts() {
    // Rendering can consume the time remaining after a successful status check.
    if (chartsTimeRemaining() <= 0) {
      expireCharts();
      return;
    }
    scheduleChartsExpiry();
    chartsResults.hidden = false;
    chartsStatus.textContent = '';
  }

  function expireCharts() {
    clearCharts();
    chartsDeadline = null;
    chartsStatus.textContent = 'Dispatch session deadline reached. Checking session…';
    if (chartsInForeground()) void revalidateCharts(true);
  }

  async function revalidateCharts(expired = false) {
    stopChartsRequest();
    const task = chartsTask = new AbortController();
    if (!expired) chartsStatus.textContent = 'Checking your Dispatch session…';
    try {
      if (!await checkChartsSession(task) || chartsTask !== task) return;
      if (chartsReady) {
        revealCharts();
      } else {
        // Restoring cleared data requires an explicit request because loading charts renews idle time.
        offerChartsReload('Your Dispatch session is active.');
      }
    } catch (error) {
      handleChartsFailure(error, task, expired);
    } finally {
      if (chartsTask === task) stopChartsRequest();
    }
  }

  function suspendCharts() {
    if (!api || chartsPanel.hidden) return;
    chartsSuspended = true;
    stopChartsRequest();
    chartsResults.hidden = true;
  }

  function resumeCharts(forceCheck = false) {
    if (!chartsInForeground()) return;
    const expired = chartsDeadline && chartsTimeRemaining() <= 0;
    if (!chartsSuspended && !expired && (!forceCheck || chartsTask)) return;
    chartsSuspended = false;
    chartsResults.hidden = true;
    if (expired) expireCharts();
    else void revalidateCharts();
  }

  async function loadCharts(selection, applyDates = false) {
    chartsRequest = {selection, applyDates};
    if (!chartsInForeground()) {
      chartsSuspended = true;
      return;
    }
    clearCharts();
    if (chartsDeadline && chartsTimeRemaining() > 0) scheduleChartsExpiry();
    const task = chartsTask = new AbortController();
    chartsPanel.setAttribute('aria-busy', 'true');
    chartsStatus.textContent = 'Loading charts…';
    try {
      const data = await api(url('/charts', selection), {signal: task.signal});
      if (chartsTask !== task) return;
      if (!await checkChartsSession(task) || chartsTask !== task) return;
      renderChartMetrics(data.summary, data.reservationCount);
      renderTrend(data.trend, data.summary.collectedCents);
      renderServices(data.services, data.summary.collectedCents);
      renderRecent(data.recent);
      renderChartStatuses(data.paymentStatuses, data.reservationCount, data.summary.cancelledReservations);
      chartsFrom.value = data.range.from;
      chartsTo.value = data.range.to;
      byId('chartsDateLabel').textContent = periodLabel(data.range);
      if (applyDates) pendingCurrentDates = {range: data.range, preset: selection.preset};
      chartsReady = true;
      revealCharts();
    } catch (error) {
      handleChartsFailure(error, task);
    } finally {
      if (chartsTask === task) stopChartsRequest();
    }
  }

  function showCharts(active) {
    document.documentElement.classList.toggle('ba-charts-active', active);
    byId('analyticsChartsHeader').hidden = !active;
    byId('analyticsCurrentView').hidden = active;
    chartsPanel.hidden = !active;
    for (const tab of [currentTab, chartsTab]) {
      const selected = tab === (active ? chartsTab : currentTab);
      tab.tabIndex = selected ? 0 : -1;
      tab.setAttribute('aria-selected', String(selected));
    }
  }

  function selectAnalyticsView(active) {
    if (!api || active !== chartsPanel.hidden) return;
    if (active) {
      currentScroll = scrollArea.scrollTop;
      showCharts(true);
      scrollArea.scrollTop = 0;
      const range = applied;
      chartsPreset.value = appliedPreset || preset.value;
      chartsFrom.value = range?.from || from.value;
      chartsTo.value = range?.to || to.value;
      byId('chartsDateLabel').textContent = range ? periodLabel(range) : 'Select dates';
      void loadCharts(range ? dateSelection('custom', range.from, range.to) :
        dateSelection(preset.value, from.value, to.value));
      return;
    }
    resetCharts();
    showCharts(false);
    scrollArea.scrollTop = currentScroll;
    if (pendingCurrentDates) {
      const {range, preset: nextPreset} = pendingCurrentDates;
      pendingCurrentDates = null;
      preset.value = nextPreset;
      from.value = range.from;
      to.value = range.to;
      void loadDates(dateSelection('custom', range.from, range.to), true);
    }
  }

  for (const tab of [currentTab, chartsTab]) {
    tab.addEventListener('click', () => selectAnalyticsView(tab === chartsTab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? currentTab : event.key === 'End' ? chartsTab :
        tab === currentTab ? chartsTab : currentTab;
      selectAnalyticsView(next === chartsTab);
      next.focus();
    });
  }
  for (const control of [chartsFrom, chartsTo]) control.addEventListener('input', () => { chartsPreset.value = 'custom'; });
  chartsPreset.addEventListener('change', () => {
    if (chartsPreset.value === 'custom') chartsFrom.focus();
  });
  byId('chartsDateForm').addEventListener('submit', event => {
    event.preventDefault();
    const selection = dateSelection(chartsPreset.value, chartsFrom.value, chartsTo.value);
    if (selection.preset === 'custom' && (!selection.from || !selection.to || selection.from > selection.to)) {
      chartsStatus.textContent = 'Select a valid start and end date.';
      return;
    }
    byId('chartsDateControl').open = false;
    byId('chartsDateControl').querySelector('summary').focus();
    void loadCharts(selection, true);
  });
  byId('chartsBackToDispatch').addEventListener('click', () => {
    selectAnalyticsView(false);
    scrollArea.scrollTop = 0;
    scrollArea.focus({preventScroll: true});
  });
  byId('chartsReservations').addEventListener('click', () => {
    selectAnalyticsView(false);
    byId('reservationSearch').focus();
  });
  byId('chartsViewAll').addEventListener('click', () => {
    selectAnalyticsView(false);
    byId('analyticsSearch').focus();
  });
  byId('chartsSignOut').addEventListener('click', () => byId('logoutBtn').click());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspendCharts();
    else resumeCharts();
  });
  window.addEventListener('blur', () => {
    chartsBlurred = true;
    suspendCharts();
  });
  window.addEventListener('focus', () => {
    chartsBlurred = false;
    resumeCharts(true);
  });
  window.addEventListener('pagehide', () => {
    resetCharts();
    showCharts(false);
  });

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
    resetCharts();
    showCharts(false);
    pendingCurrentDates = appliedPreset = null;
    byId('chartsDateForm').reset();
    byId('chartsDateLabel').textContent = 'Select dates';
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
