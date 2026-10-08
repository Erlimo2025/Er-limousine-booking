const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const testPath = path.join(__dirname, 'security-abuse.test.cjs');
const source = fs.readFileSync(testPath, 'utf8');
const {harness, booking} = new Function('require', '__dirname',
  source.slice(0, source.indexOf('test("approved prices')) + '\nreturn {harness, booking};')(createRequire(testPath), __dirname);
const publicDirectory = path.join(__dirname, '../public');
const origin = 'https://erlimousineservice.com';
const servicePath = '/new-jersey-to-nyc-car-service';
const serviceFile = 'new-jersey-to-nyc-car-service.html';
const serviceTitle = 'New Jersey to NYC Car Service | ER Limousine Service';
const serviceDescription = 'Book private car service from New Jersey to New York City with ER Limousine Service. Choose a luxury SUV, review your quote, and reserve online.';
const ewrPath = '/newark-airport-ewr-car-service';
const ewrFile = 'newark-airport-ewr-car-service.html';
const ewrTitle = 'Newark Airport Car Service | ER Limousine Service';
const ewrDescription = 'Private car service from Newark Airport (EWR) to Manhattan, New Jersey, Connecticut and Pennsylvania. Book your trip with ER Limousine Service.';
const title = 'New Jersey Car &amp; Limousine Service | ER Limousine Service';
const description = 'Private car and limousine transportation from New Jersey to New York City, plus supported EWR airport service. Book ER Limousine Service online.';
const read = file => fs.readFileSync(path.join(publicDirectory, file), 'utf8');
const schemaText = html => html.match(/<script type="application\/ld\+json" id="business-schema">([\s\S]*?)<\/script>/)[1];
const graph = html => JSON.parse(schemaText(html))['@graph'];
const privatePages = ['account.html', 'admin.html', 'payment-methods.html', 'success.html', 'reset-password.html'];

test('homepage has a concise NJ-origin title/description, root canonical and matching social metadata', async t => {
  const h = await harness(t, {SITE_URL: 'https://unrelated.example.test'});
  for (const url of ['/', '/index.html', '/?offer=EWR_MANHATTAN_SUV']) {
    const r = await h.request(url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-robots-tag'), null);
    assert.match(r.body, /<meta name="robots" content="index, follow, max-image-preview:large">/);
    assert.equal(r.body.match(/<title>(.*?)<\/title>/)[1], title);
    assert.equal(r.body.match(/name="description"\s+content="([^"]+)"/)[1], description);
    assert.ok(title.replace('&amp;', '&').length <= 60);
    assert.ok(description.length >= 120 && description.length <= 160);
    assert.equal(r.body.match(/rel="canonical" href="([^"]+)"/)[1], origin + '/');
    assert.equal(r.body.match(/property="og:url" content="([^"]+)"/)[1], origin + '/');
    assert.ok(r.body.includes(`property="og:title" content="${title}"`));
    assert.ok(r.body.includes(`property="og:description" content="${description}"`));
    assert.match(r.body, /property="og:site_name" content="ER Limousine Service"/);
    assert.match(r.body, /name="twitter:card" content="summary_large_image"/);
    assert.ok(!r.body.includes('unrelated.example.test'));
  }
});

test('social sharing uses an existing public fleet image and descriptive image alternatives', async t => {
  const h = await harness(t), r = await h.request('/');
  const image = new URL(r.body.match(/property="og:image" content="([^"]+)"/)[1]);
  assert.equal(image.origin, origin);
  assert.equal(image.pathname, '/suburban-premier-2025.png');
  const response = await fetch(h.url + image.pathname);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /image\/png/);
  assert.match(r.body, /property="og:image:alt" content="Chevrolet Suburban Premier luxury SUV"/);
  for (const tag of r.body.matchAll(/<img\b[^>]*>/g)) assert.match(tag[0], /alt="[^"]+"/);
});

test('structured data is valid, linked and limited to truthful business/site/NJ service information', async t => {
  const h = await harness(t, {COMPANY_PHONE: '(201) 555-0199'}), r = await h.request('/');
  const schema = JSON.parse(schemaText(r.body)), nodes = schema['@graph'];
  assert.equal(schema['@context'], 'https://schema.org');
  assert.deepEqual(nodes.map(item => item['@type']), ['Organization', 'WebSite', 'Service']);
  assert.equal(nodes[0].name, 'ER Limousine Service');
  assert.equal(nodes[0].telephone, '+12015550199');
  assert.equal(nodes[1].publisher['@id'], nodes[0]['@id']);
  assert.equal(nodes[2].provider['@id'], nodes[0]['@id']);
  for (const node of nodes) {
    assert.equal(node.url, origin + '/');
    assert.ok(node['@id'].startsWith(origin + '/#'));
  }
  for (const node of [nodes[0], nodes[2]]) assert.deepEqual(node.areaServed, {'@type': 'State', name: 'New Jersey'});
  for (const field of ['aggregateRating', 'review', 'address', 'openingHours', 'openingHoursSpecification', 'award', 'sameAs', 'priceRange', 'offers']) {
    assert.ok(!JSON.stringify(schema).includes('"' + field + '"'), field);
  }
  assert.equal(h.state.googleCalls, 0);
  assert.equal(h.state.creates.length, 0);
  assert.equal(h.state.payments.calls.length, 0);
});

test('schema omits unconfigured/invalid company telephone and cannot leak configuration or inject scripts', async t => {
  for (const phone of [undefined, '', '555', '</script><script>alert(1)</script>', 'sk_test_synthetic_private_marker', '+442071234567']) {
    const h = await harness(t, {COMPANY_PHONE: phone, STRIPE_SECRET_KEY: 'synthetic-private-stripe-marker', DATABASE_URL: 'synthetic-private-database-marker'});
    const r = await h.request('/');
    assert.ok(!Object.hasOwn(graph(r.body)[0], 'telephone'));
    assert.doesNotMatch(r.body, /synthetic.private|alert\(1\)|442071234567/);
    assert.equal((r.body.match(/<script\b/g) || []).length, 2);
  }
});

test('homepage-only JSON-LD CSP hash preserves all existing browser security directives', async t => {
  const h = await harness(t, {COMPANY_PHONE: '(201) 555-0199'});
  const home = await h.request('/'), api = await h.request('/api/public-config'), confirmation = await h.request('/success.html');
  const hash = crypto.createHash('sha256').update(schemaText(home.body)).digest('base64');
  const csp = home.headers.get('content-security-policy'), original = api.headers.get('content-security-policy');
  assert.equal(csp.replace(` 'sha256-${hash}'`, ''), original);
  assert.equal(confirmation.headers.get('content-security-policy'), original);
  const scriptSrc = csp.split(';').find(value => value.trim().startsWith('script-src '));
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval|https:|\*/);
  for (const directive of ["script-src-attr 'none'", "connect-src 'self'", "frame-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) assert.ok(csp.includes(directive));
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  const confirmationScript = confirmation.body.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n/g, '\n');
  assert.ok(original.includes(`'sha256-${crypto.createHash('sha256').update(confirmationScript).digest('base64')}'`));
});

test('robots permits public pages/assets and crawling private HTML noindex while blocking API/internal crawling', async t => {
  const h = await harness(t), r = await h.request('/robots.txt');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/plain/);
  assert.match(r.body, /^User-agent: \*$/m);
  assert.match(r.body, /^Allow: \/$/m);
  assert.deepEqual([...r.body.matchAll(/^Disallow: (.*)$/gm)].map(match => match[1]), ['/api/', '/internal/']);
  assert.match(r.body, /^Sitemap: https:\/\/erlimousineservice\.com\/sitemap\.xml$/m);
  assert.equal(r.headers.get('x-robots-tag'), null);
});

test('sitemap contains only approved canonical public pages, with no private/transactional/duplicate URLs', async t => {
  const h = await harness(t), r = await h.request('/sitemap.xml');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /xml/);
  assert.match(r.body, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(r.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0.9">/);
  assert.deepEqual([...r.body.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]), [origin + '/', origin + servicePath, origin + ewrPath]);
  assert.equal((r.body.match(/<url>/g) || []).length, 3);
  assert.match(r.body, /<\/urlset>\s*$/);
  assert.doesNotMatch(r.body, /account|admin|dispatch|success|payment-methods|reset-password|login|signup|recovery|api\/|index\.html|jfk|lga/i);
});

test('all private HTML pages and their API/auth surfaces carry noindex without removing no-store', async t => {
  const h = await harness(t);
  assert.deepEqual(fs.readdirSync(publicDirectory).filter(file => file.endsWith('.html')).sort(), ['index.html', serviceFile, ewrFile, ...privatePages].sort());
  for (const page of privatePages) {
    assert.match(read(page), /<meta name="robots" content="noindex, nofollow">/);
    const r = await h.request('/' + page);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  }
  const dashboard = await fetch(h.url + '/account/dashboard', {redirect: 'manual'});
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.get('location'), '/account.html');
  assert.equal(dashboard.headers.get('x-robots-tag'), 'noindex, nofollow');
  for (const url of ['/api/customer/profile', '/api/customer/trips', '/api/bookings/search', '/api/customer/payment-methods', '/api/customer/recovery/request', '/internal/booking-emails']) {
    const r = await h.request(url);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.ok(r.status >= 400, url);
  }
});

test('noindex leaves authenticated account/admin access working and still denies private data to guests', async t => {
  const h = await harness(t);
  const registered = await h.request('/api/customer/register', {fullName: 'SEO Test Owner', email: 'seo-owner@example.test', phone: '2015550199', password: 'Synthetic private test password'});
  assert.equal(registered.status, 201);
  const cookie = registered.headers.getSetCookie().find(value => value.includes('er_customer_session')).split(';')[0];
  const dashboard = await h.request('/account/dashboard', undefined, {cookie});
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.body, /id="dashboardView"/);
  assert.equal(dashboard.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await h.request('/api/customer/profile', undefined, {cookie})).status, 200);
  assert.equal((await h.request('/api/bookings/search', undefined, {cookie})).status, 401);
  assert.equal((await h.request('/api/customer/profile')).status, 401);
  const login = await h.request('/api/admin/login', {token: 'local-test-token'});
  assert.equal(login.status, 200);
  const adminCookie = login.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await h.request('/api/bookings', undefined, {cookie: adminCookie})).status, 200);
});

test('homepage marketing has one meaningful H1, working section links and no JFK/LGA or NYC-origin pickup copy', () => {
  const html = read('index.html');
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  assert.match(html, /<h1>\s*New Jersey Car &amp; Limousine Service\s*<span>Private Rides to New York City<\/span>/);
  assert.match(html, /<main>[\s\S]*<\/main>/);
  for (const link of html.matchAll(/href="#([^"]+)"/g)) assert.ok(html.includes(`id="${link[1]}"`), link[1]);
  assert.doesNotMatch(html, /JFK|LGA|LaGuardia|across New Jersey.*New York|throughout\s*New Jersey and New York|NYC.?origin|New York City pickups/i);
  assert.match(html, /✈ EWR → MANHATTAN/);
  assert.match(html, /LUXURY SUV — \$150 FLAT RATE/);
  assert.match(html, /Chevrolet Suburban Premier Only/);
  assert.match(html, /id="ewrManhattanSpecialBtn"/);
  assert.match(html, /RESERVE & PAY NOW/);
  assert.match(html, /RESERVE & PAY LATER/);
  assert.match(html, /<script src="\/app.js"><\/script>/);
});

test('public SEO reads create no reservation/provider activity and keep authoritative quotes/pay-later intact', async t => {
  const h = await harness(t);
  for (const url of ['/', '/index.html', servicePath, ewrPath, '/robots.txt', '/sitemap.xml']) assert.equal((await h.request(url)).status, 200);
  assert.equal(h.records().length, 0);
  assert.equal(h.state.googleCalls, 0);
  assert.equal(h.state.creates.length, 0);
  assert.equal(h.state.bookingCalls.length, 0);
  const special = {...booking, vehicle: 'suv', offerCode: 'EWR_MANHATTAN_SUV', promoCode: 'FIRST15'};
  const quote = await h.request('/api/quote', special);
  assert.equal(quote.status, 200);
  assert.equal(quote.body.total, 150);
  const reserved = await h.request('/api/checkout', {...special, paymentChoice: 'later', total: 1});
  assert.equal(reserved.status, 200);
  assert.equal(h.state.creates.length, 0);
  assert.equal(h.records()[0].quote.total, 150);
  assert.equal(h.records()[0].paymentStatus, 'unpaid');
});

test('NJ-to-NYC landing page is public/indexable with unique consistent metadata and the clean production canonical', async t => {
  const h = await harness(t);
  for (const url of [servicePath, servicePath + '/', servicePath + '?source=homepage']) {
    const r = await h.request(url);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(r.headers.get('x-robots-tag'), null);
    assert.match(r.body, /name="robots" content="index, follow, max-image-preview:large"/);
    assert.equal(r.body.match(/<title>(.*?)<\/title>/)[1], serviceTitle);
    assert.notEqual(serviceTitle, title);
    assert.ok(serviceTitle.length <= 60);
    assert.ok(serviceDescription.length >= 120 && serviceDescription.length <= 160);
    assert.equal(r.body.match(/name="description" content="([^"]+)"/)[1], serviceDescription);
    assert.notEqual(serviceDescription, description);
    assert.equal(r.body.match(/rel="canonical" href="([^"]+)"/)[1], origin + servicePath);
    assert.equal(r.body.match(/property="og:url" content="([^"]+)"/)[1], origin + servicePath);
    assert.ok(r.body.includes(`property="og:title" content="${serviceTitle}"`));
    assert.ok(r.body.includes(`name="twitter:title" content="${serviceTitle}"`));
    assert.ok(r.body.includes(`property="og:description" content="${serviceDescription}"`));
    assert.match(r.body, /property="og:site_name" content="ER Limousine Service"/);
  }
});

test('landing HTML alias redirects to clean URL and homepage exposes a natural public internal link', async t => {
  const h = await harness(t), response = await fetch(h.url + '/' + serviceFile, {redirect: 'manual'});
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), servicePath);
  const home = await h.request('/');
  assert.match(home.body, /href="\/new-jersey-to-nyc-car-service">Explore our New Jersey to New York City car service →<\/a>/);
  assert.ok(!read('robots.txt').includes('Disallow: ' + servicePath));
});

test('landing CTAs use the existing booking flow with no forced route, price, IDs or private SEO links', async t => {
  const h = await harness(t), r = await h.request(servicePath);
  const links = [...r.body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const book = links.filter(link => /Book Your Ride/.test(link[2]));
  assert.equal(book.length, 5);
  for (const link of book) assert.equal(link[1], '/#book');
  for (const link of links) assert.ok(['/', '/#book', '/#contact', '#vehicles', '#main', ewrPath].includes(link[1]), link[1]);
  assert.doesNotMatch(r.body, /<form|<input|<select|<script\s+src=|customer_id|pickupPlaceId|offerCode|bookingId|stripeSessionId|\/account|\/admin|\/success|\/payment-methods|\/reset-password|\/api\//);
  assert.equal(h.records().length, 0);
  assert.equal(h.state.googleCalls, 0);
  assert.equal(h.state.creates.length, 0);
});

test('landing copy has a single semantic H1, NJ-origin wording only and no unsupported marketing claims', () => {
  const html = read(serviceFile);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<h1 id="route-title">Private Car Service from New Jersey to <span>New York City<\/span><\/h1>/);
  assert.match(html, /<main id="main">/);
  for (const id of ['why-title', 'area-title', 'vehicles-title', 'process-title', 'faq-title', 'ready-title']) assert.match(html, new RegExp('<h2 id="' + id + '">'));
  assert.match(html, /pickup in New Jersey and a destination in New York City/);
  assert.match(html, /New Jersey pickup\. New York City destination\./);
  assert.doesNotMatch(html, /JFK|LGA|LaGuardia|to and from|NYC\s*(?:→|to|[-–—])\s*New Jersey|New York City\s*(?:→|to)\s*New Jersey|round.trip|pickup (?:in|from) (?:NYC|New York City|Manhattan|Midtown|Times Square)|#1|\bbest\b|\bcheapest\b|guarantee|licensed|licensing|certified|award|years in business|\d+.?star|reviews/i);
});

test('landing structured data links truthful service and page nodes without FAQ/price/review inventions or secrets', async t => {
  const h = await harness(t, {COMPANY_PHONE: '(201) 555-0199', STRIPE_SECRET_KEY: 'synthetic-private-stripe-marker'}), r = await h.request(servicePath);
  const schema = JSON.parse(schemaText(r.body)), nodes = schema['@graph'];
  assert.equal(schema['@context'], 'https://schema.org');
  assert.deepEqual(nodes.map(node => node['@type']), ['Organization', 'WebPage', 'Service']);
  assert.equal(nodes[0].telephone, '+12015550199');
  assert.equal(nodes[0]['@id'], origin + '/#business');
  assert.equal(nodes[1].url, origin + servicePath);
  assert.equal(nodes[1].about['@id'], nodes[2]['@id']);
  assert.equal(nodes[1].isPartOf['@id'], origin + '/#website');
  assert.equal(nodes[2].provider['@id'], nodes[0]['@id']);
  assert.deepEqual(nodes[2].areaServed, {'@type': 'State', name: 'New Jersey'});
  assert.equal(nodes[1].description, serviceDescription);
  for (const field of ['aggregateRating', 'review', 'openingHours', 'address', 'price', 'offers']) assert.ok(!JSON.stringify(schema).includes('"' + field + '":'), field);
  assert.doesNotMatch(JSON.stringify(schema), /FAQPage|synthetic.private|JFK|LGA|LaGuardia/);
  const unconfigured = await harness(t, {COMPANY_PHONE: '</script><script>private</script>'});
  assert.ok(!Object.hasOwn(graph((await unconfigured.request(servicePath)).body)[0], 'telephone'));
});

test('landing uses its own exact JSON-LD CSP hash without granting it to unrelated/private pages', async t => {
  const h = await harness(t), r = await h.request(servicePath), home = await h.request('/'), api = await h.request('/api/public-config');
  const hash = crypto.createHash('sha256').update(schemaText(r.body)).digest('base64');
  const csp = r.headers.get('content-security-policy'), original = api.headers.get('content-security-policy');
  assert.equal(csp.replace(` 'sha256-${hash}'`, ''), original);
  assert.ok(!home.headers.get('content-security-policy').includes(hash));
  assert.ok(!original.includes(hash));
  assert.doesNotMatch(csp.split(';').find(value => value.trim().startsWith('script-src ')), /unsafe-inline|unsafe-eval|https:|\*/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('landing fleet uses actual existing assets/vehicles and FAQ/steps match supported booking behavior', () => {
  const html = read(serviceFile), images = [...html.matchAll(/<img\b[^>]*src="([^"]+)"[^>]*>/g)];
  assert.equal(images.length, 3);
  for (const image of images) {
    assert.ok(['/suburban-premier-2025.png', '/cadillac-escalade.png'].includes(image[1]));
    assert.ok(fs.existsSync(path.join(publicDirectory, image[1])));
    assert.match(image[0], /alt="[^"]+"/);
    assert.match(image[0], /width="1774" height="887"/);
  }
  assert.equal(images.filter(image => image[0].includes('loading="lazy"')).length, 2);
  assert.match(html, /Chevrolet Suburban Premier/);
  assert.match(html, /Cadillac Escalade ESV/);
  assert.equal((html.match(/<details>/g) || []).length, 5);
  for (const question of ['Can I book from New Jersey to Manhattan?', 'Can I reserve now and pay later?', 'Can I change my pickup time?', 'What vehicles are available?', 'How do I complete payment later?']) assert.ok(html.includes('<summary>' + question + '</summary>'));
  assert.match(html, /reserved as Unpaid, and payment is still required/);
  assert.match(html, /cancelled or completed trips cannot be changed/);
  assert.match(html, /Signed-in customers can open My Trips and select Complete Payment for an eligible unpaid reservation/);
  assert.match(html, /Reserve &amp; Pay Now or Reserve &amp; Pay Later/);
  assert.equal((html.match(/<li><h3>/g) || []).length, 5);
});

test('landing CSS is separate with mobile sizing, intrinsic images, focus and usable native disclosure targets', () => {
  const html = read(serviceFile), css = read('nj-nyc-car-service.css');
  assert.match(html, /class="route-skip" href="#main">Skip to content/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(css, /@media \(max-width: 650px\)/);
  assert.match(css, /@media \(max-width: 390px\)/);
  assert.match(css, /\.route-landing a:focus-visible/);
  assert.match(css, /\.route-landing \.route-header \{ display: flex/);
  assert.match(css, /\.route-landing \.route-navigation \.nav-cta \{ display: inline-flex/);
  assert.match(css, /\.route-faq summary \{ min-height: 56px/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /width: 100%; height: auto/);
  assert.match(css, /grid-template-columns: 1fr/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /@import|https?:|100vw/);
});

test('EWR public page has unique indexable metadata, clean canonical, schema and unchanged private CSP', async t => {
  const h = await harness(t, {COMPANY_PHONE: '(201) 555-0199'});
  for (const url of [ewrPath, ewrPath + '/', ewrPath + '?amount=1&offerCode=forged']) {
    const r = await h.request(url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-robots-tag'), null);
    assert.match(r.body, /name="robots" content="index, follow, max-image-preview:large"/);
    assert.equal(r.body.match(/<title>(.*?)<\/title>/)[1], ewrTitle);
    assert.ok(![title, serviceTitle].includes(ewrTitle));
    assert.ok(ewrTitle.length <= 60 && ewrDescription.length <= 160);
    assert.equal(r.body.match(/name="description" content="([^"]+)"/)[1], ewrDescription);
    assert.equal(r.body.match(/rel="canonical" href="([^"]+)"/)[1], origin + ewrPath);
    assert.equal(r.body.match(/property="og:url" content="([^"]+)"/)[1], origin + ewrPath);
    assert.ok(r.body.includes(`property="og:title" content="${ewrTitle}"`));
    assert.ok(r.body.includes(`property="og:description" content="${ewrDescription}"`));
    const nodes = graph(r.body);
    assert.deepEqual(nodes.map(node => node['@type']), ['Organization', 'WebPage', 'Service']);
    assert.equal(nodes[0].telephone, '+12015550199');
    assert.equal(nodes[1].about['@id'], nodes[2]['@id']);
    assert.equal(nodes[2].provider['@id'], origin + '/#business');
    assert.equal(nodes[1].url, origin + ewrPath);
    assert.match(nodes[2].description, /Pickups originating at Newark Liberty/);
    assert.doesNotMatch(JSON.stringify(nodes), /150|price|"Offer"|FAQPage|aggregateRating|"review"/);
    const hash = crypto.createHash('sha256').update(schemaText(r.body)).digest('base64');
    const api = await h.request('/api/public-config');
    assert.equal(r.headers.get('content-security-policy').replace(` 'sha256-${hash}'`, ''), api.headers.get('content-security-policy'));
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  }
  const alias = await fetch(h.url + '/' + ewrFile, {redirect: 'manual'});
  assert.equal(alias.status, 301);
  assert.equal(alias.headers.get('location'), ewrPath);
  assert.equal(h.state.googleCalls, 0);
  assert.equal(h.state.creates.length, 0);
});

test('EWR offer presentation limits $150 to the existing one-way Manhattan Suburban offer, not NJ/CT/PA', () => {
  const html = read(ewrFile), pricing = require('../pricing');
  assert.equal(pricing.fixedOffers.EWR_MANHATTAN_SUV.price, 150);
  assert.equal(pricing.fixedOffers.EWR_MANHATTAN_SUV.vehicle, 'suv');
  assert.equal(pricing.fixedOffers.EWR_MANHATTAN_SUV.allowPromotions, false);
  const special = html.match(/<aside class="ewr-special"[\s\S]*?<\/aside>/)[0];
  for (const text of ['EWR → MANHATTAN', 'Luxury SUV', '$150', 'FLAT RATE', 'Chevrolet Suburban Premier only', 'Up to 6 passengers', 'qualifying one-way', 'verified Manhattan destination', 'FIRST15 does not apply']) assert.ok(special.includes(text), text);
  assert.match(special, /href="\/#ewr-manhattan-special">Book This Ride/);
  for (const [code, name] of [['nj', 'New Jersey'], ['ct', 'Connecticut'], ['pa', 'Pennsylvania']]) {
    const card = html.match(new RegExp('<article[^>]*data-destination="' + code + '"[\\s\\S]*?<\\/article>'))[0];
    assert.ok(card.includes('EWR → ' + name));
    assert.doesNotMatch(card, /150|flat|\$/i);
    assert.match(card, /href="\/#book"/);
    assert.match(card, /quote/i);
  }
  assert.match(html, /Other New York City destinations and other vehicles use the normal quote flow/);
});

test('EWR page shows only project fleet/terminals and truthful optional airport features, without unsupported marketing', () => {
  const html = read(ewrFile), pricing = require('../pricing');
  assert.deepEqual(Object.keys(pricing.vehicleRates).sort(), ['escalade', 'suv']);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<h1 id="route-title">Newark Airport <span>\(EWR\) Car Service<\/span><\/h1>/);
  for (const name of ['Chevrolet Suburban Premier', 'Cadillac Escalade ESV']) assert.ok(html.includes(name));
  for (const image of html.matchAll(/<img[^>]*src="([^"]+)"[^>]*>/g)) {
    assert.ok(['/suburban-premier-2025.png', '/cadillac-escalade.png'].includes(image[1]));
    assert.match(image[0], /alt="[^"]+"/);
    assert.match(image[0], /width="1774" height="887"/);
  }
  assert.ok(Object.values(pricing.vehicleRates).every(vehicle => vehicle.maxPassengers === 6));
  for (const terminal of ['Terminal A', 'Terminal B', 'Terminal C', 'Not sure / EWR General']) assert.ok(html.includes(terminal));
  assert.match(html, /optional flight-number field/);
  assert.match(html, /while the trip is active/);
  assert.equal((html.match(/<details>/g) || []).length, 8);
  assert.equal((html.match(/<li><h3>/g) || []).length, 6);
  assert.doesNotMatch(html, /Executive Sedan|Executive Van|Sprinter|JFK|LGA|LaGuardia|to and from|automatic flight|flight tracking|meet.and.greet|free waiting|baggage assistance|guaranteed|#1|\bbest\b|\bcheapest\b|licensed|licensing|certified/i);
  assert.doesNotMatch(html, /pickup (?:in|from) (?:NYC|New York City|Manhattan)|NYC\s*→\s*(?:EWR|New Jersey)|New York City\s*→\s*(?:EWR|New Jersey)/i);
});

test('EWR internal links stay public and both special/general CTAs lead to existing booking without creating a reservation', async t => {
  const h = await harness(t), r = await h.request(ewrPath);
  const links = [...r.body.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  for (const link of links.filter(link => !link.startsWith(origin) && !link.endsWith('.css'))) assert.ok(['/', '/#book', '/#ewr-manhattan-special', '/#contact', servicePath, '#destinations', '#main'].includes(link), link);
  assert.match(r.body, /href="\/#ewr-manhattan-special">Book This Ride/);
  assert.match(r.body, /href="\/#book">Book Your Ride/);
  assert.match(read('index.html'), /href="\/newark-airport-ewr-car-service">Newark Liberty \(EWR\)/);
  assert.ok(read(serviceFile).includes(`href="${ewrPath}"`));
  assert.ok(r.body.includes(`href="${servicePath}"`));
  assert.doesNotMatch(r.body, /<form|<input|<script\s+src=|\/account|\/admin|\/api\/|customer_id|pickupPlaceId|stripeSessionId/);
  assert.equal(h.records().length, 0);
  assert.equal(h.state.googleCalls, 0);
  assert.equal(h.state.creates.length, 0);
});

function entryUi(hash, search = '') {
  const src = read('app.js'), calls = [], context = {
    bookAgainGeneration: 0, pickup: {}, dropoff: {}, pickupSuggestions: {}, dropoffSuggestions: {},
    URLSearchParams, configureDates() {}, selectTripType() {}, resetPassengerOptions() {}, resetPromoDisplay() {}, enableAddressAutocomplete() {},
    loadPublicConfig: async () => {}, loadBookAgainTemplate: async () => {}, activateEwrManhattanSpecial: () => calls.push('existing-offer-selection'),
    showNotice() {}, document: {getElementById: id => ({scrollIntoView() {calls.push('scroll:' + id);}})},
    window: {location: {hash, search, pathname: '/'}, history: {replaceState: (_state, _title, url) => calls.push(url)}}
  };
  vm.createContext(context);
  vm.runInContext(src.slice(src.indexOf('async function initialize()'), src.indexOf('\ninitialize();')), context);
  return {context, calls};
}

test('only the explicit EWR landing fragment selects the existing public offer UI; normal/Book Again/stale entries stay unchanged', async () => {
  const special = entryUi('#ewr-manhattan-special');
  await special.context.initialize();
  assert.deepEqual(special.calls, ['existing-offer-selection', '/#book', 'scroll:book']);
  for (const [hash, search] of [['#book', ''], ['#unrecognized', ''], ['', '?offerCode=EWR_MANHATTAN_SUV&amount=150'], ['#ewr-manhattan-special', '?bookAgain=source']]) {
    const ui = entryUi(hash, search); await ui.context.initialize(); assert.deepEqual(ui.calls, []);
  }
  const stale = entryUi('#ewr-manhattan-special'); let release;
  stale.context.loadPublicConfig = () => new Promise(resolve => release = resolve);
  const pending = stale.context.initialize(); stale.context.bookAgainGeneration++; release(); await pending;
  assert.deepEqual(stale.calls, []);
  const changed = entryUi('#ewr-manhattan-special');
  changed.context.loadPublicConfig = async () => {changed.context.window.location.hash = '#book';};
  await changed.context.initialize(); assert.deepEqual(changed.calls, []);
});

test('EWR landing offer still needs server-verified EWR/Manhattan/suv eligibility and never broadens to NJ/CT/PA or other vehicles', async t => {
  const h = await harness(t), special = {...booking, vehicle: 'suv', tripType: 'airport', offerCode: 'EWR_MANHATTAN_SUV', promoCode: 'FIRST15', amount: 1, total: 1};
  assert.equal((await h.request(ewrPath)).status, 200);
  const result = await h.request('/api/quote', special);
  assert.equal(result.status, 200); assert.equal(result.body.total, 150); assert.equal(result.body.discount, 0); assert.equal(result.body.promotion, null);
  for (const change of [{pickupPlaceId: 'forged'}, {pickupPlaceId: undefined}, {vehicle: 'escalade'}, {tripType: 'roundtrip'}, {tripType: 'hourly', hours: 3}]) assert.equal((await h.request('/api/quote', {...special, ...change})).status, 400);
  const counties = {'Jersey City, NJ': 'Hudson County', 'Stamford, CT': 'Fairfield County', 'Philadelphia, PA': 'Philadelphia County'};
  h.state.searchResults = Object.fromEntries(Object.entries(counties).map(([name, county]) => [name, [{addressComponents: [{types: ['administrative_area_level_2'], longText: county}]}]]));
  for (const destination of Object.keys(counties)) {
    assert.equal((await h.request('/api/quote', {...special, dropoff: destination})).status, 400);
    const normal = await h.request('/api/quote', {...booking, vehicle: 'suv', tripType: 'airport', dropoff: destination, total: 150});
    assert.equal(normal.status, 200); assert.equal(normal.body.fixedOffer, null); assert.equal(normal.body.total, 80);
  }
  const reserved = await h.request('/api/checkout', {...special, paymentChoice: 'later'});
  assert.equal(reserved.status, 200); assert.equal(h.records()[0].quote.total, 150); assert.equal(h.state.creates.length, 0);
});
