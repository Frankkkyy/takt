import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAmount, checkDeliveryDay, checkMessage, chfAmounts } from './guardrails.js';
import { compensationBudget, perJobCap } from '../domain/pricing.js';

test('chfAmounts finds amounts in DE/FR/EN notations', () => {
  assert.deepEqual(chfAmounts('ok but CHF 70 please'), [70]);
  assert.deepEqual(chfAmounts('70 CHF, oder 80 Franken'), [70, 80]);
  assert.deepEqual(chfAmounts("Fr. 1'200.– und CHF 45.50"), [1200, 45.5]);
  assert.deepEqual(chfAmounts('d’accord pour 60 francs'), [60]);
  assert.deepEqual(chfAmounts('6 pieces by Tuesday, 8 mm'), []);
});

test('checkAmount enforces whole, non-negative amounts within the ceiling', () => {
  assert.equal(checkAmount(70, 321).ok, true);
  assert.equal(checkAmount(322, 321).ok, false);
  assert.equal(checkAmount(-5, 321).ok, false);
  assert.equal(checkAmount(10.5, 321).ok, false);
  assert.equal(checkAmount('70', 321).ok, false);
});

test('checkDeliveryDay refuses dates earlier than the plan or outside the board', () => {
  assert.equal(checkDeliveryDay(3, 2).ok, true);
  assert.equal(checkDeliveryDay(1, 2).ok, false);
  assert.equal(checkDeliveryDay(12, 2).ok, false);
});

test('checkMessage: must state the agreed amount and nothing above the cap', () => {
  assert.equal(checkMessage('Wir zahlen Ihnen CHF 50 als Dankeschön.', 50, 50).ok, true);
  assert.equal(checkMessage('Wir zahlen Ihnen CHF 60 als Dankeschön.', 50, 50).ok, false);
  assert.equal(checkMessage('We pay CHF 50 now and CHF 500 later.', 50, 300).ok, false);
  assert.equal(checkMessage('Thanks, noted!', null, 300).ok, true);
});

test('caps: per job 12 % of price, budget 60 % of rush premium', () => {
  assert.equal(perJobCap({ priceChf: 2680 } as never), 321);
  assert.equal(compensationBudget(685), 411);
});
