const crypto = require('node:crypto');

function generateBookingReference() {
  return 'ER-' + String(crypto.randomInt(1_000_000)).padStart(6, '0');
}

function normalizeBookingReference(value) {
  return typeof value === 'string' && value.length === 9 && /^ER-[0-9]{6}$/i.test(value)
    ? value.toUpperCase() : null;
}

module.exports = {generateBookingReference, normalizeBookingReference};
