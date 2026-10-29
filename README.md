# ER Limousine Service — Booking, Payment & Dispatch MVP

This is a working starter project for **ER Limousine Service LLC**.

It includes:

- Luxury customer website
- Pickup / destination / date / time booking form
- Live route-based quote using Google Routes API
- Server-side fare calculation
- Stripe Checkout payment
- Stripe webhook payment confirmation
- Customer reservation confirmation page
- Private dispatch dashboard
- Driver / vehicle assignment
- Trip status updates
- Transactional PostgreSQL reservation storage

## 1. What you need before going live

Create:

1. A **Stripe** account
2. A **Google Cloud** project with the **Routes API** enabled
3. A web host that can run Node.js 20+ (for example Render, Railway, Fly.io, or a VPS)
4. Your domain pointed to that host

## Reservation storage

The server now requires PostgreSQL and a privately configured `DATABASE_URL`, including local development. There is no JSON fallback. See [storage deployment, legacy import, retention and backups](docs/reservation-storage.md) before deploying or starting the updated server.

## 2. Local setup

Install Node.js 20 or newer and pnpm 11.25.0.

Use the committed `pnpm-lock.yaml` for reproducible installs; keep secrets in an ignored `.env` file and reservation data in the ignored `data/` directory.

Then:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

Edit `.env` and add your real keys.

Start the site:

```bash
pnpm start
```

Open:

- Customer site: `http://localhost:3000`
- Dispatch dashboard: `http://localhost:3000/admin.html`

## 3. Stripe setup

Put your Stripe secret key in:

```env
STRIPE_SECRET_KEY=sk_test_...
```

For local webhook testing, use Stripe CLI:

```bash
stripe listen --forward-to localhost:3000/api/stripe-webhook
```

Copy the returned signing secret into:

```env
STRIPE_WEBHOOK_SECRET=whsec_...
```

For production, create a webhook endpoint in Stripe for:

`https://YOUR-DOMAIN.com/api/stripe-webhook`

Listen for:

`checkout.session.completed`

## 4. Google Routes API

Automatic interstate-only route-toll calculation is implemented behind the disabled-by-default
`ROUTE_TOLLS_ENABLED` flag. NJ E-ZPass business/Suburban 2Ax is confirmed;
commercial-rate equivalence and congestion coverage must be verified before
activation. Hourly booking retains its existing behavior when the complete route
is unknown. Same-state trips add no tolls based on verified
provider endpoint states. The qualifying EWR → Manhattan special remains $150,
tolls included. See [toll policy, configuration, costs and tests](docs/route-tolls.md).

### Current pickup location

The booking form offers **📍 Use My Current Location** before pickup suggestions
and when the pickup is empty. Only a customer click requests browser location
permission. HTTPS (or localhost during development) and device/browser location
services are required. The customer should check the resulting street address.

Enable **Geocoding API** in the existing Google Cloud project, confirm billing is
enabled, and allow that API in the existing server key's API restrictions. Keep
the existing Places API (New) and Routes API enabled. This feature uses the same
private `GOOGLE_MAPS_API_KEY`; it needs no browser API key, Maps JavaScript SDK,
Google Geolocation API, new database schema, or change to fares/airport offers.
Setup reference: [Google Geocoding API setup](https://developers.google.com/maps/documentation/geocoding/guides-v3/get-api-key).

`POST /api/reverse-geocode` accepts only finite latitude/longitude numbers in
range, with exact same-origin JSON and safe Fetch Metadata. The endpoint is
limited to 20 requests/minute and 100/hour per existing trusted-client limits,
uses the existing eight-second provider timeout, and returns only a street
address and optional compatible Place ID. Query parameters are rejected. Missing
configuration, denied provider access, quota errors and unavailable results fall
back to manual pickup entry. Permission policy permits geolocation only on the
booking documents, retaining the existing restrictions on other pages.

Coordinates are transient request data sent to Google for reverse geocoding.
The application does not put them in browser URLs/storage, application logs,
reservation records or the database. Responses are no-store/no-referrer. No
continuous tracking or automatic location request is used. Typing/selecting a
pickup, changing trip/terminal, resetting the form or leaving the page invalidates
pending work; a late result cannot replace a newer pickup. GPS and provider work
are bounded, and errors leave manual pickup/drop-off entry available.

Run `node --test --test-concurrency=1 tests/pickup-location.test.cjs tests/security-abuse.test.cjs tests/book-again.test.cjs tests/seo.test.cjs`
for mocked location, autocomplete, quoting, airport-offer and restoration checks.

Enable **Routes API** in Google Cloud and add the server API key:

```env
GOOGLE_MAPS_API_KEY=...
```

The server sends pickup and drop-off addresses to Google Routes to get estimated miles and driving time.

## 5. Your pricing

Edit `pricing.js`.

You can change:

- base fare
- price per mile
- price per minute
- minimum fare
- airport surcharge
- late-night surcharge
- toll allowance
- gratuity percentage
- passenger limits

The fare is always recalculated on the server before Stripe Checkout, so a customer cannot simply edit the price in their browser.

## 6. Admin / dispatch

Set a strong value:

```env
ADMIN_TOKEN=use-a-long-random-secret
```

Go to:

`/admin.html`

The dashboard allows you to:

- see reservations
- see payment status
- assign a driver
- enter driver phone
- assign vehicle
- enter plate
- update trip status

## 7. Before accepting real customers

This MVP is intentionally simple. Before larger-scale production use, upgrade these items:

- Replace JSON booking storage with PostgreSQL
- Add administrator accounts instead of one shared token
- Add customer email / SMS confirmations
- Add driver login and driver acceptance
- Add flight tracking
- Add toll calculation
- Add cancellation / refund rules
- Add corporate accounts
- Add rate zones / fixed airport rates
- Add Terms, Privacy Policy, cancellation policy and required business/licensing disclosures
- Add monitoring, backups and error logging

## Suggested Phase 2

The next build can add the same workflow you see in chauffeur groups:

**New paid job → owner dispatch board → offer job to chauffeur → chauffeur accepts → customer gets driver details → trip completed → driver payout recorded.**
