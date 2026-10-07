# Technical SEO foundation

Production canonical origin: **https://erlimousineservice.com**.

## Audit and scope

The homepage is currently the only public indexable HTML page. Fleet, service,
about, contact and booking sections are anchors on that page, not separate URLs.
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

`services/public-seo.js` loads the public homepage once at startup and optionally
adds a normalized US telephone from the existing public `COMPANY_PHONE` setting.
Absent or invalid settings omit telephone; the module does not read secrets or
invent a placeholder number. It never includes request/customer/reservation data.
The JSON is escaped and its exact hash is added to the **homepage-only** CSP.
Other pages keep their existing CSP, including the confirmation-script hash and
the dedicated Stripe Elements/reset-page policies. No script unsafe-inline/eval or
new external origins are allowed. No new environment variable is required.

## Crawling and indexing

`public/sitemap.xml` currently contains exactly:

- `https://erlimousineservice.com/`

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

## Next public pages — planning only

1. **New Jersey → New York City Car Service**, explicitly NJ-origin service.
2. **EWR transportation**, strictly the EWR operations already supported, including
   the existing eligible EWR → Manhattan offer without expanding its terms.
3. **New Jersey private car / limousine service**.
4. **New Jersey airport drop-off pages** only after JFK/LGA operating authority is
   confirmed.

**JFK/LGA pickup marketing must not be published without confirmation of operating
authority.** Do not advertise "to and from JFK/LaGuardia", unrestricted JFK/LGA
transportation or NYC-origin pickup service. Do not place legal/licensing claims
in public copy. None of these landing pages are created in this phase.

## After an approved deployment

Verify domain ownership in Google Search Console, submit `/sitemap.xml`, use URL
Inspection on the homepage and request recrawling. Monitor canonical selection and
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
