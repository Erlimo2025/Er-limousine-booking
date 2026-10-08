# Technical SEO foundation

Production canonical origin: **https://erlimousineservice.com**.

## Audit and scope

Public indexable HTML now consists of the homepage, the approved
`/new-jersey-to-nyc-car-service` page and `/newark-airport-ewr-car-service`.
Fleet, general service, about,
contact and booking sections remain anchors on the homepage.
The initial audit found no canonical, Open Graph/Twitter metadata, robots file,
sitemap, structured data or private-page indexing directives. Existing page titles
were distinct, but the homepage title used the older Black SUV label and its
description was long and implied broad New York service. The service banner
advertised EWR/JFK/LGA together. About/footer language could also imply unrestricted
New York-origin pickups.

The homepage now describes New Jersey-origin private transportation, service to
New York City and currently supported EWR transportation. Its existing EWR to
Manhattan offer, booking form/IDs, assets and pricing/payment functionality remain
intact. The misleading three-airport marketing banner is replaced with EWR copy.
No routing, booking eligibility or airport verification changes are part of SEO.

There is one meaningful public H1, existing section H2s, a main landmark, descriptive
fleet image alternatives and working section anchors. The existing design remains.
The homepage's account link still supports customer login; the private dispatch
footer link is marked nofollow. `/index.html` is a duplicate homepage URL and declares
`https://erlimousineservice.com/` as its canonical, as do booking/offer query variants.
No obsolete public landing pages were found. Existing private tools stay available
under their original authentication rules.

## Homepage metadata and schema

Title: **New Jersey Car & Limousine Service | ER Limousine Service**

Description: **Private car and limousine transportation from New Jersey to New York
City, plus supported EWR airport service. Book ER Limousine Service online.**

Canonical, Open Graph and Twitter metadata all describe the same homepage. The
sharing image is the existing public `/suburban-premier-2025.png` fleet photograph;
no new image, fabricated social profile or external script is required.

JSON-LD contains linked **Organization**, **WebSite** and **Service** nodes with
stable IDs on the canonical origin. The service area is New Jersey and the
description accurately limits marketing to NJ-origin rides and supported EWR
operations. No physical address, business hours, reviews/ratings, awards or schema
prices are invented. Organization is used rather than claiming address-based
LocalBusiness rich-result eligibility without an authoritative physical address.

`services/public-seo.js` loads the allowlisted public templates once at startup and optionally
adds a normalized US telephone from the existing public `COMPANY_PHONE` setting.
Absent or invalid settings omit telephone; the module does not read secrets or
invent a placeholder number. It never includes request/customer/reservation data.
The JSON is escaped and its exact hash is added to that **public page's** CSP.
Other pages keep their existing CSP, including the confirmation-script hash and
the dedicated Stripe Elements/reset-page policies. No script unsafe-inline/eval or
new external origins are allowed. No new environment variable is required.

## Crawling and indexing

`public/sitemap.xml` currently contains exactly:

- `https://erlimousineservice.com/`
- `https://erlimousineservice.com/new-jersey-to-nyc-car-service`
- `https://erlimousineservice.com/newark-airport-ewr-car-service`

It omits private pages, API URLs, query variants, fragments and duplicate
`/index.html`. It has no invented last-modified dates. Add approved future public
pages as separate URL entries with their HTTPS canonicals when those pages exist.

`public/robots.txt` permits public pages and assets, disallows `/api/` and
`/internal/`, and points to the production sitemap. Private HTML is deliberately
crawlable so search engines can read its noindex directives. Robots rules are not
access control: authentication and reservation ownership still protect all data.

These HTML pages declare `noindex, nofollow`:

- `/account.html` (login, registration, recovery and account views)
- `/admin.html` (dispatch shell)
- `/payment-methods.html`
- `/success.html`
- `/reset-password.html`

Server `X-Robots-Tag: noindex, nofollow` also covers those paths, `/account/*`
(including the authenticated dashboard), `/api/*` and `/internal/*`, including
unauthenticated responses and redirects. Existing no-store, no-referrer and
authentication controls are preserved. Private pages are not given indexable
canonicals or social-sharing metadata.

## New Jersey → New York City landing page

The approved clean URL is `/new-jersey-to-nyc-car-service`. The `.html` file URL
redirects permanently to it; a trailing slash or query variant declares the same
clean canonical. This is an indexable public page with unique title/description,
Open Graph/Twitter metadata and linked Organization, WebPage and Service JSON-LD.
The schema describes New Jersey-origin transportation to NYC and uses the same
validated public telephone handling as the homepage. FAQ answers are visible
native disclosure elements; no FAQ rich-result claims or FAQ schema are added.

The page reuses the existing navy/gold/white design and Suburban/Escalade fleet
assets. Its dedicated CSS is scoped to landing-page components. There is no
executable JavaScript, additional font, tracking script, new booking form or
external dependency. Images have intrinsic dimensions; below-fold vehicle
images are lazy-loaded. Check the rendered page at 320px, 390px and 1440px after
visual changes, including keyboard focus, FAQ expansion and booking navigation.

Sections cover the one-way NJ-origin service, supported booking/account features,
NYC destinations, existing vehicles, booking steps, five FAQs and booking CTAs.
Manhattan, Midtown, Times Square and Lower Manhattan are destinations, never
advertised pickup locations. No NYC-origin return/round-trip service or JFK/LGA
pickup service is advertised. No rates, ratings, years, availability guarantees
or operating-authority claims are added.

Every booking CTA points to `/#book`. The current booking flow has no general
marketing-route prefill mechanism, so no route, Place ID, offer, fare, passenger
count, date or vehicle is forced from this page. Customers choose/review all trip
fields and receive the normal server-calculated quote, then Pay Now/Pay Later.
The page links to the public homepage, booking, EWR page and contact section; it has no
private account/admin/payment/recovery links. The homepage About section links
naturally to this new service page. No application/business behavior is changed.

## Newark Airport (EWR) landing page

`/newark-airport-ewr-car-service` markets pickups originating at Newark Liberty
International Airport, New Jersey, to Manhattan/New York City, New Jersey,
Connecticut and Pennsylvania. Its title is **Newark Airport Car Service | ER
Limousine Service**. Canonical/social URLs use the extensionless production URL;
the `.html` alias redirects to it. The sitemap includes this third public page,
and existing robots/private-page noindex behavior remains unchanged.

It shares the landing-page CSS and real Suburban/Escalade photographs; EWR-only
styles live in `public/ewr-car-service.css`. There is no executable script on the
landing page. It has one H1, a prominent Manhattan offer, four destination cards,
terminal/pickup guidance, the current two-vehicle fleet, six booking steps and
eight native, keyboard-accessible FAQs. Organization/WebPage/Service JSON-LD uses
the same validated public phone and exact page-specific CSP hash. General-service
metadata/schema intentionally has no price or Offer node implying a flat fare for
all destinations. No FAQ rich-result claims are added.

The **$150 flat rate** is existing public display information only: qualifying
one-way **EWR → Manhattan**, **Chevrolet Suburban Premier / Luxury SUV / `suv`**,
up to six passengers. The offer does not cover all NYC destinations, NJ/CT/PA,
Escalade, reverse trips or other airports. FIRST15 stays excluded. NJ/CT/PA cards
link to normal quoting and contain no flat/city-specific prices.

General CTAs use `/#book`. Special CTAs use `/#ewr-manhattan-special`. A small
homepage initialization hook recognizes only that fragment and invokes the
**existing** `activateEwrManhattanSpecial()` selection function, then replaces the
fragment with `#book`. It adds no pricing or authorization rule, query-parameter
trust, provider request, reservation creation or automatic payment. The existing
function selects the General EWR identity and Suburban, leaves destination and
schedule for customer review, and disables promotions for the special. Explicit
Book Again input takes precedence, and stale initialization after pagehide cannot
apply the landing selection. Other booking entry paths are unchanged.

Quote and Checkout still require the exact approved EWR identity and provider
verification, verified Manhattan destination, eligible one-way/airport journey
and `suv`. A/B keep their own verified IDs; C uses the existing exact-C-only General
verification/routing fallback; General remains unchanged. Manual address edits
still clear identity. No pricing, FIRST15, vehicle, payment or ownership code changes.

Pickup copy reflects the current Airport form: Terminal A/B/C or Not sure / EWR
General, date/time, optional flight number and notes, and eligible time changes
in My Trips when signed in. No automatic flight tracking, meet-and-greet, waiting
time, baggage-help or availability guarantees are invented. No JFK/LGA or NYC-origin
pickup marketing is added. The homepage EWR service banner links to this page;
both public landing-page footers link to one another with their origin direction
clearly named. No private URLs are linked from either landing page.

## Next public pages

1. **New Jersey → New York City Car Service** is implemented locally for review.
2. **EWR transportation** is implemented locally for review, including the existing
   eligible EWR → Manhattan offer without expanding its terms.
3. **New Jersey private car / limousine service**.
4. **New Jersey airport drop-off pages** only after JFK/LGA operating authority is
   confirmed.

**JFK/LGA pickup marketing must not be published without confirmation of operating
authority.** Do not advertise "to and from JFK/LaGuardia", unrestricted JFK/LGA
transportation or NYC-origin pickup service. Do not place legal/licensing claims
in public copy. General NJ and airport drop-off pages remain planning only.

## After an approved deployment

Verify domain ownership in Google Search Console, submit `/sitemap.xml`, use URL
Inspection on the homepage and new landing page and request recrawling. Monitor canonical selection and
the Page Indexing report for excluded private pages; previously indexed private
URLs need recrawling before noindex is observed. Validate the deployed JSON-LD
with Google's Rich Results Test and the Schema.org validator; markup does not
guarantee a special search appearance. Check that configured company telephone
matches the real public contact number. This local work does not change Search
Console, DNS, Render or production settings.

References: [Google noindex guidance](https://developers.google.com/search/docs/crawling-indexing/block-indexing),
[sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap),
[Organization structured data](https://developers.google.com/search/docs/appearance/structured-data/organization),
[Schema.org Service](https://schema.org/Service).

## Local validation

Run `node --test --test-concurrency=1 tests/seo.test.cjs tests/security-abuse.test.cjs`
for metadata, canonical, schema, indexing controls, privacy, security headers and
booking/account/admin regressions. Run `npm test` for the full sequential suite
and the existing PostgreSQL integration suites with the isolated
`ER_TEST_DATABASE_URL` configured. No external Google/Stripe/Resend calls are
required for these tests.
