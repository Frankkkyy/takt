// Takt application service: in-memory demo state + the rush / bump / settle flow.
import type { BumpOffer, Customer, DemoState, Job, LedgerEvent, Plan, RushRequest } from '../shared/types.js';
import { buildSeedJobs, customers as seedCustomers, machines, SHOP } from './domain/seed.js';
import { schedule } from './domain/scheduler.js';
import { planRush } from './domain/planner.js';
import type { Negotiator } from './agent/negotiator.js';
import { dayLabel } from './agent/negotiator.js';
import type { PayPalGateway } from './paypal/gateway.js';
import type { PayPalWebhookEvent } from './paypal/gateway.js';

function nextMonday(from = new Date()): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const add = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + add);
  return d;
}

export class TaktApp {
  state!: DemoState;
  private boardStart!: Date;
  private seen = new Set<string>();
  private n = 0;
  private pending?: { order: Job[]; rushJob: Job };

  constructor(private paypal: PayPalGateway, private agent: Negotiator, private currency = SHOP.currency) {
    paypal.onEvent((e) => void this.onPayPalEvent(e).catch((err) => this.log('system', 'Webhook handling failed', String(err))));
    this.reset();
  }

  reset() {
    this.boardStart = nextMonday();
    const jobs = buildSeedJobs();
    this.seen.clear();
    this.state = {
      boardStartIso: `${this.boardStart.getFullYear()}-${String(this.boardStart.getMonth() + 1).padStart(2, '0')}-${String(this.boardStart.getDate()).padStart(2, '0')}`,
      now: new Date().toISOString(),
      machines,
      customers: structuredClone(seedCustomers),
      jobs,
      schedule: schedule(jobs),
      stage: 'idle',
      ledger: [],
      yield: { premiumsChf: 0, compensationsChf: 0, netChf: 0, rushJobsWon: 0 },
      modes: { paypal: this.paypal.mode, agent: this.agent.kind, currency: this.currency },
    };
    this.log('system', 'Demo reset', `${SHOP.name}, ${SHOP.city}: ${jobs.length} booked jobs on ${machines.length} machines`);
  }

  snapshot(): DemoState {
    this.state.now = new Date().toISOString();
    return this.state;
  }

  private log(source: LedgerEvent['source'], title: string, detail: string, paypalId?: string, amountChf?: number) {
    this.state.ledger.unshift({ id: `L${++this.n}`, at: new Date().toISOString(), source, title, detail, paypalId, amountChf });
  }

  private money(v: number) { return { currency: this.currency, value: v }; }
  private cust(id: string) { return this.state.customers.find((c) => c.id === id); }

  // ---- 1. Intake -----------------------------------------------------------------------------------
  async intake(text: string) {
    if (!text?.trim()) throw new Error('Empty request');
    const r = await this.agent.intake(text, this.boardStart);
    const rush: RushRequest = {
      id: String(Date.now()).slice(-6),
      rawText: text,
      customer: { name: r.customerName, contact: r.contact, city: r.city, email: 'thomas@hof-schmid.example', lang: r.lang },
      title: r.title,
      material: r.material,
      qty: r.qty,
      ops: r.ops,
      dueDay: r.dueDay,
      basePriceChf: r.basePriceChf,
      extractedBy: this.agent.kind === 'llm' ? 'llm' : 'deterministic',
    };
    this.state.rush = rush;
    this.state.plan = undefined;
    this.state.rushOrder = undefined;
    this.state.stage = 'intake';
    const hours = rush.ops.map((o) => `${o.machineId} ${o.hours} h`).join(' + ');
    this.log('agent', 'Rush request understood', `${rush.qty}× ${rush.title}, ${rush.material}; routing ${hours}; due ${dayLabel(this.boardStart, rush.dueDay, 'en')}; base CHF ${rush.basePriceChf}`);
    return rush;
  }

  // ---- 2. Make room ---------------------------------------------------------------------------------
  async plan(excludeCustomerIds: string[] = []) {
    const rush = this.state.rush;
    if (!rush) throw new Error('No rush request');
    const customers = this.state.customers.map((c) => (excludeCustomerIds.includes(c.id) ? { ...c, flexible: false } : c));
    const res = planRush(this.state.jobs, customers, rush);
    const proposed = schedule(res.orderedJobs);
    this.pending = { order: res.orderedJobs, rushJob: res.rushJob };
    const offers: BumpOffer[] = [];
    for (const b of res.bumps) {
      const c = this.cust(b.customerId)!;
      const job = this.state.jobs.find((j) => j.id === b.jobId)!;
      const mechanism: BumpOffer['mechanism'] = job.payment.kind === 'authorization' ? 'reduced-capture' : 'payout';
      const draft = await this.agent.draftOffer(c, job, b, mechanism, this.boardStart);
      offers.push({ id: `OF-${job.id}`, jobId: job.id, customerId: c.id, fromDay: b.fromDay, toDay: b.toDay, delayDays: b.delayDays, compensationChf: b.compensationChf, mechanism, lang: c.lang, ...draft, status: 'draft' });
    }
    const firm = this.state.customers.filter((c) => !c.flexible || excludeCustomerIds.includes(c.id)).map((c) => c.name);
    const plan: Plan = {
      id: `P${Date.now().toString(36)}`,
      rushId: rush.id,
      feasible: res.feasible,
      reason: res.reason,
      insertAt: res.insertAt,
      bumpedJobIds: res.bumps.map((b) => b.jobId),
      proposed,
      offers,
      rushPriceChf: res.rushPriceChf,
      rushPremiumChf: res.rushPremiumChf,
      compensationTotalChf: res.compensationTotalChf,
      netUpliftChf: res.netUpliftChf,
      candidatesEvaluated: res.candidatesEvaluated,
      explanation: [
        `Without moving anyone, the earliest delivery would be ${dayLabel(this.boardStart, res.firstFitDay, 'en')} — too late.`,
        `Simulated ${res.candidatesEvaluated} re-sequencing options on the laser and press brake.`,
        `Firm promises kept untouched: ${firm.join(', ')}.`,
        ...offers.map((o) => `${this.cust(o.customerId)!.name}: +${o.delayDays} day(s) → CHF ${o.compensationChf} (${o.mechanism === 'reduced-capture' ? 'capture less on their authorization' : 'PayPal Payout, already paid'})`),
        res.feasible ? `Rush price CHF ${res.rushPriceChf} = base ${rush.basePriceChf} + premium ${res.rushPremiumChf}; net uplift CHF ${res.netUpliftChf} after compensations.` : res.reason,
      ],
    };
    this.state.plan = plan;
    this.state.stage = 'planned';
    this.log('agent', res.feasible ? 'Room found' : 'No room', `${res.reason}. ${res.candidatesEvaluated} options simulated; cheapest compensation CHF ${res.compensationTotalChf}`);
    return plan;
  }

  sendOffers() {
    const p = this.state.plan;
    if (!p?.feasible) throw new Error('No feasible plan');
    for (const o of p.offers) if (o.status === 'draft') o.status = 'sent';
    this.state.stage = 'offers-sent';
    this.log('agent', 'Offers sent', p.offers.map((o) => `${this.cust(o.customerId)!.name} (${o.lang.toUpperCase()})`).join(', '));
    if (p.offers.length === 0) return this.openRushCheckout();
  }

  // ---- 3. Customer answers --------------------------------------------------------------------------
  async respond(offerId: string, accept: boolean) {
    const p = this.state.plan;
    const o = p?.offers.find((x) => x.id === offerId);
    if (!p || !o) throw new Error('Offer not found');
    if (o.status !== 'sent') return o;
    const c = this.cust(o.customerId)!;
    const job = this.state.jobs.find((j) => j.id === o.jobId)!;
    o.respondedAt = new Date().toISOString();
    if (!accept) {
      o.status = 'declined';
      this.log('agent', `${c.name} declined`, 'Re-planning without them');
      const excluded = p.offers.filter((x) => x.status === 'declined').map((x) => x.customerId);
      await this.plan(excluded);
      this.sendOffers();
      return o;
    }
    o.status = 'accepted';
    job.compensationChf = o.compensationChf;
    if (o.mechanism === 'payout') {
      const res = await this.paypal.createPayout(`takt-${p.id}-${job.id}`, 'Thank you for moving your slot', [
        { receiverEmail: c.email, amount: this.money(o.compensationChf), note: `Takt: thank you for moving ${job.id}`, senderItemId: o.id },
      ]);
      this.log('api', `Payout to ${c.name}`, `POST /v1/payments/payouts → batch ${res.batchStatus}`, res.payoutBatchId, o.compensationChf);
    } else if (job.payment.kind === 'authorization') {
      this.log('agent', `${c.name} accepted`, `Will capture CHF ${job.payment.authorizedChf - o.compensationChf} instead of ${job.payment.authorizedChf} on ${job.payment.authorizationId} at shipment (final_capture=true releases the rest)`, job.payment.authorizationId, o.compensationChf);
    }
    if (p.offers.every((x) => x.status === 'accepted')) await this.openRushCheckout();
    return o;
  }

  // ---- 4. Rush customer pays (authorization) --------------------------------------------------------
  async openRushCheckout() {
    const p = this.state.plan!;
    const rush = this.state.rush!;
    const order = await this.paypal.createAuthorizeOrder({
      referenceId: `RUSH-${rush.id}`,
      invoiceId: `TAKT-${rush.id}-${Date.now().toString(36)}`,
      description: `Rush: ${rush.qty}x ${rush.title}`,
      amount: this.money(p.rushPriceChf),
    });
    this.state.rushOrder = { orderId: order.orderId, status: 'created', amountChf: p.rushPriceChf };
    this.state.stage = 'awaiting-payment';
    this.log('api', 'Rush order created', `POST /v2/checkout/orders intent=AUTHORIZE CHF ${p.rushPriceChf}`, order.orderId, p.rushPriceChf);
    return order;
  }

  /** Mock mode: the "PayPal popup" button calls this. Sandbox: the JS SDK approves and calls authorize(). */
  async mockApprove() {
    const o = this.state.rushOrder;
    if (!o || !this.paypal.simulateBuyerApproval) throw new Error('Not available');
    await this.paypal.simulateBuyerApproval(o.orderId);
  }

  async authorizeRush(orderId: string) {
    const o = this.state.rushOrder;
    if (!o || o.orderId !== orderId || o.status === 'authorized') return;
    o.status = 'approved';
    const a = await this.paypal.authorizeOrder(orderId);
    o.authorizationId = a.authorizationId;
    this.log('api', 'Rush payment authorized', `POST /v2/checkout/orders/{id}/authorize → ${a.status}; nothing charged until shipment`, a.authorizationId, a.amount.value);
    // Commit happens on the PAYMENT.AUTHORIZATION.CREATED webhook, not here.
  }

  // ---- Webhooks: the schedule only commits when PayPal confirms --------------------------------------
  async onPayPalEvent(e: PayPalWebhookEvent) {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    const r = e.resource as Record<string, any>;
    this.log('webhook', e.event_type, e.summary, r.id ?? r.payout_batch_id);
    if (e.event_type === 'CHECKOUT.ORDER.APPROVED' && r.id === this.state.rushOrder?.orderId) {
      await this.authorizeRush(r.id);
    }
    if (e.event_type === 'PAYMENT.AUTHORIZATION.CREATED' && r.id === this.state.rushOrder?.authorizationId) {
      this.commit();
    }
    if (e.event_type === 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED') {
      const offerId = r.payout_item?.sender_item_id;
      this.log('system', 'Compensation delivered', `Payout for ${offerId} settled`, r.payout_batch_id);
    }
  }

  private commit() {
    const p = this.state.plan!;
    const rush = this.state.rush!;
    const o = this.state.rushOrder!;
    if (this.state.stage === 'committed') return;
    o.status = 'authorized';
    const rushCustomer: Customer = { id: 'rush', name: rush.customer.name, contact: rush.customer.contact, city: rush.customer.city, lang: rush.customer.lang, email: rush.customer.email, flexible: false, maxDelayDays: 0, delayCostPerDayChf: 0, note: 'Rush customer' };
    if (!this.cust('rush')) this.state.customers.push(rushCustomer);
    // Apply exactly the dispatch order the customers agreed to.
    const res = this.pending!;
    const seqById = new Map(res.order.map((j) => [j.id, j.seq]));
    for (const j of this.state.jobs) j.seq = seqById.get(j.id) ?? j.seq;
    for (const off of p.offers) {
      const j = this.state.jobs.find((x) => x.id === off.jobId)!;
      j.dueDay = off.toDay; // new promised date, agreed by the customer
    }
    const rj: Job = { ...res.rushJob, id: `R-${rush.id}`, priceChf: p.rushPriceChf, payment: { kind: 'authorization', orderId: o.orderId, authorizationId: o.authorizationId!, authorizedChf: p.rushPriceChf } };
    this.state.jobs.push(rj);
    this.state.schedule = schedule(this.state.jobs);
    this.state.stage = 'committed';
    this.state.yield.premiumsChf += p.rushPremiumChf;
    this.state.yield.compensationsChf += p.compensationTotalChf;
    this.state.yield.netChf += p.netUpliftChf;
    this.state.yield.rushJobsWon += 1;
    this.log('system', 'Schedule committed', `Confirmed by PayPal webhook. Net uplift CHF ${p.netUpliftChf}`, o.authorizationId, p.netUpliftChf);
  }

  // ---- 5. Settle ------------------------------------------------------------------------------------
  async ship(jobId: string) {
    const j = this.state.jobs.find((x) => x.id === jobId);
    if (!j || j.status !== 'booked') throw new Error('Job not shippable');
    if (j.payment.kind === 'authorization') {
      const comp = j.compensationChf ?? 0;
      const amount = j.payment.authorizedChf - comp;
      const cap = await this.paypal.captureAuthorization(j.payment.authorizationId, {
        amount: this.money(amount),
        finalCapture: true,
        invoiceId: `TAKT-${j.id}`,
        noteToPayer: comp ? `CHF ${comp} less than authorized: thank you for moving your delivery.` : undefined,
      });
      this.log('api', `Captured ${j.id}`, `POST /v2/payments/authorizations/{id}/capture CHF ${amount}${comp ? ` (authorized ${j.payment.authorizedChf}, −${comp} compensation)` : ''}, final_capture=true`, cap.captureId, amount);
    }
    j.status = 'shipped';
    this.state.schedule = schedule(this.state.jobs);
    return j;
  }

  async cancel(jobId: string) {
    const j = this.state.jobs.find((x) => x.id === jobId);
    if (!j || j.status !== 'booked') throw new Error('Job not cancellable');
    if (j.payment.kind === 'authorization') {
      await this.paypal.voidAuthorization(j.payment.authorizationId);
      this.log('api', `Voided ${j.id}`, 'POST /v2/payments/authorizations/{id}/void', j.payment.authorizationId);
    }
    j.status = 'cancelled';
    this.state.schedule = schedule(this.state.jobs);
    return j;
  }
}
