// Takt application service: in-memory demo state + the rush / bump / settle flow.
// One TaktApp = one demo shop. The HTTP layer keeps one per browser session (server/sessions.ts).
import { randomBytes } from 'node:crypto';
import type { AgentStatus, BumpOffer, Customer, DemoState, Job, LedgerEvent, MoneyMove, Plan, PlanOptionView, RushRequest } from '../shared/types.js';
import { buildSeedJobs, customers as seedCustomers, machines, SHOP } from './domain/seed.js';
import { schedule } from './domain/scheduler.js';
import { planRush, rushToJob, type PlanCandidate, type PlanResult } from './domain/planner.js';
import { compensationBudget, perJobCap } from './domain/pricing.js';
import type { AgentResult, AgentStep, OptionDetail, PlannerView, RushAgent } from './agent/agent.js';
import { dayLabel, emptyStatus, NeedsClarification, relDay } from './agent/agent.js';
import { templateOffer } from './agent/deterministic.js';
import { approvalChecks, checkAmount, checkCounter, checkDeliveryDay, checkMessage, offerCeiling } from './agent/guardrails.js';
import type { PayPalGateway } from './paypal/gateway.js';
import type { PayPalWebhookEvent } from './paypal/gateway.js';

function nextMonday(from = new Date()): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const add = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + add);
  return d;
}

/** Week-1 utilisation per machine, and when a small new laser + press-brake job would ship if nobody moved. */
function capacityOf(jobs: Job[]): DemoState['capacity'] {
  const s = schedule(jobs);
  const week1Pct: Record<string, number> = {};
  for (const m of machines) {
    const h = s.ops.filter((o) => o.machineId === m.id).reduce((t, o) => t + Math.max(0, Math.min(o.end, 40) - Math.max(o.start, 0)), 0);
    week1Pct[m.id] = Math.round((h / 40) * 100);
  }
  const probe: RushRequest = { id: 'probe', rawText: '', customer: { name: '', contact: '', city: '', email: '', lang: 'en' }, title: 'probe', material: '', qty: 1, ops: [{ machineId: 'LAS1', hours: 1, label: 'cut' }, { machineId: 'PB1', hours: 1, label: 'bend' }], dueDay: 0, basePriceChf: 0, extractedBy: 'deterministic' };
  const nextFreeDay = schedule([...jobs, rushToJob(probe, 1e9)]).timing['RUSH-probe'].deliveryDay;
  return { week1Pct, nextFreeDay };
}

export interface TaktAppOptions {
  /** Sandbox: PayPal redirects the rush buyer here after approval (GET /api/paypal/return). */
  returnUrl?: string;
  /** Sandbox: PayPal sends the buyer here when they cancel on the PayPal page (GET /api/paypal/cancel). */
  cancelUrl?: string;
  /** Sandbox: seeded customers have fake emails, so payouts go to this sandbox personal account instead. */
  payoutReceiver?: string;
  /** Hosted demo: live Claude calls left for this session / today (shown next to the agent badge). */
  liveLeft?: () => AgentStatus['liveLeft'];
}

export class TaktApp {
  state!: DemoState;
  /** Unique per demo run (changes on every reset): makes PayPal invoice ids and request ids unique across runs. */
  runId = '';
  private boardStart!: Date;
  private seen = new Set<string>();
  /** PayPal ids this demo created. Webhooks for anything else (other sessions on a shared gateway) are ignored. */
  private ownIds = new Set<string>();
  private n = 0;
  private pending?: { order: Job[]; rushJob: Job };
  private agentSt: AgentStatus;
  private inflight = new Map<string, Promise<unknown>>();
  private unsubscribe: () => void;

  constructor(
    private paypal: PayPalGateway,
    private agent: RushAgent,
    private currency = SHOP.currency,
    private opts: TaktAppOptions = {},
  ) {
    const s = agent.status();
    this.agentSt = emptyStatus(s.configured, s.model);
    this.unsubscribe = paypal.onEvent((e) => void this.onPayPalEvent(e).catch((err) => this.log('system', 'Webhook handling failed', String(err))));
    this.reset();
  }

  /** Stop listening to the (possibly shared) gateway. Called when a session expires. */
  dispose() {
    this.unsubscribe();
  }

  reset() {
    this.boardStart = nextMonday();
    this.runId = randomBytes(4).toString('hex');
    const jobs = buildSeedJobs(this.runId);
    this.seen.clear();
    this.ownIds.clear();
    this.inflight.clear();
    this.pending = undefined;
    this.checkout = undefined;
    this.state = {
      boardStartIso: `${this.boardStart.getFullYear()}-${String(this.boardStart.getMonth() + 1).padStart(2, '0')}-${String(this.boardStart.getDate()).padStart(2, '0')}`,
      now: new Date().toISOString(),
      machines,
      customers: structuredClone(seedCustomers),
      jobs,
      schedule: schedule(jobs),
      stage: 'idle',
      capacity: capacityOf(jobs),
      ledger: [],
      yield: { premiumsChf: 0, compensationsChf: 0, netChf: 0, rushJobsWon: 0 },
      modes: { paypal: this.paypal.mode, agent: this.agent.kind, currency: this.currency },
      agent: this.agentStatus(),
    };
    this.log('system', 'Demo reset', `${SHOP.name}, ${SHOP.city}: ${jobs.length} booked jobs on ${machines.length} machines`);
  }

  snapshot(): DemoState {
    this.state.now = new Date().toISOString();
    this.state.agent = this.agentStatus();
    return this.state;
  }

  /** Agent badge for *this* demo: how its last step ran and what it cost (the agent itself is shared). */
  private agentStatus(): AgentStatus {
    return { ...this.agentSt, liveLeft: this.opts.liveLeft?.() };
  }

  private track<T>(res: AgentResult<T>) {
    const a = this.agentSt;
    a.last = res.source;
    a.fallbackReason = res.source === 'fallback' ? res.fallbackReason : undefined;
    if (res.source === 'live') a.liveCalls++;
    if (res.source === 'replay') a.replayCalls++;
    if (res.usage) {
      a.inputTokens += res.usage.inputTokens;
      a.outputTokens += res.usage.outputTokens;
      a.costUsd += res.usage.costUsd;
    }
    this.state.agent = this.agentStatus();
  }

  /** Runs once per key at a time: double clicks and concurrent requests share the first call's result. */
  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private log(source: LedgerEvent['source'], title: string, detail: string, paypalId?: string, amountChf?: number) {
    this.state.ledger.unshift({ id: `L${++this.n}`, at: new Date().toISOString(), source, title, detail, paypalId, amountChf });
  }

  private money(v: number) { return { currency: this.currency, value: v }; }

  /**
   * Sandbox only: seeded bookings carry placeholder SEED-AUTH ids. Before Takt touches one, it gets a real sandbox
   * authorization for the same amount (AUTHORIZE order funded by PayPal's test card, no buyer step).
   */
  private async ensureRealAuthorization(job: Job) {
    if (job.payment.kind !== 'authorization' || !job.payment.authorizationId.startsWith('SEED-AUTH')) return;
    if (this.paypal.mode !== 'sandbox' || !this.paypal.createCardAuthorization) return;
    return this.once(`seed-auth-${job.id}`, () => this.seedAuthorization(job));
  }

  private async seedAuthorization(job: Job) {
    if (job.payment.kind !== 'authorization' || !job.payment.authorizationId.startsWith('SEED-AUTH')) return;
    const a = await this.paypal.createCardAuthorization!({
      referenceId: job.id,
      invoiceId: `TAKT-${job.id}-${this.runId}-BOOKING`,
      description: `Booking ${job.id}: ${job.qty}x ${job.title}`,
      amount: this.money(job.payment.authorizedChf),
    });
    this.ownIds.add(a.orderId).add(a.authorizationId);
    job.payment = { ...job.payment, orderId: a.orderId, authorizationId: a.authorizationId };
    this.log('api', `Sandbox booking authorization for ${job.id}`, `Seeded with a sandbox test card: POST /v2/checkout/orders intent=AUTHORIZE → ${a.status}, valid until ${a.expirationTime?.slice(0, 10)}`, a.authorizationId, a.amount.value);
  }
  private cust(id: string) { return this.state.customers.find((c) => c.id === id); }

  private logSteps(steps: AgentStep[]) {
    for (const s of steps) this.log(s.kind === 'tool' ? 'tool' : s.kind === 'guardrail' ? 'guardrail' : 'agent', s.title, s.detail);
  }

  private viaLabel(source: string) {
    const m = this.state.agent.model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^\w/, (c) => c.toUpperCase());
    return source === 'live' ? `Claude ${m} (live)` : source === 'replay' ? `Claude ${m} (recorded)` : source === 'fallback' ? 'rules (fallback)' : 'rules';
  }

  // ---- 1. Intake -----------------------------------------------------------------------------------
  async intake(text: string) {
    if (!text?.trim()) throw new Error('Empty request');
    let res: AgentResult<Awaited<ReturnType<RushAgent['intake']>>['value']>;
    try {
      res = await this.agent.intake(text.slice(0, 3000), this.boardStart);
    } catch (e) {
      if (!(e instanceof NeedsClarification)) throw e;
      // Never invent an order: ask the owner to complete the request.
      this.agentSt.last = 'fallback';
      this.state.rush = undefined;
      this.state.plan = undefined;
      this.state.stage = 'idle';
      this.state.intakeQuestion = { missing: e.missing, message: e.message };
      this.log('agent', 'Request unclear: asked the owner', e.message);
      return null;
    }
    this.track(res);
    this.state.intakeQuestion = undefined;
    const r = res.value;
    const slug = r.customerName.toLowerCase().replace(/\(.*?\)/g, '').normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rush';
    const rush: RushRequest = {
      id: String(Date.now()).slice(-6),
      rawText: text,
      customer: { name: r.customerName, contact: r.contact, city: r.city, email: `orders@${slug}.example`, lang: r.lang },
      title: r.title,
      material: r.material,
      qty: r.qty,
      ops: r.ops,
      dueDay: r.dueDay,
      basePriceChf: r.basePriceChf,
      extractedBy: res.source === 'live' || res.source === 'replay' ? 'llm' : 'deterministic',
    };
    // Where would it land if nobody moved? (append to the full schedule; code, not AI)
    const booked = this.state.jobs.filter((j) => j.status === 'booked');
    rush.firstFitDay = schedule([...booked, rushToJob(rush, 1e9)]).timing[`RUSH-${rush.id}`].deliveryDay;
    this.state.rush = rush;
    this.state.plan = undefined;
    this.state.pastOffers = undefined;
    this.state.paypalNotice = undefined;
    this.state.rushOrder = undefined;
    this.state.approval = undefined;
    this.state.stage = 'intake';
    this.logSteps(res.steps);
    const hours = rush.ops.map((o) => `${o.machineId} ${o.hours} h`).join(' + ');
    this.log('agent', 'Rush request understood', `Read by ${this.viaLabel(res.source)} (${rush.customer.lang.toUpperCase()}): ${rush.qty}× ${rush.title}, ${rush.material}; routing ${hours} (code); due ${dayLabel(this.boardStart, rush.dueDay, 'en')}; base CHF ${rush.basePriceChf} (rate card)`);
    return rush;
  }

  // ---- 2. Make room ---------------------------------------------------------------------------------
  private optionDetail(optionId: string, o: PlanCandidate): OptionDetail {
    return {
      optionId,
      compensationTotalChf: o.compensationTotalChf,
      rushPremiumChf: o.rushPremiumChf,
      rushPriceChf: o.rushPriceChf,
      netUpliftChf: o.netUpliftChf,
      budgetCapChf: compensationBudget(o.rushPremiumChf),
      bumps: o.bumps.map((b) => {
        const job = this.state.jobs.find((j) => j.id === b.jobId)!;
        const c = this.cust(b.customerId)!;
        return {
          jobId: b.jobId, jobTitle: job.title, customerId: c.id, customerName: c.name, contact: c.contact, lang: c.lang,
          fromDay: b.fromDay, toDay: b.toDay, delayDays: b.delayDays, compensationChf: b.compensationChf,
          mechanism: job.payment.kind === 'authorization' ? 'reduced-capture' : 'payout', capChf: perJobCap(job),
        };
      }),
    };
  }

  async plan(excludeCustomerIds: string[] = []) {
    const rush = this.state.rush;
    if (!rush) throw new Error('No rush request');
    const candidates = new Map<string, { cand: PlanCandidate; detail: OptionDetail }>();
    let run = 0;
    let last: PlanResult | undefined;
    let lastViews: OptionDetail[] = [];
    const runPlanner = (extra: string[]): PlannerView => {
      run++;
      const ex = new Set([...excludeCustomerIds, ...extra]);
      const customers = this.state.customers.map((c) => (ex.has(c.id) ? { ...c, flexible: false } : c));
      last = planRush(this.state.jobs, customers, rush);
      lastViews = last.options.map((o, i) => {
        const detail = this.optionDetail(`${run}${'ABC'[i]}`, o);
        candidates.set(detail.optionId, { cand: o, detail });
        return detail;
      });
      return { feasible: last.feasible, reason: last.reason, candidatesEvaluated: last.candidatesEvaluated, options: lastViews };
    };
    const res = await this.agent.plan({ rush, customers: this.state.customers, jobs: this.state.jobs, boardStart: this.boardStart, runPlanner });
    this.track(res);
    if (!last) runPlanner([]);
    const chosen = candidates.get(res.value.optionId);
    const base = last!;
    const pick: PlanCandidate = chosen?.cand ?? base;
    const detail = chosen?.detail;
    this.pending = { order: pick.orderedJobs, rushJob: pick.rushJob };
    this.logSteps(res.steps);

    const offers: BumpOffer[] = [];
    for (const b of detail?.bumps ?? []) {
      let draft = res.value.drafts[b.jobId];
      if (!draft) {
        draft = templateOffer(b, this.boardStart);
        this.log('guardrail', `Template offer for ${b.customerName}`, 'No valid agent draft for this job, so the DE/FR/EN template is used');
      }
      const now = new Date().toISOString();
      offers.push({
        id: `OF-${b.jobId}`, jobId: b.jobId, customerId: b.customerId, fromDay: b.fromDay, toDay: b.toDay, delayDays: b.delayDays,
        compensationChf: b.compensationChf, openingChf: b.compensationChf, mechanism: b.mechanism, lang: b.lang, message: draft.message, messageEn: draft.messageEn,
        status: 'draft', capChf: b.capChf, thread: [{ from: 'shop', text: draft.message, textEn: draft.messageEn, at: now }],
      });
    }
    const feasible = !!chosen;
    const firm = this.state.customers.filter((c) => !c.flexible || excludeCustomerIds.includes(c.id)).map((c) => c.name);
    const options: PlanOptionView[] = lastViews.map((o) => ({
      optionId: o.optionId, compensationTotalChf: o.compensationTotalChf, rushPremiumChf: o.rushPremiumChf, netUpliftChf: o.netUpliftChf,
      bumps: o.bumps.map((b) => ({ jobId: b.jobId, customerId: b.customerId, delayDays: b.delayDays, compensationChf: b.compensationChf, mechanism: b.mechanism })),
    }));
    if (detail && !options.some((o) => o.optionId === detail.optionId)) {
      options.unshift({ optionId: detail.optionId, compensationTotalChf: detail.compensationTotalChf, rushPremiumChf: detail.rushPremiumChf, netUpliftChf: detail.netUpliftChf, bumps: detail.bumps.map((b) => ({ jobId: b.jobId, customerId: b.customerId, delayDays: b.delayDays, compensationChf: b.compensationChf, mechanism: b.mechanism })) });
    }
    const plan: Plan = {
      id: `P${Date.now().toString(36)}`,
      rushId: rush.id,
      feasible,
      reason: feasible ? (pick.bumps.length ? `Fits by ${pick.bumps.length} voluntary bump(s)` : 'Fits without bumping anyone') : base.reason,
      insertAt: pick.insertAt,
      bumpedJobIds: pick.bumps.map((b) => b.jobId),
      proposed: schedule(pick.orderedJobs),
      offers,
      rushPriceChf: pick.rushPriceChf,
      rushPremiumChf: pick.rushPremiumChf,
      compensationTotalChf: pick.compensationTotalChf,
      netUpliftChf: pick.netUpliftChf,
      candidatesEvaluated: base.candidatesEvaluated,
      budgetCapChf: compensationBudget(pick.rushPremiumChf),
      options,
      chosenOptionId: detail?.optionId ?? '',
      justification: res.value.justification,
      chosenBy: res.source === 'live' || res.source === 'replay' ? 'llm' : 'deterministic',
      explanation: [
        base.firstFitDay > rush.dueDay
          ? `Without moving anyone, the earliest delivery would be ${dayLabel(this.boardStart, base.firstFitDay, 'en')}: too late for ${dayLabel(this.boardStart, rush.dueDay, 'en')}.`
          : `There is free capacity: it ships ${dayLabel(this.boardStart, base.firstFitDay, 'en')} without moving anyone.`,
        `Planner simulated ${base.candidatesEvaluated} re-sequencing options on the laser and press brake; ${options.length} feasible plan(s) offered to the agent.`,
        `Firm promises kept untouched: ${firm.join(', ')}.`,
        ...offers.map((o) => `${this.cust(o.customerId)!.name}: +${o.delayDays} day(s) → CHF ${o.compensationChf} (${o.mechanism === 'reduced-capture' ? 'capture less on their authorization' : 'PayPal Payout, already paid'})`),
        feasible ? `Rush price CHF ${pick.rushPriceChf} = base ${rush.basePriceChf} + premium ${pick.rushPremiumChf}; compensation budget CHF ${compensationBudget(pick.rushPremiumChf)}; net uplift CHF ${pick.netUpliftChf}.` : base.reason,
      ],
    };
    this.state.plan = plan;
    this.state.approval = undefined;
    this.state.stage = 'planned';
    this.log('agent', feasible ? `Room found: option ${plan.chosenOptionId}` : 'No room', `${this.viaLabel(res.source)}: ${res.value.justification}`);
    return plan;
  }

  sendOffers() {
    const p = this.state.plan;
    if (!p?.feasible) throw new Error('No feasible plan');
    for (const o of p.offers) if (o.status === 'draft') o.status = 'sent';
    this.state.stage = 'offers-sent';
    this.log('agent', 'Offers sent', p.offers.map((o) => `${this.cust(o.customerId)!.name} (${o.lang.toUpperCase()})`).join(', ') || 'none needed');
    this.maybeRequestApproval();
  }

  // ---- 3. Customer answers --------------------------------------------------------------------------
  private offerCtx(offerId: string) {
    const p = this.state.plan;
    const o = p?.offers.find((x) => x.id === offerId);
    if (!p || !o) throw new Error('Offer not found');
    return { p, o, c: this.cust(o.customerId)!, job: this.state.jobs.find((j) => j.id === o.jobId)! };
  }

  private recomputeTotals() {
    const p = this.state.plan!;
    p.compensationTotalChf = p.offers.filter((o) => o.status !== 'declined').reduce((s, o) => s + o.compensationChf, 0);
    p.netUpliftChf = p.rushPremiumChf - p.compensationTotalChf;
  }

  /** Accept / Decline buttons on the offer page (structured, no LLM needed). */
  async respond(offerId: string, accept: boolean) {
    const { o } = this.offerCtx(offerId);
    if (o.status !== 'sent') return o;
    o.decidedBy = 'button';
    if (accept) this.acceptOffer(o);
    else await this.declineOffer(o, 'Declined with the button');
    return o;
  }

  /** Free-text answer from the customer. The agent interprets it; guardrails re-check before anything changes. */
  async reply(offerId: string, text: string) {
    const { p, o, c, job } = this.offerCtx(offerId);
    if (o.status !== 'sent') throw new Error('This offer is already closed');
    const t = String(text ?? '').trim().slice(0, 2000);
    if (!t) throw new Error('Empty reply');
    const ceiling = offerCeiling(p, o, perJobCap(job));
    const res = await this.agent.reply({ offer: o, customer: c, job, ceilingChf: ceiling, replyText: t, boardStart: this.boardStart });
    this.track(res);
    o.thread.push({ from: 'customer', text: t, at: new Date().toISOString() });
    this.log('agent', `Reply from ${c.name}`, `"${t.length > 120 ? t.slice(0, 119) + '…' : t}"`);
    this.logSteps(res.steps);
    const d = res.value;
    const by = res.source === 'live' || res.source === 'replay' ? 'llm' : 'deterministic';
    const via = this.viaLabel(res.source);
    const say = () => {
      if (!d.message) return;
      // Defence in depth: the shop's message may not promise more than the ceiling, whoever wrote it.
      if (!checkMessage(d.message, null, ceiling).ok) {
        this.log('guardrail', 'Message blocked', 'Agent message mentioned an amount above the cap; not sent');
        return;
      }
      o.thread.push({ from: 'shop', text: d.message, textEn: d.messageEn, at: new Date().toISOString() });
    };
    switch (d.action) {
      case 'accept':
        o.decidedBy = by;
        say();
        this.acceptOffer(o, via);
        break;
      case 'counter': {
        const a = checkCounter(d.compensationChf, o.openingChf ?? o.compensationChf, ceiling);
        const day = checkDeliveryDay(d.deliveryDay, o.toDay);
        if (!a.ok || !day.ok) {
          o.escalation = `Counter blocked by guardrail: ${!a.ok ? a.error : (day as { error: string }).error}`;
          this.log('guardrail', `Counter from ${c.name} blocked`, o.escalation);
          break;
        }
        this.log('agent', `Counter-offer agreed with ${c.name}`, `${via}: CHF ${o.compensationChf} → CHF ${d.compensationChf}, delivery ${relDay(o.toDay, 'en')} → ${relDay(d.deliveryDay!, 'en')} (cap CHF ${ceiling})`);
        o.compensationChf = d.compensationChf!;
        o.toDay = d.deliveryDay!;
        o.delayDays = o.toDay - o.fromDay;
        o.decidedBy = by;
        say();
        this.acceptOffer(o, via);
        break;
      }
      case 'reply':
        if (d.compensationChf !== undefined && checkAmount(d.compensationChf, ceiling).ok) o.compensationChf = d.compensationChf;
        say();
        this.log('agent', `Answered ${c.name}`, `${via}: ${d.reason}${d.compensationChf !== undefined ? ` (now offering CHF ${o.compensationChf}, cap CHF ${ceiling})` : ''}`);
        break;
      case 'decline':
        o.decidedBy = by;
        await this.declineOffer(o, `${via}: ${d.reason}`);
        break;
      case 'escalate':
        o.escalation = d.reason;
        this.log('guardrail', `Escalated to owner: ${c.name}`, `${via}: ${d.reason}. Nothing was changed.`);
        break;
    }
    if (this.state.plan) this.recomputeTotals();
    return { decision: d, source: res.source };
  }

  private acceptOffer(o: BumpOffer, via = 'button') {
    const c = this.cust(o.customerId)!;
    o.status = 'accepted';
    o.respondedAt = new Date().toISOString();
    o.escalation = undefined;
    this.recomputeTotals();
    this.log('agent', `${c.name} accepted`, `${via}: +${o.delayDays} day(s) for CHF ${o.compensationChf} (${o.mechanism === 'reduced-capture' ? 'capture less at shipment' : 'PayPal Payout'}); queued for owner approval`, undefined, o.compensationChf);
    this.maybeRequestApproval();
  }

  private async declineOffer(o: BumpOffer, why: string) {
    const p = this.state.plan!;
    const c = this.cust(o.customerId)!;
    o.status = 'declined';
    o.respondedAt = new Date().toISOString();
    this.log('agent', `${c.name} declined`, `${why}. Re-planning without them`);
    this.state.pastOffers = [...(this.state.pastOffers ?? []).filter((x) => x.id !== o.id), o];
    const old = p.offers;
    const excluded = old.filter((x) => x.status === 'declined').map((x) => x.customerId);
    const np = await this.plan(excluded);
    // Customers who already said yes to the same move keep their agreement.
    for (const n of np.offers) {
      const prev = old.find((x) => x.jobId === n.jobId && x.status === 'accepted' && x.toDay === n.toDay);
      if (prev && prev.compensationChf <= n.capChf) Object.assign(n, { status: 'accepted', compensationChf: prev.compensationChf, thread: prev.thread, decidedBy: prev.decidedBy, respondedAt: prev.respondedAt });
    }
    if (np.feasible) {
      this.recomputeTotals();
      this.sendOffers();
    }
  }

  // ---- 3b. Owner approval: the only door to money moves --------------------------------------------------
  private caps() {
    return Object.fromEntries(this.state.jobs.map((j) => [j.id, perJobCap(j)]));
  }

  private maybeRequestApproval() {
    const p = this.state.plan;
    if (!p?.feasible || this.state.stage !== 'offers-sent' || !p.offers.every((o) => o.status === 'accepted')) return;
    this.recomputeTotals();
    const moves: MoneyMove[] = p.offers.map((o) => {
      const c = this.cust(o.customerId)!;
      const job = this.state.jobs.find((j) => j.id === o.jobId)!;
      return o.mechanism === 'payout'
        ? { id: `MV-${o.id}`, kind: 'payout', customerName: c.name, amountChf: o.compensationChf, api: 'POST /v1/payments/payouts', detail: `Now, to the PayPal account on file for ${c.name} (prepaid ${job.id})` }
        : { id: `MV-${o.id}`, kind: 'capture-less', customerName: c.name, amountChf: o.compensationChf, api: 'POST /v2/payments/authorizations/{id}/capture', detail: `At shipment of ${job.id}: capture CHF ${(job.payment as { authorizedChf: number }).authorizedChf - o.compensationChf} of CHF ${(job.payment as { authorizedChf: number }).authorizedChf}, final_capture=true` };
    });
    moves.push({ id: 'MV-RUSH', kind: 'rush-authorize', customerName: this.state.rush!.customer.name, amountChf: p.rushPriceChf, api: 'POST /v2/checkout/orders intent=AUTHORIZE', detail: 'Rush customer approves in PayPal; nothing is charged until the parts ship' });
    const checks = approvalChecks(p, this.caps());
    this.state.approval = { moves, checks, status: 'pending' };
    this.state.stage = 'awaiting-approval';
    this.log('guardrail', 'Waiting for owner approval', `${moves.length} money move(s); ${checks.filter((c) => c.ok).length}/${checks.length} checks pass. Nothing reaches PayPal before the owner approves.`);
  }

  async approve() {
    return this.once('approve', () => this.doApprove());
  }

  private async doApprove() {
    const p = this.state.plan;
    const a = this.state.approval;
    if (!p || !a || this.state.stage !== 'awaiting-approval' || a.status !== 'pending') throw new Error('Nothing to approve');
    const checks = approvalChecks(p, this.caps());
    a.checks = checks;
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) {
      this.log('guardrail', 'Approval blocked', failed.map((c) => c.label).join('; '));
      throw new Error(`Guardrail: ${failed[0].label}`);
    }
    a.status = 'approved';
    const done = new Set(a.doneMoveIds ?? []);
    const retry = done.size > 0;
    this.log('owner', retry ? 'Owner retried the approval' : 'Owner approved the money moves', `${a.moves.length} move(s), compensation CHF ${p.compensationTotalChf}, rush CHF ${p.rushPriceChf}${retry ? `; ${done.size} already done, skipped` : ''}`);
    try {
      await this.moveMoney(p, done);
    } catch (e) {
      // A PayPal call failed halfway: keep what succeeded, let the owner retry the rest (never pay twice).
      a.status = 'pending';
      a.doneMoveIds = [...done];
      this.log('system', 'PayPal call failed during approval', `${e instanceof Error ? e.message : String(e)}. ${done.size} of ${a.moves.length} move(s) done; press Approve again to retry the rest`);
      throw e;
    }
    a.doneMoveIds = [...done];
  }

  private async moveMoney(p: Plan, done: Set<string>) {
    for (const o of p.offers) {
      const moveId = `MV-${o.id}`;
      if (done.has(moveId)) continue;
      const c = this.cust(o.customerId)!;
      const job = this.state.jobs.find((j) => j.id === o.jobId)!;
      job.compensationChf = o.compensationChf;
      if (o.mechanism === 'payout') {
        // Payee from the booking record (or the sandbox test account), never from a message.
        const receiverEmail = this.paypal.mode === 'sandbox' && this.opts.payoutReceiver ? this.opts.payoutReceiver : c.email;
        // sender_batch_id is unique per run and plan: PayPal rejects a repeat, so a retry can never pay twice.
        const res = await this.paypal.createPayout(`takt-${this.runId}-${p.id}-${job.id}`, 'Thank you for moving your slot', [
          { receiverEmail, amount: this.money(o.compensationChf), note: `Takt: thank you for moving ${job.id}`, senderItemId: o.id },
        ]);
        this.ownIds.add(res.payoutBatchId);
        this.log('api', `Payout to ${c.name}`, `POST /v1/payments/payouts → batch ${res.batchStatus}`, res.payoutBatchId, o.compensationChf);
      } else if (job.payment.kind === 'authorization') {
        await this.ensureRealAuthorization(job);
        this.log('agent', `Capture-less booked for ${c.name}`, `Will capture CHF ${job.payment.authorizedChf - o.compensationChf} instead of ${job.payment.authorizedChf} on ${job.payment.authorizationId} at shipment (final_capture=true releases the rest)`, job.payment.authorizationId, o.compensationChf);
      }
      done.add(moveId);
    }
    await this.openRushCheckout();
    done.add('MV-RUSH');
  }

  // ---- 4. Rush customer pays (authorization) --------------------------------------------------------
  private checkout?: { planId: string; order: Promise<unknown> };

  /** Idempotent per plan: concurrent "accept" calls (slow sandbox round-trips) must not open two rush orders. */
  async openRushCheckout() {
    const planId = this.state.plan!.id;
    if (this.checkout?.planId !== planId) this.checkout = { planId, order: this.createRushOrder().catch((e) => { this.checkout = undefined; throw e; }) };
    return this.checkout.order;
  }

  private async createRushOrder() {
    const p = this.state.plan!;
    const rush = this.state.rush!;
    const order = await this.paypal.createAuthorizeOrder({
      referenceId: `RUSH-${rush.id}`,
      invoiceId: `TAKT-RUSH-${rush.id}-${this.runId}-${p.id}`,
      description: `Rush: ${rush.qty}x ${rush.title}`,
      amount: this.money(p.rushPriceChf),
      returnUrl: this.opts.returnUrl,
      cancelUrl: this.opts.cancelUrl ?? this.opts.returnUrl,
    });
    this.ownIds.add(order.orderId);
    this.state.rushOrder = { orderId: order.orderId, status: 'created', amountChf: p.rushPriceChf, approveUrl: order.approveUrl };
    this.state.stage = 'awaiting-payment';
    this.log('api', 'Rush order created', `POST /v2/checkout/orders intent=AUTHORIZE CHF ${p.rushPriceChf}`, order.orderId, p.rushPriceChf);
    return order;
  }

  /** Mock mode: the "PayPal popup" button calls this. Sandbox: the JS SDK approves and calls authorize(). */
  async mockApprove() {
    const o = this.state.rushOrder;
    if (!o || !this.paypal.simulateBuyerApproval) throw new Error('Not available');
    this.state.paypalNotice = undefined;
    await this.paypal.simulateBuyerApproval(o.orderId);
  }

  /** Mock mode: simulates the buyer pressing "Cancel and return" on the PayPal page. */
  async mockCancel() {
    const o = this.state.rushOrder;
    if (!o || this.paypal.mode !== 'mock') throw new Error('Not available');
    this.buyerCancelled(o.orderId);
  }

  /** Does this demo own that PayPal order? (Return / cancel redirects carry only the order id.) */
  ownsOrder(orderId: string) {
    return !!orderId && this.state.rushOrder?.orderId === orderId;
  }

  /** PayPal sent the buyer to cancel_url: nothing was charged, the same approval link stays valid. */
  buyerCancelled(orderId: string) {
    const o = this.state.rushOrder;
    if (!o || o.orderId !== orderId || o.status !== 'created') return false;
    o.cancelledAt = new Date().toISOString();
    const text = 'The rush customer cancelled on the PayPal page. Nothing was charged, and the same PayPal link still works if they try again.';
    this.state.paypalNotice = { kind: 'cancelled', text, at: o.cancelledAt };
    this.log('system', 'Buyer cancelled in PayPal', `${text} (redirect to cancel_url)`, orderId);
    return true;
  }

  async authorizeRush(orderId: string) {
    const o = this.state.rushOrder;
    // Return-URL redirect and the reconcile poll can both arrive: only the first one authorizes.
    if (!o || o.orderId !== orderId || o.status !== 'created') return;
    o.status = 'approved';
    let a;
    try {
      a = await this.paypal.authorizeOrder(orderId);
    } catch (err) {
      o.status = 'created';
      const why = err instanceof Error ? err.message : String(err);
      const notApproved = /ORDER_NOT_APPROVED/.test(why);
      const text = notApproved
        ? 'PayPal says the buyer has not approved the order yet (did they cancel?). Nothing was charged; the same link still works.'
        : `Authorizing the rush payment failed: ${why}. Nothing was charged; the buyer can try the link again.`;
      this.state.paypalNotice = { kind: notApproved ? 'cancelled' : 'error', text, at: new Date().toISOString() };
      this.log('system', notApproved ? 'Rush order not approved yet' : 'Rush authorization failed', text, orderId);
      throw err;
    }
    this.state.paypalNotice = undefined;
    o.cancelledAt = undefined;
    o.authorizationId = a.authorizationId;
    this.ownIds.add(a.authorizationId);
    this.log('api', 'Rush payment authorized', `POST /v2/checkout/orders/{id}/authorize → ${a.status}; nothing charged until shipment`, a.authorizationId, a.amount.value);
    // Commit happens on the PAYMENT.AUTHORIZATION.CREATED webhook, not here.
  }

  // ---- Webhooks: the schedule only commits when PayPal confirms --------------------------------------
  /** Ids an event refers to: the resource itself, its payout batch, and related order / authorization ids. */
  private eventIds(r: Record<string, any>): string[] {
    const rel = r.supplementary_data?.related_ids ?? {};
    return [r.id, r.payout_batch_id, rel.order_id, rel.authorization_id].filter((x): x is string => typeof x === 'string' && !!x);
  }

  async onPayPalEvent(e: PayPalWebhookEvent) {
    const r = e.resource as Record<string, any>;
    // On a shared gateway (sandbox, several demo sessions) every app sees every event: handle only our own.
    if (!this.eventIds(r).some((id) => this.ownIds.has(id))) return;
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
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
    if (e.event_type === 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED') {
      this.log('system', 'Payout unclaimed', `${r.payout_item?.receiver ?? 'Receiver'} has no PayPal account yet (${r.errors?.name ?? 'UNCLAIMED'}); PayPal emails a claim link and returns the money after 30 days`, r.payout_batch_id);
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
    this.log('system', 'Schedule committed', `Confirmed by PayPal (webhook or reconcile poll). Net uplift CHF ${p.netUpliftChf}`, o.authorizationId, p.netUpliftChf);
  }

  // ---- 5. Settle ------------------------------------------------------------------------------------
  async ship(jobId: string) {
    return this.once(`ship-${jobId}`, () => this.doShip(jobId));
  }

  private async doShip(jobId: string) {
    const j = this.state.jobs.find((x) => x.id === jobId);
    if (!j || j.status !== 'booked') throw new Error('Job not shippable');
    await this.ensureRealAuthorization(j);
    if (j.payment.kind === 'authorization') {
      const comp = j.compensationChf ?? 0;
      const amount = j.payment.authorizedChf - comp;
      // invoice_id must be new for every demo run (PayPal: 422 DUPLICATE_TRANSACTION otherwise); the request id is
      // stable within the run, so a retried or double-clicked capture is idempotent.
      const cap = await this.paypal.captureAuthorization(j.payment.authorizationId, {
        amount: this.money(amount),
        finalCapture: true,
        invoiceId: `TAKT-${j.id}-${this.runId}`,
        requestId: `takt-ship-${this.runId}-${j.id}-${j.payment.authorizationId}`,
        noteToPayer: comp ? `CHF ${comp} less than authorized: thank you for moving your delivery.` : undefined,
      });
      this.ownIds.add(cap.captureId);
      this.log('api', `Captured ${j.id}`, `POST /v2/payments/authorizations/{id}/capture CHF ${amount}${comp ? ` (authorized ${j.payment.authorizedChf}, −${comp} compensation)` : ''}, final_capture=true`, cap.captureId, amount);
    }
    j.status = 'shipped';
    this.state.schedule = schedule(this.state.jobs);
    return j;
  }

  async cancel(jobId: string) {
    const j = this.state.jobs.find((x) => x.id === jobId);
    if (!j || j.status !== 'booked') throw new Error('Job not cancellable');
    await this.ensureRealAuthorization(j);
    if (j.payment.kind === 'authorization') {
      await this.paypal.voidAuthorization(j.payment.authorizationId);
      this.log('api', `Voided ${j.id}`, 'POST /v2/payments/authorizations/{id}/void', j.payment.authorizationId);
    }
    j.status = 'cancelled';
    this.state.schedule = schedule(this.state.jobs);
    return j;
  }
}
