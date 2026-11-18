'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {createDispatchSecurityLogger} = require('../services/dispatch-security-logging');

const time = Date.parse('2026-11-17T17:00:00.000Z');

test('Dispatch security events contain only closed fields and opaque server-owned references', () => {
  const lines = [];
  const emit = createDispatchSecurityLogger({write: line => lines.push(line), now: () => time});
  const referenceId = randomUUID(), actorId = randomUUID(), recordId = randomUUID();
  emit({referenceId, url: 'PRIVATE-URL', body: {token: 'PRIVATE-TOKEN'}},
    'reservation_status_update', 'succeeded', {actorId, recordId,
      email: 'PRIVATE-EMAIL', notes: 'PRIVATE-NOTES', error: new Error('PRIVATE-ERROR')});
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    timestamp: new Date(time).toISOString(), referenceId,
    operation: 'admin', category: 'dispatch_security',
    action: 'reservation_status_update', outcome: 'succeeded', actorId, recordId
  });
  assert.doesNotMatch(lines[0], /PRIVATE-|email|notes|error|body|url|token/);
});

test('Dispatch security logging rejects unknown codes and missing or forged request references', () => {
  const lines = [];
  const emit = createDispatchSecurityLogger({write: line => lines.push(line), now: () => time});
  for (const [request, action, outcome] of [
    [{referenceId: randomUUID()}, 'PRIVATE-ACTION', 'succeeded'],
    [{referenceId: randomUUID()}, {toString: () => 'dispatch_sign_in', toJSON: () => 'PRIVATE-ACTION'}, 'succeeded'],
    [{referenceId: randomUUID()}, ['dispatch_sign_in'], 'succeeded'],
    [{referenceId: randomUUID()}, 'dispatch_sign_in', 'PRIVATE-OUTCOME'],
    [{referenceId: randomUUID()}, 'dispatch_sign_in', 'completed'],
    [{referenceId: 'PRIVATE-REFERENCE'}, 'dispatch_sign_in', 'succeeded'],
    [{referenceId: randomUUID() + '\n'}, 'dispatch_sign_in', 'succeeded'],
    [{}, 'dispatch_sign_in', 'succeeded']
  ]) assert.doesNotThrow(() => emit(request, action, outcome));
  assert.deepEqual(lines, []);
});

test('invalid optional actor and record references cannot become log values', () => {
  const lines = [];
  const emit = createDispatchSecurityLogger({write: line => lines.push(line), now: () => time});
  for (const options of [
    {actorId: 'PRIVATE-ACTOR-TOKEN', recordId: 'PRIVATE-PAYMENT-ID'},
    {actorId: randomUUID() + '\n', recordId: randomUUID() + '\n'}
  ]) emit({referenceId: randomUUID()}, 'dispatch_sign_in', 'denied', options);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const entry = JSON.parse(line);
    assert.equal(Object.hasOwn(entry, 'actorId'), false);
    assert.equal(Object.hasOwn(entry, 'recordId'), false);
    assert.doesNotMatch(line, /PRIVATE-|\\n/);
  }
});

test('export terminal outcomes remain distinct and do not include report data', () => {
  const lines = [];
  const emit = createDispatchSecurityLogger({write: line => lines.push(line), now: () => time});
  for (const outcome of ['completed', 'failed', 'interrupted', 'denied']) {
    emit({referenceId: randomUUID()}, 'financial_csv_export', outcome,
      {actorId: randomUUID(), search: 'PRIVATE-ADDRESS', paymentId: 'cs_PRIVATE'});
  }
  assert.deepEqual(lines.map(line => JSON.parse(line).outcome), ['completed', 'failed', 'interrupted', 'denied']);
  assert.ok(lines.every(line => !line.includes('PRIVATE')));
});

test('a failed logging sink cannot change the business operation', async () => {
  const emit = createDispatchSecurityLogger({write: () => {throw new Error('PRIVATE-SINK-ERROR');}, now: () => time});
  assert.doesNotThrow(() => emit({referenceId: randomUUID()}, 'dispatch_logout', 'succeeded', {actorId: randomUUID()}));
  let calls = 0;
  const asynchronous = createDispatchSecurityLogger({write: () => {
    calls++;
    return Promise.reject(new Error('PRIVATE-ASYNC-SINK-ERROR'));
  }, now: () => time});
  assert.doesNotThrow(() => asynchronous({referenceId: randomUUID()}, 'dispatch_logout', 'succeeded'));
  // Give Node's unhandled-rejection detection a turn; only the logger consumes
  // the rejected promise, so a missing sink catch fails this test naturally.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});
