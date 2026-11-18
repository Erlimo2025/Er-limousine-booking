'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const OTPAuth = require('otpauth');
const {encryptionKey, encryptSeed, decryptSeed, totpStep, generateEnrollment,
  recoveryCodes, recoveryHash, installDispatchOwner} = require('../auth/dispatch-owner');

test('owner TOTP accepts the RFC 6238 SHA-1 vector and rejects future, old and replayed steps', () => {
  const seed = OTPAuth.Secret.fromUTF8('12345678901234567890').base32;
  assert.equal(totpStep(seed, '287082', 59_000), 1);
  assert.equal(totpStep(seed, '287082', 89_000), 1);
  assert.equal(totpStep(seed, '287082', 29_000), null, 'Do not accept a future step');
  assert.equal(totpStep(seed, '287082', 90_000), null, 'Only one previous step is accepted');
  assert.equal(totpStep(seed, '287082', 59_000, 1), null, 'Accepted steps cannot be reused');
  for (const value of [287082, '287082\n', '28708', {}, null]) assert.equal(totpStep(seed, value, 59_000), null);
});

test('enrollment secrets are random and use a local authenticator URI without a QR provider', () => {
  const first = generateEnrollment('synthetic@example.test'), second = generateEnrollment('synthetic@example.test');
  assert.notEqual(first.secret, second.secret);
  const parsed = OTPAuth.URI.parse(first.uri);
  assert.equal(parsed.secret.base32, first.secret);
  assert.equal(parsed.issuer, 'ER Limousine Dispatch');
  assert.equal(parsed.digits, 6);assert.equal(parsed.period, 30);
  assert.equal(new URL(first.uri).protocol, 'otpauth:');
});

test('MFA encryption authenticates the owner identity and rejects tampering and wrong keys safely', () => {
  const key = encryptionKey(crypto.randomBytes(32).toString('base64'));
  const ownerId = crypto.randomUUID(), seed = generateEnrollment('synthetic@example.test').secret;
  const cipher = encryptSeed(seed, key, ownerId);
  assert.equal(cipher.includes(seed), false);
  assert.notEqual(encryptSeed(seed, key, ownerId), cipher, 'Every encryption uses a fresh nonce');
  assert.equal(decryptSeed(cipher, key, ownerId), seed);
  for (const decrypt of [() => decryptSeed(cipher, key, crypto.randomUUID()),
    () => decryptSeed(cipher, crypto.randomBytes(32), ownerId),
    () => decryptSeed('v1.bad.bad.PRIVATE-SECRET', key, ownerId)]) {
    assert.throws(decrypt, error => error.status === 503 && error.message === 'Dispatch authentication unavailable.');
  }
});

test('owner mode fails closed without its protected key and disabled mode needs no key', () => {
  for (const value of [undefined, '', 'PRIVATE-KEY', Buffer.alloc(16).toString('base64')])
    assert.throws(() => encryptionKey(value), {status: 503});
  const app = {use() {throw new Error('Disabled owner mode must not mount routes');}};
  assert.equal(installDispatchOwner(app, {env: {}}).enabled, false);
  assert.throws(() => installDispatchOwner(app, {env: {DISPATCH_OWNER_ENABLED: 'true'}}), {status: 503});
});

test('recovery codes have independent entropy and only their normalized digests are reusable server values', () => {
  const codes = recoveryCodes();
  assert.equal(codes.length, 8);assert.equal(new Set(codes).size, 8);
  for (const code of codes) {
    assert.match(code, /^(?:[a-f0-9]{4}-){5}[a-f0-9]{4}$/);
    assert.match(recoveryHash(code), /^[a-f0-9]{64}$/);
    assert.equal(recoveryHash(code.toUpperCase()), recoveryHash(code));
    assert.notEqual(recoveryHash(code), code);
  }
  for (const value of ['PRIVATE-CODE', '', codes[0] + '\n', null, {}]) assert.equal(recoveryHash(value), null);
});
