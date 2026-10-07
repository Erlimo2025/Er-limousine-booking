const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Only the existing public company-phone setting may augment the static schema.
// Omit absent/invalid settings rather than publish a guessed contact number.
function publicTelephone(value) {
  if (typeof value !== 'string' || !/^[+()\d .-]{7,32}$/.test(value)) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits) ? '+1' + digits : null;
}

function installPublicSeo(app, {publicDirectory, contentSecurityPolicy, companyPhone}) {
  const telephone = publicTelephone(companyPhone);
  const pages = [
    {file: 'index.html', routes: ['/', '/index.html']},
    {file: 'new-jersey-to-nyc-car-service.html', routes: ['/new-jersey-to-nyc-car-service']}
  ];
  for (const page of pages) {
    const template = fs.readFileSync(path.join(publicDirectory, page.file), 'utf8');
    const block = /(<script type="application\/ld\+json" id="business-schema">)([\s\S]*?)(<\/script>)/;
    const schema = JSON.parse(template.match(block)[2]);
    if (telephone) schema['@graph'].find(item => item['@type'] === 'Organization').telephone = telephone;
    const json = JSON.stringify(schema).replace(/[<>&\u2028\u2029]/g,
      character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
    const html = template.replace(block, (_, start, _oldJson, end) => start + json + end);
    const hash = crypto.createHash('sha256').update(json).digest('base64');
    // Only this public page permits its data block; other pages keep their own CSP.
    const csp = contentSecurityPolicy.replace(/script-src [^;]+/, directive => directive + ` 'sha256-${hash}'`);
    app.get(page.routes, (_req, res) => {
      res.set('Content-Security-Policy', csp);
      res.type('html').send(html);
    });
  }
  app.get('/new-jersey-to-nyc-car-service.html', (_req, res) => res.redirect(301, '/new-jersey-to-nyc-car-service'));
}

module.exports = {installPublicSeo};
