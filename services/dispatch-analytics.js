'use strict';

const ZONE = 'America/New_York';
const DAY = 86400000;
const LAST_DAY = Date.parse('9999-12-31T00:00:00Z') / DAY;
const RESERVATION_STATUSES = ['awaiting_payment', 'confirmed', 'assigned', 'driver_en_route', 'passenger_on_board', 'completed', 'cancelled'];
const PAYMENT_STATUSES = ['unpaid', 'failed', 'processing', 'paid', 'partially_paid', 'refunded', 'partially_refunded', 'review'];
const VEHICLES = {suv: 'Luxury SUV / Suburban', escalade: 'Cadillac Escalade'};
const SORT_KEYS = ['reference', 'pickupDate', 'pickup', 'destination', 'vehicle', 'status', 'payment', 'fare', 'captured', 'refunded'];

const nyDate = new Intl.DateTimeFormat('en-CA', {timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit'});
function calendarDate(now) {
  const parts = Object.fromEntries(nyDate.formatToParts(now).map(({type, value}) => [type, value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function dayNumber(date) {
  if (typeof date !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) || date.startsWith('0000')) return NaN;
  const ms = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? ms / DAY : NaN;
}
const dateAt = day => new Date(day * DAY).toISOString().split('T')[0];
const shift = (date, days) => dateAt(dayNumber(date) + days);
const monthStart = date => date.slice(0, 7) + '-01';
function moveMonth(date, months) {
  const first = new Date(dayNumber(monthStart(date)) * DAY);
  first.setUTCMonth(first.getUTCMonth() + months);
  return first.toISOString().split('T')[0];
}
const monthEnd = date => dateAt(Date.parse(moveMonth(date, 1) + 'T00:00:00Z') / DAY - 1);
const weekStart = date => shift(date, -((new Date(dayNumber(date) * DAY).getUTCDay() + 6) % 7));
const range = (from, to = from) => ({from, to});

function presetsAt(now) {
  const today = calendarDate(now);
  const yesterday = shift(today, -1);
  const monday = weekStart(today);
  const month = monthStart(today);
  const lastMonth = moveMonth(month, -1);
  const year = Number(today.slice(0, 4));
  return {
    today: range(today), yesterday: range(yesterday),
    thisWeek: range(monday, shift(monday, 6)), lastWeek: range(shift(monday, -7), shift(monday, -1)),
    thisMonth: range(month, monthEnd(month)), lastMonth: range(lastMonth, shift(month, -1)),
    thisYear: range(year + '-01-01', year + '-12-31'), lastYear: range((year - 1) + '-01-01', (year - 1) + '-12-31')
  };
}

function invalid(message) {
  return Object.assign(new Error(message), {status: 400, analyticsInput: true});
}
function ensureKeys(input, allowed) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw invalid('Invalid analytics filters.');
}

function dates(input) {
  if (!Number.isFinite(dayNumber(input.from)) || !Number.isFinite(dayNumber(input.to)) || input.from > input.to) {
    throw invalid('Choose a valid From Date and To Date in order.');
  }
  return range(input.from, input.to);
}

function comparisonPeriod({from, to}, days) {
  const wholeMonths = from.endsWith('-01') && to === monthEnd(to);
  const count = wholeMonths ?
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1 :
    days;
  const first = wholeMonths ? moveMonth(from, -count) : shift(from, -count);
  if (!Number.isFinite(dayNumber(first))) return null;
  return {range: range(first, shift(from, -1)), basis: {unit: wholeMonths ? 'month' : 'day', count}};
}

function summaryInput(input, now) {
  ensureKeys(input, ['preset', 'from', 'to']);
  const presets = presetsAt(now);
  const preset = input.preset ?? (input.from === undefined && input.to === undefined ? 'thisMonth' : 'custom');
  if (typeof preset !== 'string' || (preset !== 'custom' &&
      (!Object.hasOwn(presets, preset) || input.from !== undefined || input.to !== undefined))) {
    throw invalid('Choose a supported date filter.');
  }
  const selected = preset === 'custom' ? dates(input) : presets[preset];
  const days = dayNumber(selected.to) - dayNumber(selected.from) + 1;
  return {selected, previous: comparisonPeriod(selected, days), preset, presets, now,
    granularity: days <= 31 ? 'day' : days <= 120 ? 'week' : 'month'};
}

function selection(value, values, fallback) {
  if (value === undefined) return fallback;
  if (!values.includes(value)) throw invalid('Invalid trip report filters.');
  return value;
}
function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,14}$/.test(value) || Number(value) > max) {
    throw invalid('Invalid trip report page.');
  }
  return Number(value);
}

function tripsInput(input, now, exporting = false) {
  const fields = ['from', 'to', 'search', 'status', 'payment', 'vehicle', 'sort', 'order'];
  ensureKeys(input, exporting ? fields : [...fields, 'page', 'limit']);
  const search = input.search ?? '';
  if (typeof search !== 'string' || search.length > 120 || /[\x00-\x1f\x7f]/.test(search)) {
    throw invalid('Enter up to 120 characters to search trips.');
  }
  const limit = integer(input.limit, 25, 100);
  return {
    ...dates(input), now, search: search.trim(),
    status: selection(input.status, ['all', ...RESERVATION_STATUSES], 'all'),
    payment: selection(input.payment, ['all', ...PAYMENT_STATUSES], 'all'),
    vehicle: selection(input.vehicle, ['all', ...Object.keys(VEHICLES)], 'all'),
    sort: selection(input.sort, SORT_KEYS, 'pickupDate'),
    order: selection(input.order, ['asc', 'desc'], 'desc'),
    page: integer(input.page, 1, Math.floor(Number.MAX_SAFE_INTEGER / limit)), limit
  };
}

const includes = (period, day) => period.from <= day && day <= period.to;
const overlaps = (period, issue) => issue.day <= period.to && issue.last_day >= period.from;
const money = (values, incomplete) => incomplete || values.some(row => Number(row.missing) > 0) ? null :
  values.reduce((sum, row) => sum + BigInt(row.cents), 0n).toString();
const count = values => values.reduce((sum, row) => sum + Number(row.count), 0);
const byKind = (rows, kind, state) => rows.filter(row => row.kind === kind && (state === undefined || row.state === state));

function summarize(rows, issues) {
  const trips = byKind(rows, 'pickup');
  const completed = byKind(trips, 'pickup', 'completed');
  const cancelled = byKind(trips, 'pickup', 'cancelled');
  const collectedCents = money(byKind(rows, 'capture'), issues.some(row => row.kind === 'payment_gap'));
  const refundsCents = money(byKind(rows, 'refund'), issues.some(row => row.kind === 'refund_gap'));
  const completedValueCents = money(completed);
  const completedCount = count(completed);
  const tripCount = count(trips);
  const cancelledCount = count(cancelled);
  return {
    bookingsReceived: count(byKind(rows, 'received')),
    completedRides: completedCount, cancelledRides: cancelledCount,
    upcomingRides: count(byKind(rows, 'upcoming')), pendingReservations: count(byKind(trips, 'pickup', 'awaiting_payment')),
    pendingRequests: count(byKind(rows, 'request', 'pending')), approvedRequests: count(byKind(rows, 'request', 'approved')),
    declinedRequests: count(byKind(rows, 'request', 'declined')),
    grossAcceptedCents: money(byKind(rows, 'received')), completedValueCents, collectedCents, refundsCents,
    netCollectedCents: collectedCents === null || refundsCents === null ? null : (BigInt(collectedCents) - BigInt(refundsCents)).toString(),
    collectibleCents: money(byKind(rows, 'balance')),
    averageCompletedCents: completedValueCents === null || completedCount === 0 ? null :
      ((BigInt(completedValueCents) + BigInt(Math.floor(completedCount / 2))) / BigInt(completedCount)).toString(),
    cancellationRateBasisPoints: tripCount === 0 ? null : Math.round(cancelledCount * 10000 / tripCount),
    // Count rows with unavailable evidence without exposing reservation identities.
    coverage: {
      paymentGaps: count(issues.filter(row => row.kind === 'payment_gap')),
      refundGaps: count(issues.filter(row => row.kind === 'refund_gap')),
      unknownBalances: byKind(rows, 'balance').reduce((total, row) => total + Number(row.missing), 0)
    }
  };
}

function bucketStart(date, unit) {
  return unit === 'day' ? date : unit === 'week' ? weekStart(date) : monthStart(date);
}
function bucketEnd(date, unit) {
  return unit === 'day' ? date : unit === 'week' ? dateAt(Math.min(dayNumber(date) + 6, LAST_DAY)) : monthEnd(date);
}

function bucketRows(rows, issues, period, unit, transform) {
  const grouped = new Map();
  for (const row of rows) {
    const start = bucketStart(row.day, unit);
    if (!grouped.has(start)) grouped.set(start, []);
    grouped.get(start).push(row);
  }
  // Long ranges still include every populated month. Filling millennia of empty
  // months would make the report unnecessarily large.
  const sparse = unit === 'month' && dayNumber(period.to) - dayNumber(period.from) > 3660;
  if (!sparse) {
    for (let day = bucketStart(period.from, unit); day <= period.to;) {
      if (!grouped.has(day)) grouped.set(day, []);
      const end = bucketEnd(day, unit);
      if (end >= period.to) break;
      day = shift(end, 1);
    }
  }
  return {sparse, buckets: [...grouped.keys()].sort().map(day => {
    const end = bucketEnd(day, unit);
    const bounded = range(day < period.from ? period.from : day, end > period.to ? period.to : end);
    return {...bounded, ...transform(grouped.get(day), issues.filter(issue => overlaps(bounded, issue)))};
  })};
}

function growth(current, previous) {
  return Object.fromEntries(['bookingsReceived', 'completedRides', 'completedValueCents', 'collectedCents'].map(key => {
    const before = previous[key], after = current[key];
    if (before === null || after === null) return [key, {kind: 'unavailable'}];
    const baseline = BigInt(before);
    const difference = BigInt(after) - baseline;
    if (difference === 0n) return [key, {kind: 'no_change'}];
    if (baseline === 0n) return [key, {kind: 'no_prior_activity'}];
    const decrease = difference < 0n;
    const magnitude = decrease ? -difference : difference;
    // Round to the nearest hundredth of a percent before applying the sign.
    const points = (magnitude * 10000n + baseline / 2n) / baseline;
    if (points === 0n) return [key, {kind: 'below_precision', direction: decrease ? 'decrease' : 'increase'}];
    return [key, {kind: 'percent', basisPoints: (decrease ? -points : points).toString()}];
  }));
}

function summaryResult(rows, query) {
  const events = rows.filter(row => !row.last_day);
  const gaps = rows.filter(row => row.last_day);
  const forPeriod = period => events.filter(row => includes(period, row.day));
  const gapsFor = period => gaps.filter(row => overlaps(period, row));
  const {selected, previous, granularity, preset, presets} = query;
  const current = forPeriod(selected);
  const issues = gapsFor(selected);
  const summary = summarize(current, issues);
  const prior = previous ? summarize(forPeriod(previous.range), gapsFor(previous.range)) : null;
  return {
    timeZone: ZONE, range: selected, preset, presets, granularity, summary,
    comparison: prior ? {...previous, summary: prior, growth: growth(summary, prior)} : null,
    activity: bucketRows(current, issues, selected, granularity, (values, warnings) => ({
      completed: count(byKind(values, 'pickup', 'completed')), cancelled: count(byKind(values, 'pickup', 'cancelled')),
      pendingRequests: count(byKind(values, 'request', 'pending')), approvedRequests: count(byKind(values, 'request', 'approved')),
      declinedRequests: count(byKind(values, 'request', 'declined')),
      collectedCents: money(byKind(values, 'capture'), warnings.some(row => row.kind === 'payment_gap'))
    })),
    completedValue: bucketRows(current, [], selected, 'month', values => ({
      cents: money(byKind(values, 'pickup', 'completed'))
    }))
  };
}

const csvColumns = ['Booking reference', 'Pickup date (New York)', 'Pickup', 'Destination', 'Vehicle',
  'Reservation status', 'Payment status', 'Accepted fare (USD)', 'Captured payments (USD)', 'Refunded amount (USD)'];
const csvHeader = csvColumns.join(',') + '\r\n';

function csvText(value) {
  let cell = String(value ?? '');
  if (/^[\p{White_Space}\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(cell)) cell = "'" + cell;
  return '"' + cell.replaceAll('"', '""') + '"';
}
function decimal(cents) {
  if (cents === null) return 'Unavailable';
  const value = BigInt(cents);
  return (value / 100n).toString() + '.' + (value % 100n).toString().padStart(2, '0');
}
function csvTrip(trip) {
  return [
    trip.reference, trip.pickupDate, trip.pickup, trip.destination, trip.vehicleLabel, trip.status,
    trip.paymentStatus
  ].map(csvText).concat([trip.fareCents, trip.capturedCents, trip.refundedCents].map(decimal)).join(',') + '\r\n';
}

module.exports = {ZONE, VEHICLES, summaryInput, tripsInput, summaryResult, csvHeader, csvTrip};
