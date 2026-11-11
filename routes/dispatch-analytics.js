'use strict';

const {summaryInput, tripsInput, csvHeader, csvTrip} = require('../services/dispatch-analytics');
const endpoint = '/api/admin/business-analytics';

function installDispatchAnalytics(app, {store, route, rateLimit, requireAdmin, siteUrl, now}) {
  const origin = new URL(siteUrl).origin;
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
  const reply = (req, res, result) => sessionActive(req) ? res.json(result) : res.status(401).json({error: 'Unauthorized'});

  app.get(endpoint, ...protect(20, async (req, res) => {
    reply(req, res, await store.dispatchAnalytics(summaryInput(req.query, now())));
  }));
  app.get(endpoint + '/trips', ...protect(45, async (req, res) => {
    reply(req, res, await store.dispatchAnalyticsTrips(tripsInput(req.query, now())));
  }));
  app.get(endpoint + '/trips.csv', ...protect(4, async (req, res) => {
    const input = tripsInput(req.query, now(), true);
    let started = false;
    const active = () => !res.destroyed && !req.aborted && sessionActive(req);
    await store.exportDispatchAnalyticsTrips(input, active, async rows => {
      if (!active()) return;
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
    if (!sessionActive(req)) {
      if (started) return res.destroy();
      return res.status(401).json({error: 'Unauthorized'});
    }
    res.end();
  }));
}

module.exports = {installDispatchAnalytics};
