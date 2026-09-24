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
- Simple local JSON booking storage

## 1. What you need before going live

Create:

1. A **Stripe** account
2. A **Google Cloud** project with the **Routes API** enabled
3. A web host that can run Node.js 20+ (for example Render, Railway, Fly.io, or a VPS)
4. Your domain pointed to that host

## 2. Local setup

Install Node.js 20 or newer.

Then:

```bash
npm install
cp .env.example .env
```

Edit `.env` and add your real keys.

Start the site:

```bash
npm start
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
