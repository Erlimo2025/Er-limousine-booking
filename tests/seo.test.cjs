const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const testPath = path.join(__dirname, 'security-abuse.test.cjs');
const source = fs.readFileSync(testPath, 'utf8');
const {harness, booking} = new Function('require', '__dirname',
  source.slice(0, source.indexOf('test("approved prices')) + '\nreturn {harness, booking};')(createRequire(testPath), __dirname);
const publicDirectory = path.join(__dirname, '../public');
const origin = 'https://erlimousineservice.com';
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

test('sitemap contains only the canonical public homepage, with no private/transactional/duplicate URLs', async t => {
  const h = await harness(t), r = await h.request('/sitemap.xml');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /xml/);
  assert.match(r.body, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(r.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0.9">/);
  assert.deepEqual([...r.body.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]), [origin + '/']);
  assert.equal((r.body.match(/<url>/g) || []).length, 1);
  assert.match(r.body, /<\/urlset>\s*$/);
  assert.doesNotMatch(r.body, /account|admin|dispatch|success|payment-methods|reset-password|login|signup|recovery|api\/|index\.html|jfk|lga/i);
});

test('all private HTML pages and their API/auth surfaces carry noindex without removing no-store', async t => {
  const h = await harness(t);
  assert.deepEqual(fs.readdirSync(publicDirectory).filter(file => file.endsWith('.html')).sort(), ['index.html', ...privatePages].sort());
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
  for (const url of ['/', '/index.html', '/robots.txt', '/sitemap.xml']) assert.equal((await h.request(url)).status, 200);
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
