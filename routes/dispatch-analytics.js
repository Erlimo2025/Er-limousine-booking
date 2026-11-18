'use strict';

const {summaryInput, tripsInput, csvHeader, csvTrip} = require('../services/dispatch-analytics');
const endpoint = '/api/admin/business-analytics';

function installDispatchAnalytics(app, {store, route, rateLimit, requireAdmin, siteUrl, now, securityEvent}) {
  const origin = new URL(siteUrl).origin;
  const exportAudit = Symbol('financial-csv-audit');
  function observeExport(req, res, next) {
    const state = {authorized: false, ready: false, failed: false, recorded: false};
    req[exportAudit] = state;
    const record = outcome => {
      if (state.recorded) return;
      state.recorded = true;
      // Logging must not change export authorization, content or transport behavior.
      try { securityEvent?.(req, 'financial_csv_export', outcome); } catch (_) {}
    };
    res.once('finish', () => {
      if (state.failed) return record('failed');
      if ([401, 403, 429].includes(res.statusCode)) return record(state.authorized ? 'interrupted' : 'denied');
      if (req.aborted) return record('interrupted');
      record(state.ready && res.statusCode < 400 ? 'completed' : 'failed');
    });
    res.once('close', () => record(state.failed ? 'failed' : 'interrupted'));
    next();
  }
  function privateRead(req, res, next) {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin'
    });
    const site = req.get('sec-fetch-site');
    if ((site && !['same-origin', 'none'].includes(site)) ||
        (req.get('origin') && req.get('origin') !== origin)) {
      return res.status(403).json({error: 'Unauthorized'});
    }
    next();
  }

  const protect = (limit, handler) => [privateRead, requireAdmin, rateLimit('business-analytics-' + limit, limit),
    route(async (req, res) => {
      try { await handler(req, res); }
      catch (error) {
        if (!error.analyticsInput) throw error;
        res.status(400).json({error: error.message});
      }
    })];
  const sessionActive = req => req.adminArchiveAuthority.authorized();
  const reply = async (req, res, result) => await sessionActive(req) ? res.json(result) : res.status(401).json({error: 'Unauthorized'});

  app.get(endpoint, ...protect(20, async (req, res) => {
    await reply(req, res, await store.dispatchAnalytics(summaryInput(req.query, now())));
  }));
  app.get(endpoint + '/charts', ...protect(20, async (req, res) => {
    await reply(req, res, await store.dispatchAnalyticsCharts(summaryInput(req.query, now())));
  }));
  app.get(endpoint + '/trips', ...protect(45, async (req, res) => {
    await reply(req, res, await store.dispatchAnalyticsTrips(tripsInput(req.query, now())));
  }));
  app.get(endpoint + '/trips.csv', observeExport, ...protect(4, async (req, res) => {
    const audit = req[exportAudit];
    audit.authorized = true;
    try {
      const input = tripsInput(req.query, now(), true);
      let started = false;
      const active = async () => !res.destroyed && !req.aborted && await sessionActive(req);
      await store.exportDispatchAnalyticsTrips(input, active, async rows => {
        if (!await active()) return;
        const chunk = (started ? '' : csvHeader) + rows.map(csvTrip).join('');
        if (!started) {
          res.set('Content-Type', 'text/csv; charset=utf-8');
          res.attachment('er-dispatch-trips-' + input.from + '_' + input.to + '.csv');
          started = true;
        }
        if (chunk) await new Promise((resolve, reject) => {
          res.write(chunk, error => error ? reject(error) : resolve());
        });
      });
      if (res.destroyed) return;
      if (!await sessionActive(req)) {
        if (started) return res.destroy();
        return res.status(401).json({error: 'Unauthorized'});
      }
      audit.ready = true;
      res.end();
    } catch (error) {
      audit.failed = true;
      throw error;
    }
  }));
}

module.exports = {installDispatchAnalytics};
