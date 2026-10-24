// End-to-end demo path against the mock gateway: must pass 10/10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaktApp } from './app.js';
import { MockPayPal } from './paypal/mock.js';
import { DeterministicNegotiator } from './agent/negotiator.js';
import { schedule } from './domain/scheduler.js';
import { buildSeedJobs } from './domain/seed.js';

const REQUEST = 'Our harvester header brackets cracked. Need 6x brackets like the photo, S355 8 mm, by Tuesday evening — harvest starts Wednesday. — Thomas Schmid, Escholzmatt';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('seed baseline is on time', () => {
  const jobs = buildSeedJobs();
  const s = schedule(jobs);
  assert.ok(Object.values(s.timing).every((t) => !t.late));
});

test('demo path: intake -> plan -> offers -> accept -> authorize -> webhook commit -> ship (capture less)', async () => {
  for (let run = 0; run < 10; run++) {
    const app = new TaktApp(new MockPayPal(5), new DeterministicNegotiator());
    await app.intake(REQUEST);
    const plan = await app.plan();
    assert.equal(plan.feasible, true);
    assert.ok(plan.offers.length >= 2, 'expect at least two bump offers');
    assert.ok(plan.offers.some((o) => o.mechanism === 'reduced-capture'));
    assert.ok(plan.offers.some((o) => o.mechanism === 'payout'));
    assert.ok(plan.netUpliftChf > 0);
    app.sendOffers();
    for (const o of plan.offers) await app.respond(o.id, true);
    assert.equal(app.state.stage, 'awaiting-payment');
    await app.mockApprove();
    await wait(40);
    assert.equal(app.state.stage, 'committed');
    assert.ok(Object.values(app.state.schedule.timing).every((t) => !t.late), 'nobody late after commit');
    const bumped = app.state.jobs.find((j) => j.payment.kind === 'authorization' && j.compensationChf)!;
    await app.ship(bumped.id);
    const cap = app.state.ledger.find((l) => l.title === `Captured ${bumped.id}`)!;
    assert.equal(cap.amountChf, (bumped.payment as { authorizedChf: number }).authorizedChf - bumped.compensationChf!);
  }
});

test('declined offer triggers a re-plan without that customer', async () => {
  const app = new TaktApp(new MockPayPal(5), new DeterministicNegotiator());
  await app.intake(REQUEST);
  const plan = await app.plan();
  app.sendOffers();
  const first = plan.offers[0];
  await app.respond(first.id, false);
  assert.ok(!app.state.plan!.offers.some((o) => o.customerId === first.customerId));
});
