// End-to-end demo path against the mock gateway with the deterministic agent: must pass 10/10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaktApp } from './app.js';
import { MockPayPal } from './paypal/mock.js';
import { DeterministicAgent } from './agent/deterministic.js';
import { schedule } from './domain/scheduler.js';
import { buildSeedJobs } from './domain/seed.js';

export const REQUEST = 'Our harvester header brackets cracked. Need 6x brackets like the photo, S355 8 mm, by Tuesday evening — harvest starts Wednesday. — Thomas Schmid, Escholzmatt';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('seed baseline is on time', () => {
  const jobs = buildSeedJobs();
  const s = schedule(jobs);
  assert.ok(Object.values(s.timing).every((t) => !t.late));
});

test('demo path: intake -> plan -> offers -> accept -> owner approves -> authorize -> webhook commit -> ship (capture less)', async () => {
  for (let run = 0; run < 10; run++) {
    const app = new TaktApp(new MockPayPal(5), new DeterministicAgent());
    await app.intake(REQUEST);
    const plan = await app.plan();
    assert.equal(plan.feasible, true);
    assert.ok(plan.offers.length >= 2, 'expect at least two bump offers');
    assert.ok(plan.offers.some((o) => o.mechanism === 'reduced-capture'));
    assert.ok(plan.offers.some((o) => o.mechanism === 'payout'));
    assert.ok(plan.netUpliftChf > 0);
    assert.ok(plan.compensationTotalChf <= plan.budgetCapChf);
    app.sendOffers();
    for (const o of plan.offers) await app.respond(o.id, true);
    assert.equal(app.state.stage, 'awaiting-approval');
    assert.ok(!app.state.ledger.some((l) => l.source === 'api'), 'no PayPal call before the owner approves');
    assert.ok(app.state.approval!.checks.every((c) => c.ok));
    await app.approve();
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

test('free-text counter-offer within the cap is agreed and changes the capture amount', async () => {
  const app = new TaktApp(new MockPayPal(5), new DeterministicAgent());
  await app.intake(REQUEST);
  const plan = await app.plan();
  app.sendOffers();
  const rochat = plan.offers.find((o) => o.customerId === 'rochat')!;
  await app.reply(rochat.id, "D'accord, mais plutôt jeudi matin et CHF 70");
  assert.equal(rochat.status, 'accepted');
  assert.equal(rochat.compensationChf, 70);
  assert.equal(rochat.toDay, 3);
  assert.equal(app.state.plan!.compensationTotalChf, plan.offers.reduce((s, o) => s + o.compensationChf, 0));
});

test('declined offer triggers a re-plan without that customer', async () => {
  const app = new TaktApp(new MockPayPal(5), new DeterministicAgent());
  await app.intake(REQUEST);
  const plan = await app.plan();
  app.sendOffers();
  const first = plan.offers[0];
  await app.respond(first.id, false);
  assert.ok(!app.state.plan!.offers.some((o) => o.customerId === first.customerId));
});

test('approval is refused when a guardrail fails', async () => {
  const app = new TaktApp(new MockPayPal(5), new DeterministicAgent());
  await app.intake(REQUEST);
  const plan = await app.plan();
  app.sendOffers();
  for (const o of plan.offers) await app.respond(o.id, true);
  plan.offers[0].compensationChf = 9999; // simulate tampering after acceptance
  await assert.rejects(() => app.approve(), /Guardrail/);
  assert.ok(!app.state.ledger.some((l) => l.source === 'api'));
});

// ---- QA 2026-10-25 regressions -------------------------------------------------------------------------
async function toCommitted(app: TaktApp, text = REQUEST) {
  await app.intake(text);
  const plan = await app.plan();
  app.sendOffers();
  for (const o of plan.offers) await app.respond(o.id, true);
  await app.approve();
  await app.mockApprove();
  await wait(40);
  assert.equal(app.state.stage, 'committed');
  return plan;
}

test('B1/B2: Ship works on every run after Reset demo (unique invoice id per run, fresh seed authorizations)', async () => {
  const paypal = new MockPayPal(5); // the mock rejects a reused invoice_id like PayPal does (DUPLICATE_TRANSACTION)
  const app = new TaktApp(paypal, new DeterministicAgent());
  const runIds = new Set<string>();
  for (let run = 0; run < 5; run++) {
    if (run) app.reset();
    runIds.add(app.runId);
    await toCommitted(app);
    const rochat = app.state.jobs.find((j) => j.id === 'J-2044')!;
    await app.ship(rochat.id);
    assert.equal(rochat.status, 'shipped', `run ${run}`);
  }
  assert.equal(runIds.size, 5);
});

test('B1: a double-clicked Ship captures once (idempotent within a run)', async () => {
  const paypal = new MockPayPal(5);
  const app = new TaktApp(paypal, new DeterministicAgent());
  await toCommitted(app);
  const [a, b] = await Promise.all([app.ship('J-2044'), app.ship('J-2044')]);
  assert.equal(a, b);
  assert.equal(app.state.ledger.filter((l) => l.title === 'Captured J-2044').length, 1);
});

test('B5: the FR sample is a real squeeze that bumps the French customer and a German one', async () => {
  const { RUSH_SAMPLES } = await import('../web/src/samples.js');
  const fr = RUSH_SAMPLES.find((s) => s.label === 'FR email')!.text;
  const app = new TaktApp(new MockPayPal(5), new DeterministicAgent());
  const rush = (await app.intake(fr))!;
  assert.equal(rush.customer.lang, 'fr');
  assert.ok(rush.firstFitDay! > rush.dueDay, 'does not fit without moving anyone');
  const plan = await app.plan();
  assert.ok(plan.feasible);
  assert.ok(plan.offers.some((o) => o.lang === 'fr' && o.customerId === 'rochat'));
  assert.ok(plan.offers.some((o) => o.lang === 'de'));
  assert.match(plan.explanation[0], /too late/);
});

test('B5: plan text never claims "too late" when the rush fits without bumps', async () => {
  const app = new TaktApp(new MockPayPal(5), new DeterministicAgent());
  const rush = (await app.intake('Need 2 brackets S355 2 mm by Friday next week — Anna Muster, Kriens'))!;
  assert.ok(rush.firstFitDay! <= rush.dueDay);
  const plan = await app.plan();
  assert.equal(plan.offers.length, 0);
  assert.doesNotMatch(plan.explanation[0], /too late/);
});

test('B6: rules fallback never jumps to the cap; one modest step, then the owner decides', async () => {
  const app = new TaktApp(new MockPayPal(5), new DeterministicAgent());
  await app.intake(REQUEST);
  const plan = await app.plan();
  app.sendOffers();
  const meier = plan.offers.find((o) => o.customerId === 'meier')!;
  const opening = meier.compensationChf;
  await app.reply(meier.id, 'Gerne, aber nur für CHF 900.');
  assert.equal(meier.status, 'sent');
  assert.ok(meier.compensationChf > opening && meier.compensationChf <= opening + 30, `one step up, got ${meier.compensationChf}`);
  assert.ok(meier.compensationChf < meier.capChf);
  assert.match(meier.thread.at(-1)!.text, new RegExp(`CHF ${meier.compensationChf}\\b`));
  const stepped = meier.compensationChf;
  await app.reply(meier.id, 'Nein, CHF 250 oder gar nicht.');
  assert.equal(meier.compensationChf, stepped, 'no second concession');
  assert.ok(meier.escalation, 'escalated to the owner');
  // a counter within the policy (opening + 50 %) is still agreed
  const rochat = plan.offers.find((o) => o.customerId === 'rochat')!;
  await app.reply(rochat.id, "D'accord pour CHF 2500");
  assert.equal(rochat.status, 'sent');
  assert.ok(rochat.compensationChf <= (rochat.openingChf! + Math.max(20, rochat.openingChf! * 0.5)));
});

test('B7: rules fallback refuses to invent a job from unreadable text and asks the owner', async () => {
  const app = new TaktApp(new MockPayPal(5), new DeterministicAgent());
  const r = await app.intake('hello');
  assert.equal(r, null);
  assert.equal(app.state.rush, undefined);
  assert.ok(app.state.intakeQuestion?.missing.includes('part'));
  assert.ok(app.state.ledger.some((l) => l.title === 'Request unclear: asked the owner'));
  await assert.rejects(() => app.plan(), /No rush request/);
  // a complete request then works and clears the question
  await app.intake(REQUEST);
  assert.equal(app.state.intakeQuestion, undefined);
});

test('B8: buyer cancels on the PayPal page -> logged, visible notice, same order still approvable', async () => {
  const app = new TaktApp(new MockPayPal(5), new DeterministicAgent());
  await app.intake(REQUEST);
  const plan = await app.plan();
  app.sendOffers();
  for (const o of plan.offers) await app.respond(o.id, true);
  await app.approve();
  await app.mockCancel();
  assert.equal(app.state.paypalNotice?.kind, 'cancelled');
  assert.ok(app.state.ledger.some((l) => l.title === 'Buyer cancelled in PayPal'));
  assert.equal(app.state.stage, 'awaiting-payment');
  await app.mockApprove();
  await wait(40);
  assert.equal(app.state.stage, 'committed');
  assert.equal(app.state.paypalNotice, undefined);
});

test('B4: two demos on one shared gateway never see each other\'s PayPal events', async () => {
  const shared = new MockPayPal(5);
  const a = new TaktApp(shared, new DeterministicAgent());
  const b = new TaktApp(shared, new DeterministicAgent());
  await toCommitted(a);
  assert.equal(b.state.stage, 'idle');
  assert.ok(!b.state.ledger.some((l) => l.source === 'webhook'), 'B logged none of A\'s webhooks');
  b.dispose();
});

test('B19: a PayPal failure halfway through approval can be retried without paying twice', async () => {
  const paypal = new MockPayPal(5);
  let fail = true;
  const realOrder = paypal.createAuthorizeOrder.bind(paypal);
  paypal.createAuthorizeOrder = async (i) => { if (fail) { fail = false; throw new Error('PayPal 503 SERVICE_UNAVAILABLE'); } return realOrder(i); };
  const app = new TaktApp(paypal, new DeterministicAgent());
  await app.intake(REQUEST);
  const plan = await app.plan();
  app.sendOffers();
  for (const o of plan.offers) await app.respond(o.id, true);
  await assert.rejects(() => app.approve(), /503/);
  assert.equal(app.state.approval!.status, 'pending');
  await app.approve();
  assert.equal(app.state.stage, 'awaiting-payment');
  assert.equal(app.state.ledger.filter((l) => l.title.startsWith('Payout to')).length, 1, 'payout made once');
});

test('B13: a declined offer link still resolves (closed offers are kept)', async () => {
  const app = new TaktApp(new MockPayPal(5), new DeterministicAgent());
  await app.intake(REQUEST);
  const plan = await app.plan();
  app.sendOffers();
  const first = plan.offers[0];
  await app.respond(first.id, false);
  assert.equal(app.state.pastOffers?.find((o) => o.id === first.id)?.status, 'declined');
});

async function committedApp(gw = new MockPayPal(5)) {
  const app = new TaktApp(gw, new DeterministicAgent());
  await app.intake(REQUEST);
  const plan = await app.plan();
  app.sendOffers();
  for (const o of plan.offers) await app.respond(o.id, true);
  await app.approve();
  return { app, gw, plan };
}

test('JS SDK onApprove and the PayPal webhook both arrive: one authorization, timeline shows every PayPal step', async () => {
  const { app, gw } = await committedApp();
  const orderId = app.state.rushOrder!.orderId;
  await gw.simulateBuyerApproval(orderId); // the buyer approves in the SDK popup; the webhook follows 5 ms later
  await app.authorizeRush(orderId, 'sdk'); // onApprove -> POST /api/rush/authorize
  await wait(40);
  assert.equal(app.state.stage, 'committed');
  assert.equal(app.state.ledger.filter((l) => l.title === 'Rush payment authorized').length, 1);
  const rush = app.state.jobs.find((j) => j.rush)!;
  const labels = rush.paypal!.map((s) => `${s.status} ${s.label}`).join('\n');
  assert.match(labels, /CREATED Rush order created/);
  assert.match(labels, /APPROVED Buyer approved in PayPal \(JS SDK v6 onApprove\)/);
  assert.match(labels, /CREATED Payment authorized/);
  assert.ok(rush.paypal!.some((s) => s.source === 'confirmed' && s.idKind === 'authorization'), 'authorization confirmed by PayPal event');
  assert.ok(app.state.rushOrder!.expiresAt, 'authorization expiry is shown');
});

test('rush cancelled before shipment: authorization voided, premium lost, bumped customers keep their compensation', async () => {
  const { app, gw, plan } = await committedApp();
  await app.mockApprove();
  await wait(40);
  const before = { ...app.state.yield };
  const rush = app.state.jobs.find((j) => j.rush)!;
  await app.cancel(rush.id);
  assert.equal(rush.status, 'cancelled');
  assert.equal(rush.cancelledVia, 'void');
  assert.equal((await gw.getAuthorization(rush.payment.kind === 'authorization' ? rush.payment.authorizationId : '')).status, 'VOIDED');
  assert.equal(app.state.yield.premiumsChf, before.premiumsChf - plan.rushPremiumChf);
  assert.equal(app.state.yield.compensationsChf, before.compensationsChf);
  assert.ok(rush.paypal!.some((s) => s.status === 'VOIDED' && s.api?.includes('/void')));
  await assert.rejects(app.cancel(rush.id), /not cancellable/);
});

test('rush cancelled after shipment: capture refunded in full; "Check in PayPal" reads the live status', async () => {
  const { app } = await committedApp();
  await app.mockApprove();
  await wait(40);
  const rush = app.state.jobs.find((j) => j.rush)!;
  await assert.rejects(app.refund(rush.id), /ship the job first/);
  await app.ship(rush.id);
  await app.refund(rush.id);
  assert.equal(rush.cancelledVia, 'refund');
  assert.ok(rush.paypal!.some((s) => s.idKind === 'refund' && s.status === 'COMPLETED'));
  const live = await app.checkPayPal(rush.id);
  assert.deepEqual(live, ['authorization CAPTURED', 'capture REFUNDED']);
  const payoutJob = app.state.jobs.find((j) => j.payment.kind === 'prepaid' && j.compensationChf)!;
  await wait(40);
  assert.ok(payoutJob.paypal!.some((s) => s.idKind === 'payout-batch' && s.source === 'confirmed' && s.status === 'SUCCESS'), 'payout confirmation on the job timeline');
});
