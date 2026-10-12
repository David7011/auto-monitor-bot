import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientNavigationError, readRstCards } from './rst-browser-probe-utils.mjs';

test('navigation race is retryable, other failures are not', () => {
  assert.equal(isTransientNavigationError(new Error('Execution context was destroyed, most likely because of a navigation')), true);
  assert.equal(isTransientNavigationError(new Error('Cannot find context with specified id')), true);
  assert.equal(isTransientNavigationError(new Error('Target closed')), false);
});

test('snapshot retries navigation without masking fatal errors', async () => {
  const page = error => ({ locator: () => ({ evaluateAll: async () => { throw error; } }) });
  assert.deepEqual(await readRstCards(page(new Error('Execution context was destroyed'))), []);
  await assert.rejects(readRstCards(page(new Error('Target closed'))), /Target closed/);
});

test('snapshot returns card evidence', async () => {
  const cards = [{ id: '123', title: 'Car', href: '/car.html' }];
  assert.deepEqual(await readRstCards({ locator: () => ({ evaluateAll: async () => cards }) }), cards);
});
