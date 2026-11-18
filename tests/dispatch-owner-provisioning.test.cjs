'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {PassThrough} = require('node:stream');
const {createRequire} = require('node:module');

// Exercise the real private input function with Node's real Readline against
// an isolated synthetic terminal. No process globals, database or providers change.
async function terminalInput(source) {
  const input = new PassThrough();input.isTTY = true;input.setRawMode = () => input;
  let displayed = '';
  const filename = path.resolve(__dirname, '../scripts/provision-dispatch-owner.cjs');
  const module = {exports: {}};
  vm.runInNewContext(source, {require: createRequire(filename), module,
    process: {argv: ['node', filename], stdin: input,
      stdout: {isTTY: true, columns: 80, write(chunk) {displayed += String(chunk);}}},
    Buffer}, {filename});
  const pending = module.exports.input(false);
  async function answer(prompt, value) {
    const deadline = Date.now() + 2000;
    while (!displayed.includes(prompt)) {
      if (Date.now() >= deadline) throw new Error('Synthetic private prompt unavailable');
      await new Promise(resolve => setImmediate(resolve));
    }
    await new Promise(resolve => setImmediate(resolve));
    input.write(value + '\r');
  }
  const password = 'Synthetic-Hidden-Password-9382';
  try {
    await answer('Owner display name: ', 'Synthetic Owner');
    await answer('Owner login address: ', 'owner@example.test');
    await answer('New owner password (hidden): ', password);
    await answer('Repeat password (hidden): ', password);
    await answer('Type PROVISION ONE OWNER: ', '\x1b[APROVISION ONE OWNER');
    return {values: await pending, displayed, password};
  } finally {input.destroy();}
}

test('private owner password cannot be recalled visibly at a later terminal prompt', {timeout: 10000}, async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/provision-dispatch-owner.cjs'), 'utf8');
  const guarded = await terminalInput(source);
  assert.equal(guarded.values.confirmation, 'PROVISION ONE OWNER');
  assert.equal(guarded.values.password, guarded.password);
  assert.equal(guarded.displayed.includes(guarded.password), false);
  // Negative control: prove that this terminal sequence catches the original
  // visible password recall, rather than merely checking an option in source.
  const unsafe = await terminalInput(source.replace('historySize:0', 'historySize:30'));
  assert.equal(unsafe.displayed.includes(unsafe.password), true);
  assert.notEqual(unsafe.values.confirmation, 'PROVISION ONE OWNER');
});
