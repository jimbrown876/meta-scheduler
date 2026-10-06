import test from 'node:test';
import assert from 'node:assert/strict';
import { listingCaption } from './listing-copy.js';

const config = { pageName: 'Georgia Wood Tools', availableUrl: 'https://example.com/' };
const item = { title: 'Fixture saw', price: '$900', status: 'available', location: 'Snellville, GA', description: 'Includes the documented fence.', url: 'https://example.com/equipment/1234/fixture-saw' };

test('Facebook copy keeps factual details, the exact inquiry link and the follow instruction', () => {
  const copy = listingCaption(item, config);
  assert.ok(copy.startsWith('Fixture saw — $900\nLocation: Snellville, GA'));
  assert.ok(copy.includes(item.description));
  assert.ok(copy.includes(item.url + '#inquire'));
  assert.match(copy, /Follow Georgia Wood Tools/);
  assert.match(copy, /Confirm viewing and pickup arrangements before travelling/);
  const noLocation = listingCaption({ ...item, location: undefined }, config);
  assert.doesNotMatch(noLocation, /Location:|Snellville/);
});

test('sold and reserved captions describe availability without pretending sold inventory can be bought', () => {
  for (const channel of ['facebook', 'instagram']) {
    const copy = listingCaption({ ...item, status: 'sold', price: '' }, config, channel);
    assert.ok(copy.startsWith('SOLD — Fixture saw'));
    assert.doesNotMatch(copy, /\$900|ask about this machine|use its inquiry form/i);
    assert.match(copy, /Browse current stock/);
    if (channel === 'instagram') assert.match(copy, /website link in our bio/);
    assert.ok(copy.includes(item.url + '#inquire'));
  }
  assert.match(listingCaption({ ...item, status: 'reserved' }, config), /^RESERVED —/);
  assert.match(listingCaption({ ...item, status: 'reserved' }, config), /This machine is reserved/);
});

test('Instagram copy retains the buyer route and exact machine identity under its caption limit', () => {
  const copy = listingCaption({ ...item, description: '🪵'.repeat(3000) }, config, 'instagram');
  assert.ok(copy.length <= 2200);
  assert.ok(copy.isWellFormed());
  assert.match(copy, /open the website link in our bio, choose “Fixture saw”/);
  assert.ok(copy.includes(item.url + '#inquire'));
  assert.ok(copy.endsWith('Follow Georgia Wood Tools for new arrivals and machine demonstrations.'));
  assert.throws(() => listingCaption(item, config, 'unknown'), /Unsupported/);
});
