// Takt application service: in-memory demo state + the rush / bump / settle flow.
// One TaktApp = one demo shop. The HTTP layer keeps one per browser session (server/sessions.ts).
import { randomBytes } from 'node:crypto';
import type { AgentStatus, BumpOffer, Customer, DemoState, GuardrailCheck, Job, LedgerEvent, MoneyMove, MoveProposal, MoveReview, PayPalStep, Plan, PlanOptionView, RushRequest, Schedule } from '../shared/types.js';
import { buildSeedJobs, customers as seedCustomers, machines, SHOP } from './domain/seed.js';
import { schedule } from './domain/scheduler.js';
import { planRush, rushToJob, type PlanCandidate, type PlanResult } from './domain/planner.js';
import { compensation, compensationBudget, perJobCap, POLICY } from './domain/pricing.js';
import type { AgentResult, AgentStep, BumpDetail, OptionDetail, PlannerView, RushAgent } from './agent/agent.js';
import { dayLabel, emptyStatus, NeedsClarification, relDay } from './agent/agent.js';
import { templateMoveOffer, templateOffer } from './agent/deterministic.js';
import { approvalChecks, BOARD_LAST_DAY, checkAmount, checkCounter, checkDeliveryDay, checkMessage, offerCeiling } from './agent/guardrails.js';
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
  /** Wait before a reconcile poll (not a callback) authorizes an approved order. Default 4 s. */
  reconcileGraceMs?: number;
  /** experience_context.locale for the rush buyer's PayPal pages (default en-CH: English, Swiss formats). */
  locale?: string;
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
    const at = new Date().toISOString();
    for (const j of jobs) {
      j.paypal = j.payment.kind === 'authorization'
        ? [{ at, label: 'Booked: payment held (authorization)', status: 'CREATED', id: j.payment.authorizationId, idKind: 'authorization', amountChf: j.payment.authorizedChf, source: 'call', api: 'Orders v2 intent=AUTHORIZE (placeholder until Takt touches it)' }]
        : [{ at, label: `Booked: paid in full by ${j.payment.paidVia === 'paypal' ? 'PayPal' : 'bank transfer'}`, status: 'PAID', amountChf: j.payment.paidChf, source: 'call' }];
    }
    this.seen.clear();
    this.ownIds.clear();
    this.inflight.clear();
    this.pending = undefined;
    this.pendingMove = undefined;
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

  /** Append to a PayPal timeline (a job's, or the rush order's before it becomes a job). */
  private step(trail: PayPalStep[] | undefined, s: Omit<PayPalStep, 'at'>) {
    trail?.push({ at: new Date().toISOString(), ...s });
  }

  private jobOf(paypalId: string | undefined) {
    if (!paypalId) return undefined;
    return this.state.jobs.find((j) => (j.payment.kind === 'authorization' && (j.payment.authorizationId === paypalId || j.payment.orderId === paypalId)) || j.captureId === paypalId || j.paypal?.some((x) => x.id === paypalId));
  }

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
    // The placeholder becomes a real sandbox authorization: replace the first timeline entry.
    if (job.paypal?.[0]) job.paypal[0] = { ...job.paypal[0], id: a.authorizationId, status: a.status, api: 'POST /v2/checkout/orders intent=AUTHORIZE, payment_source.card (sandbox test card)', source: 'call', label: `Booked: payment held (authorization, valid until ${a.expirationTime?.slice(0, 10) ?? '?'})` };
    this.log('api', `Sandbox booking authorization for ${job.id}`, `Seeded with a sandbox test card: POST /v2/checkout/orders intent=AUTHORIZE → ${a.status}, valid until ${a.expirationTime?.slice(0, 10)}`, a.authorizationId, a.amount.value);
  }
  private cust(id: string) { return this.state.customers.find((c) => c.id === id); }

  // ---- Board: the owner drags a job later; it runs the same path as the agent's proposals --------------
  /** Room left under a job's cap (12 % of its price), counting compensation it already got from an earlier bump. */
  private capLeft(job: Job) {
    return Math.max(0, perJobCap(job) - (job.compensationChf ?? 0));
  }

  /**
   * Code, not AI: where does the job land if it gives up its place in the dispatch order? Tries every later
   * position, keeps those where every other promise still holds, and picks the latest delivery up to the dragged
   * day (ties: the smallest change). Returns undefined when no later slot keeps every other promise.
   */
  private moveSlot(jobId: string, targetDay: number) {
    const booked = this.state.jobs.filter((j) => j.status === 'booked').sort((a, b) => a.seq - b.seq);
    const i = booked.findIndex((j) => j.id === jobId);
    const fromDay = this.state.schedule.timing[jobId].deliveryDay;
    const rest = booked.filter((j) => j.id !== jobId);
    let best: { order: Job[]; sim: Schedule; day: number } | undefined;
    for (let k = i + 1; k <= rest.length; k++) {
      const order = [...rest.slice(0, k), booked[i], ...rest.slice(k)].map((j, n) => ({ ...j, seq: (n + 1) * 10 }));
      const sim = schedule(order);
      const day = sim.timing[jobId].deliveryDay;
      if (day <= fromDay || day > targetDay || day > BOARD_LAST_DAY) continue;
      if (Object.values(sim.timing).some((t) => t.jobId !== jobId && t.late)) continue;
      if (!best || day > best.day) best = { order, sim, day };
    }
    return best;
  }

  /** Owner-facing: which hours the move frees and who ships earlier because of it (relative days, no dates). */
  private freedBy(job: Job, sim: Schedule) {
    const names: Record<string, string> = { LAS1: 'laser', PB1: 'press brake', MILL1: '5-axis mill', MILL2: '3-axis mill' };
    const before = this.state.schedule;
    const firstDay = Math.floor(Math.min(...before.ops.filter((o) => o.jobId === job.id).map((o) => o.start)) / 8);
    const hours = job.ops.map((o) => `${o.hours} h on the ${names[o.machineId] ?? o.machineId}`).join(' and ');
    const earlier = Object.values(sim.timing).filter((t) => t.jobId !== job.id && before.timing[t.jobId] && t.end < before.timing[t.jobId].end - 0.01);
    const who = [...new Set(earlier.map((t) => this.cust(this.state.jobs.find((j) => j.id === t.jobId)!.customerId)?.name ?? t.jobId))];
    return `frees ${hours} from ${relDay(firstDay, 'en')}; ${earlier.length ? `${earlier.length} job(s) finish earlier (${who.slice(0, 3).join(', ')})` : 'no other job changes'}`;
  }

  private moveOpen() {
    const m = this.state.move;
    return !!m && ['drafted', 'offer-sent', 'awaiting-approval'].includes(m.stage);
  }

  /**
   * The owner dragged a booked job `delayDays` working days later. Code decides whether that is allowed (firm
   * customers, stated flexibility, other promises), the slot and the price (per-job cap). If the customer must
   * agree, Claude drafts the offer in their language and the move becomes a proposal: the owner sends it, the
   * customer answers, the owner approves the money move, PayPal settles, then the schedule changes.
   */
  async reviewMove(jobId: string, delayDays: number): Promise<MoveReview> {
    const job = this.state.jobs.find((j) => j.id === jobId && j.status === 'booked');
    if (!job || job.rush) throw new Error(`No booked job ${jobId} that can be moved`);
    // A draft nobody has seen yet is simply replaced by the new drag; a sent offer must be finished first.
    if (this.moveOpen() && this.state.move!.stage !== 'drafted') throw new Error('Finish or discard the open board move first');
    if (['planned', 'offers-sent', 'awaiting-approval', 'awaiting-payment'].includes(this.state.stage)) throw new Error('A rush proposal is open: finish it before moving jobs by hand');
    const c = this.cust(job.customerId);
    if (!c) throw new Error(`Unknown customer for ${jobId}`);
    const days = Math.round(delayDays);
    const fromDay = this.state.schedule.timing[job.id]?.deliveryDay ?? job.dueDay;
    const wanted = fromDay + days;
    const base = { jobId, customerName: c.name, delayDays: days, fromDay, toDay: wanted, dueDay: job.dueDay };
    const day = (d: number) => dayLabel(this.boardStart, d, 'en');
    const done = (review: MoveReview) => {
      this.log('agent', `Board move reviewed: ${jobId} +${review.toDay - fromDay} d`, `${review.verdict === 'offer' ? 'Needs consent' : review.verdict === 'fits' ? 'Fits' : 'Refused'}: ${review.reason}`, undefined, review.offer?.compensationChf);
      return review;
    };
    if (days <= 0) return done({ ...base, verdict: 'refused', reason: `Takt only moves work later: pulling ${jobId} forward would need its material and a free machine earlier.` });
    if (!c.flexible && wanted > job.dueDay) return done({ ...base, verdict: 'refused', reason: `${c.name} is a firm promise (${c.note.replace(/\.$/, '')}). Moving ${jobId} to ${day(wanted)} would break their date, so Takt won't ask.` });
    if (wanted - job.dueDay > c.maxDelayDays) return done({ ...base, verdict: 'refused', reason: `${c.name} said they can wait at most ${c.maxDelayDays} working day(s); ${day(wanted)} is ${wanted - job.dueDay} day(s) late.` });
    const slot = this.moveSlot(jobId, wanted);
    if (!slot) return done({ ...base, verdict: 'refused', reason: `No later slot for ${jobId} up to ${day(wanted)} keeps every other promise on these machines.` });
    const toDay = slot.day;
    const frees = this.freedBy(job, slot.sim);
    const near = toDay < wanted ? ` The nearest slot that keeps every other promise ends ${day(toDay)}.` : '';
    const proposal = (review: MoveReview, offer?: BumpOffer, draftedBy?: MoveProposal['draftedBy']): MoveProposal => ({
      id: `MOVE-${jobId}-${Date.now().toString(36)}`, jobId, review, offer, draftedBy, stage: 'drafted', proposed: slot.sim,
    });
    this.pendingMove = slot.order;
    if (toDay <= job.dueDay) {
      const review: MoveReview = { ...base, toDay, verdict: 'fits', frees, reason: `${c.name} still gets ${jobId} by ${day(job.dueDay)} as promised (new delivery ${day(toDay)}). No offer and no money needed: the move ${frees}.${near}` };
      this.state.move = proposal(review);
      return done(review);
    }
    const late = toDay - job.dueDay;
    const cap = this.capLeft(job);
    if (cap <= 0) return done({ ...base, toDay, verdict: 'refused', reason: `${jobId} already got compensation up to its cap (CHF ${perJobCap(job)}); Takt won't ask ${c.name} again.` });
    const chf = Math.min(compensation(job, c, late), cap);
    const mechanism: BumpOffer['mechanism'] = job.payment.kind === 'authorization' ? 'reduced-capture' : 'payout';
    const bump: BumpDetail = { jobId, jobTitle: job.title, customerId: c.id, customerName: c.name, contact: c.contact, lang: c.lang, fromDay: job.dueDay, toDay, delayDays: late, compensationChf: chf, mechanism, capChf: cap };
    const res = await this.agent.draftMove({ bump, frees, boardStart: this.boardStart });
    this.track(res);
    this.logSteps(res.steps);
    let draft = res.value;
    const ok = draft && checkMessage(draft.message, chf, chf).ok && checkMessage(draft.messageEn, chf, chf).ok;
    if (!ok) {
      draft = templateMoveOffer(bump, this.boardStart);
      this.log('guardrail', `Template offer for ${c.name}`, 'No valid agent draft for this move, so the DE/FR/EN template is used');
    }
    const how = mechanism === 'reduced-capture' ? 'capture less at shipment' : 'PayPal Payout (prepaid)';
    const by = ok && (res.source === 'live' || res.source === 'replay') ? 'llm' : 'deterministic';
    const review: MoveReview = {
      ...base, toDay, verdict: 'offer', frees,
      reason: `Moving ${jobId} to ${day(toDay)} breaks ${c.name}'s date (${day(job.dueDay)}) by ${late} day(s). It ${frees}. Offer CHF ${chf} via ${how}; cap CHF ${cap}.${near}`,
      offer: { compensationChf: chf, capChf: cap, mechanism, lang: c.lang, message: draft.message, messageEn: draft.messageEn },
    };
    const now = new Date().toISOString();
    const offer: BumpOffer = {
      id: `OF-MOVE-${jobId}`, jobId, customerId: c.id, fromDay: job.dueDay, toDay, delayDays: late, compensationChf: chf, openingChf: chf, mechanism, lang: c.lang,
      message: draft.message, messageEn: draft.messageEn, status: 'draft', capChf: cap, thread: [{ from: 'shop', text: draft.message, textEn: draft.messageEn, at: now }],
    };
    this.state.move = proposal(review, offer, by);
    return done(review);
  }

  /** Dispatch order of the open move (code). Kept server-side, like the rush plan's pending order. */
  private pendingMove?: Job[];

  private openMove(stage: MoveProposal['stage'][]) {
    const m = this.state.move;
    if (!m || !stage.includes(m.stage)) throw new Error('No board move waiting for this step');
    return m;
  }

  /** Owner: send the drafted offer to the customer (or, if the move fits the promise, just apply it). */
  async sendMoveOffer() {
    const m = this.openMove(['drafted']);
    if (!m.offer) return this.approveMove();
    m.offer.status = 'sent';
    m.stage = 'offer-sent';
    this.log('owner', 'Board move: offer sent', `${this.cust(m.offer.customerId)!.name} (${m.offer.lang.toUpperCase()}): +${m.offer.delayDays} d for CHF ${m.offer.compensationChf}`);
    return m;
  }

  discardMove() {
    const m = this.openMove(['drafted', 'offer-sent', 'awaiting-approval']);
    m.stage = 'discarded';
    if (m.offer && m.offer.status !== 'accepted') m.offer.status = 'declined';
    this.pendingMove = undefined;
    this.log('owner', 'Board move discarded', `${m.jobId}: nothing changed, nothing paid`);
    return m;
  }

  /** The five checks shown next to "Approve & send to PayPal" for a board move (re-run at approval). */
  private moveChecks(m: MoveProposal): GuardrailCheck[] {
    const o = m.offer!;
    const job = this.state.jobs.find((j) => j.id === m.jobId)!;
    const c = this.cust(job.customerId)!;
    const cap = this.capLeft(job);
    const sim = this.pendingMove ? schedule(this.pendingMove) : undefined;
    const others = !!sim && Object.values(sim.timing).every((t) => t.jobId === job.id || !t.late);
    return [
      { label: `${c.name} accepted the move (${o.status === 'accepted' ? 1 : 0}/1)`, ok: o.status === 'accepted' },
      { label: `Compensation CHF ${o.compensationChf} within the job cap CHF ${cap} (${Math.round(POLICY.compCapShare * 100)} % of job price, minus earlier compensation)`, ok: o.compensationChf <= cap },
      { label: `New date within what ${c.name} said they can wait (${o.toDay - job.dueDay} of ${c.maxDelayDays} day(s))`, ok: c.flexible && o.toDay - job.dueDay <= c.maxDelayDays && o.toDay >= (sim?.timing[job.id]?.deliveryDay ?? 99) },
      { label: 'Every other promise still holds (planner re-check)', ok: others },
      { label: 'Payee comes from the booking record, never from message text', ok: true },
    ];
  }

  private moveAccepted(m: MoveProposal) {
    const o = m.offer!;
    const c = this.cust(o.customerId)!;
    const job = this.state.jobs.find((j) => j.id === o.jobId)!;
    const auth = job.payment.kind === 'authorization' ? job.payment.authorizedChf : 0;
    const move: MoneyMove = o.mechanism === 'payout'
      ? { id: `MV-${o.id}`, kind: 'payout', customerName: c.name, amountChf: o.compensationChf, api: 'POST /v1/payments/payouts', detail: `Now, to the PayPal account on file for ${c.name} (prepaid ${job.id})` }
      : { id: `MV-${o.id}`, kind: 'capture-less', customerName: c.name, amountChf: o.compensationChf, api: 'POST /v2/payments/authorizations/{id}/capture', detail: `At shipment of ${job.id}: capture CHF ${auth - (job.compensationChf ?? 0) - o.compensationChf} of CHF ${auth}, final_capture=true` };
    m.stage = 'awaiting-approval';
    m.approval = { moves: [move], checks: this.moveChecks(m), status: 'pending' };
    this.log('guardrail', 'Board move waiting for owner approval', `1 money move; ${m.approval.checks.filter((x) => x.ok).length}/${m.approval.checks.length} checks pass. Nothing reaches PayPal before the owner approves.`);
  }

  async approveMove() {
    return this.once('approve-move', () => this.doApproveMove());
  }

  private async doApproveMove() {
    const m = this.state.move;
    if (!m) throw new Error('No board move to approve');
    if (!m.offer) {
      // Fits the promise: no consent and no money needed; the owner's click applies it.
      if (m.stage !== 'drafted') throw new Error('Nothing to approve');
      this.log('owner', 'Owner applied the board move', `${m.jobId}: within the promised date, no money moves`);
      this.commitMove(m);
      return m;
    }
    const a = m.approval;
    if (m.stage !== 'awaiting-approval' || !a || a.status !== 'pending') throw new Error('Nothing to approve');
    a.checks = this.moveChecks(m);
    const failed = a.checks.filter((x) => !x.ok);
    if (failed.length) {
      this.log('guardrail', 'Board move approval blocked', failed.map((x) => x.label).join('; '));
      throw new Error(`Guardrail: ${failed[0].label}`);
    }
    a.status = 'approved';
    const o = m.offer;
    const c = this.cust(o.customerId)!;
    const job = this.state.jobs.find((j) => j.id === o.jobId)!;
    this.log('owner', 'Owner approved the board move', `${job.id} → ${relDay(o.toDay, 'en')}, compensation CHF ${o.compensationChf}`);
    try {
      if (o.mechanism === 'payout') {
        const receiverEmail = this.paypal.mode === 'sandbox' && this.opts.payoutReceiver ? this.opts.payoutReceiver : c.email;
        const res = await this.paypal.createPayout(`takt-${this.runId}-${m.id}`, 'Thank you for moving your delivery', [
          { receiverEmail, amount: this.money(o.compensationChf), note: `Takt: thank you for moving ${job.id}`, senderItemId: o.id },
        ]);
        this.ownIds.add(res.payoutBatchId);
        this.step(job.paypal, { label: `Board move: compensation sent by PayPal Payout to ${c.name}`, status: res.batchStatus, id: res.payoutBatchId, idKind: 'payout-batch', api: 'POST /v1/payments/payouts', amountChf: o.compensationChf, source: 'call' });
        this.log('api', `Payout to ${c.name}`, `Board move: POST /v1/payments/payouts → batch ${res.batchStatus}`, res.payoutBatchId, o.compensationChf);
      } else if (job.payment.kind === 'authorization') {
        await this.ensureRealAuthorization(job);
        this.step(job.paypal, { label: `Board move agreed: capture CHF ${o.compensationChf} less at shipment`, status: 'CREATED', id: job.payment.authorizationId, idKind: 'authorization', amountChf: o.compensationChf, source: 'call' });
        this.log('agent', `Capture-less booked for ${c.name}`, `Board move: will capture CHF ${job.payment.authorizedChf - (job.compensationChf ?? 0) - o.compensationChf} instead of ${job.payment.authorizedChf - (job.compensationChf ?? 0)} on ${job.payment.authorizationId} at shipment`, job.payment.authorizationId, o.compensationChf);
      }
    } catch (e) {
      a.status = 'pending';
      this.log('system', 'PayPal call failed during board-move approval', `${e instanceof Error ? e.message : String(e)}. Nothing changed; press Approve again to retry`);
      throw e;
    }
    job.compensationChf = (job.compensationChf ?? 0) + o.compensationChf;
    this.state.yield.compensationsChf += o.compensationChf;
    this.state.yield.netChf -= o.compensationChf;
    this.commitMove(m);
    return m;
  }

  private commitMove(m: MoveProposal) {
    const order = this.pendingMove;
    if (!order) throw new Error('Board move expired');
    const seqById = new Map(order.map((j) => [j.id, j.seq]));
    for (const j of this.state.jobs) j.seq = seqById.get(j.id) ?? j.seq;
    const job = this.state.jobs.find((j) => j.id === m.jobId)!;
    if (m.offer) job.dueDay = m.offer.toDay; // new promised date, agreed by the customer
    this.state.schedule = schedule(this.state.jobs);
    this.pendingMove = undefined;
    m.stage = 'committed';
    this.log('system', 'Board move committed', `${job.id} now ships ${relDay(this.state.schedule.timing[job.id].deliveryDay, 'en')}; ${m.review.frees ?? ''}`, undefined, m.offer?.compensationChf);
  }

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
    if (this.moveOpen()) throw new Error('Finish or discard the open board move first');
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
          mechanism: job.payment.kind === 'authorization' ? 'reduced-capture' : 'payout', capChf: this.capLeft(job),
        };
      }),
    };
  }

  async plan(excludeCustomerIds: string[] = []) {
    const rush = this.state.rush;
    if (!rush) throw new Error('No rush request');
    if (this.moveOpen()) throw new Error('Finish or discard the open board move first');
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
    const m = this.state.move;
    if (m?.offer?.id === offerId) {
      const o = m.offer;
      return { p: undefined, m, o, c: this.cust(o.customerId)!, job: this.state.jobs.find((j) => j.id === o.jobId)! };
    }
    const p = this.state.plan;
    const o = p?.offers.find((x) => x.id === offerId);
    if (!p || !o) throw new Error('Offer not found');
    return { p, m: undefined, o, c: this.cust(o.customerId)!, job: this.state.jobs.find((j) => j.id === o.jobId)! };
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
    // Board move: no rush budget behind it, so the ceiling is what is left under the job's own cap.
    const ceiling = p ? offerCeiling(p, o, this.capLeft(job)) : Math.min(o.capChf, this.capLeft(job));
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
    if (p && this.state.plan) this.recomputeTotals();
    return { decision: d, source: res.source };
  }

  private acceptOffer(o: BumpOffer, via = 'button') {
    const c = this.cust(o.customerId)!;
    o.status = 'accepted';
    o.respondedAt = new Date().toISOString();
    o.escalation = undefined;
    const m = this.state.move;
    if (m?.offer === o) {
      this.log('agent', `${c.name} accepted the board move`, `${via}: +${o.delayDays} day(s) for CHF ${o.compensationChf} (${o.mechanism === 'reduced-capture' ? 'capture less at shipment' : 'PayPal Payout'}); queued for owner approval`, undefined, o.compensationChf);
      this.moveAccepted(m);
      return;
    }
    this.recomputeTotals();
    this.log('agent', `${c.name} accepted`, `${via}: +${o.delayDays} day(s) for CHF ${o.compensationChf} (${o.mechanism === 'reduced-capture' ? 'capture less at shipment' : 'PayPal Payout'}); queued for owner approval`, undefined, o.compensationChf);
    this.maybeRequestApproval();
  }

  private async declineOffer(o: BumpOffer, why: string) {
    const c = this.cust(o.customerId)!;
    o.status = 'declined';
    o.respondedAt = new Date().toISOString();
    const m = this.state.move;
    if (m?.offer === o) {
      m.stage = 'declined';
      this.pendingMove = undefined;
      this.log('agent', `${c.name} declined the board move`, `${why}. Their date stays; nothing changed, nothing paid`);
      return;
    }
    const p = this.state.plan!;
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
    // Room left under each job's cap; a retried approval adds back what this plan already booked on that job.
    const done = new Set(this.state.approval?.doneMoveIds ?? []);
    const back = new Map((this.state.plan?.offers ?? []).filter((o) => done.has(`MV-${o.id}`)).map((o) => [o.jobId, o.compensationChf]));
    return Object.fromEntries(this.state.jobs.map((j) => [j.id, this.capLeft(j) + (back.get(j.id) ?? 0)]));
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
      if (o.mechanism === 'payout') {
        // Payee from the booking record (or the sandbox test account), never from a message.
        const receiverEmail = this.paypal.mode === 'sandbox' && this.opts.payoutReceiver ? this.opts.payoutReceiver : c.email;
        // sender_batch_id is unique per run and plan: PayPal rejects a repeat, so a retry can never pay twice.
        const res = await this.paypal.createPayout(`takt-${this.runId}-${p.id}-${job.id}`, 'Thank you for moving your slot', [
          { receiverEmail, amount: this.money(o.compensationChf), note: `Takt: thank you for moving ${job.id}`, senderItemId: o.id },
        ]);
        this.ownIds.add(res.payoutBatchId);
        this.step(job.paypal, { label: `Compensation sent by PayPal Payout to ${c.name}`, status: res.batchStatus, id: res.payoutBatchId, idKind: 'payout-batch', api: 'POST /v1/payments/payouts', amountChf: o.compensationChf, source: 'call' });
        this.log('api', `Payout to ${c.name}`, `POST /v1/payments/payouts → batch ${res.batchStatus}`, res.payoutBatchId, o.compensationChf);
      } else if (job.payment.kind === 'authorization') {
        await this.ensureRealAuthorization(job);
        this.step(job.paypal, { label: `Agreed: capture CHF ${o.compensationChf} less at shipment`, status: 'CREATED', id: job.payment.authorizationId, idKind: 'authorization', amountChf: o.compensationChf, source: 'call' });
        this.log('agent', `Capture-less booked for ${c.name}`, `Will capture CHF ${job.payment.authorizedChf - (job.compensationChf ?? 0) - o.compensationChf} instead of ${job.payment.authorizedChf - (job.compensationChf ?? 0)} on ${job.payment.authorizationId} at shipment (final_capture=true releases the rest)`, job.payment.authorizationId, o.compensationChf);
      }
      // Added, not replaced: a job moved on the board earlier keeps that compensation too.
      job.compensationChf = (job.compensationChf ?? 0) + o.compensationChf;
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
      locale: this.opts.locale ?? 'en-CH',
    });
    this.ownIds.add(order.orderId);
    this.state.rushOrder = { orderId: order.orderId, status: 'created', amountChf: p.rushPriceChf, approveUrl: order.approveUrl, paypal: [] };
    this.step(this.state.rushOrder.paypal, { label: 'Rush order created (hold only, nothing charged)', status: order.status, id: order.orderId, idKind: 'order', api: 'POST /v2/checkout/orders intent=AUTHORIZE', amountChf: p.rushPriceChf, source: 'call' });
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
    this.buyerCancelled(o.orderId, 'mock');
  }

  /** Does this demo own that PayPal order? (Return / cancel redirects carry only the order id.) */
  ownsOrder(orderId: string) {
    return !!orderId && this.state.rushOrder?.orderId === orderId;
  }

  /** PayPal sent the buyer to cancel_url: nothing was charged, the same approval link stays valid. */
  buyerCancelled(orderId: string, via: 'redirect' | 'sdk' | 'mock' = 'redirect') {
    const o = this.state.rushOrder;
    if (!o || o.orderId !== orderId || o.status !== 'created') return false;
    o.cancelledAt = new Date().toISOString();
    const text = via === 'sdk'
      ? 'The rush customer closed the PayPal window without approving. Nothing was charged, and the PayPal button still works if they try again.'
      : 'The rush customer cancelled on the PayPal page. Nothing was charged, and the same PayPal link still works if they try again.';
    this.state.paypalNotice = { kind: 'cancelled', text, at: o.cancelledAt };
    this.step(o.paypal, { label: 'Buyer cancelled in PayPal (order stays open)', status: 'PAYER_ACTION_REQUIRED', id: orderId, idKind: 'order', source: 'buyer' });
    this.log('system', 'Buyer cancelled in PayPal', `${text} (${via === 'sdk' ? 'JS SDK onCancel' : via === 'mock' ? 'mock' : 'redirect to cancel_url'})`, orderId);
    return true;
  }

  async authorizeRush(orderId: string, via: 'sdk' | 'redirect' | 'webhook' = 'webhook') {
    const o = this.state.rushOrder;
    // JS SDK onApprove, return-URL redirect and the reconcile poll can all arrive: only the first one authorizes.
    if (!o || o.orderId !== orderId || o.status !== 'created') return;
    o.status = 'approved';
    this.step(o.paypal, { label: `Buyer approved in PayPal (${via === 'sdk' ? 'JS SDK v6 onApprove' : via === 'redirect' ? 'redirect to return_url' : 'after CHECKOUT.ORDER.APPROVED'})`, status: 'APPROVED', id: orderId, idKind: 'order', source: 'buyer' });
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
    o.expiresAt = a.expirationTime;
    this.ownIds.add(a.authorizationId);
    this.step(o.paypal, { label: `Payment authorized: CHF ${a.amount.value} held${a.expirationTime ? ` until ${a.expirationTime.slice(0, 10)}` : ''} (honor period 3 days)`, status: a.status, id: a.authorizationId, idKind: 'authorization', api: 'POST /v2/checkout/orders/{id}/authorize', amountChf: a.amount.value, source: 'call' });
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
    this.trailFromEvent(e);
    if (e.event_type === 'CHECKOUT.ORDER.APPROVED' && r.id === this.state.rushOrder?.orderId) {
      // The reconcile poll is the backstop: give the buyer's own callback (JS SDK onApprove or the return_url
      // redirect) a head start, so the timeline shows how the buyer really approved.
      if (e.id.startsWith('RECON-')) await new Promise((res) => setTimeout(res, this.opts.reconcileGraceMs ?? 4000));
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

  /** PayPal confirmations (webhooks or reconcile polls) go onto the timeline of the job they belong to. */
  private trailFromEvent(e: PayPalWebhookEvent) {
    const r = e.resource as Record<string, any>;
    const how = e.id.startsWith('RECON-') ? 'reconciled' : 'webhook';
    const ro = this.state.rushOrder;
    const rel = r.supplementary_data?.related_ids ?? {};
    const forRush = ro && [r.id, rel.order_id, rel.authorization_id].some((x) => x && (x === ro.orderId || x === ro.authorizationId));
    const trail = forRush && this.state.stage !== 'committed' ? ro!.paypal : (this.jobOf(r.id) ?? this.jobOf(rel.authorization_id) ?? this.jobOf(r.payout_batch_id))?.paypal ?? (forRush ? ro!.paypal : undefined);
    const label: Record<string, string> = {
      'CHECKOUT.ORDER.APPROVED': 'PayPal confirms: order approved',
      'PAYMENT.AUTHORIZATION.CREATED': 'PayPal confirms: authorization active',
      'PAYMENT.AUTHORIZATION.VOIDED': 'PayPal confirms: hold released (voided)',
      'PAYMENT.CAPTURE.COMPLETED': 'PayPal confirms: capture completed',
      'PAYMENT.CAPTURE.REFUNDED': 'PayPal confirms: refund completed',
      'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'PayPal confirms: payout received',
      'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': 'PayPal: payout unclaimed (receiver has no account yet)',
    };
    if (!trail || !label[e.event_type]) return;
    const kind: PayPalStep['idKind'] = e.resource_type === 'checkout-order' ? 'order' : e.resource_type === 'authorization' ? 'authorization' : e.resource_type === 'capture' ? 'capture' : e.resource_type === 'refund' ? 'refund' : 'payout-batch';
    this.step(trail, { label: `${label[e.event_type]} (${how})`, status: String(r.status ?? r.transaction_status ?? ''), id: kind === 'payout-batch' ? r.payout_batch_id : r.id, idKind: kind, api: e.event_type, source: 'confirmed' });
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
    const rj: Job = { ...res.rushJob, id: `R-${rush.id}`, priceChf: p.rushPriceChf, payment: { kind: 'authorization', orderId: o.orderId, authorizationId: o.authorizationId!, authorizedChf: p.rushPriceChf }, paypal: o.paypal };
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
      j.captureId = cap.captureId;
      this.step(j.paypal, { label: `Shipped: captured CHF ${amount}${comp ? ` of ${j.payment.authorizedChf}; CHF ${comp} never charged` : ''} (final_capture releases the rest)`, status: cap.status, id: cap.captureId, idKind: 'capture', api: 'POST /v2/payments/authorizations/{id}/capture', amountChf: amount, source: 'call' });
      this.log('api', `Captured ${j.id}`, `POST /v2/payments/authorizations/{id}/capture CHF ${amount}${comp ? ` (authorized ${j.payment.authorizedChf}, −${comp} compensation)` : ''}, final_capture=true`, cap.captureId, amount);
    }
    j.status = 'shipped';
    this.state.schedule = schedule(this.state.jobs);
    return j;
  }

  /** Cancel before shipment: void the authorization, so the hold is released and nothing is ever charged. */
  async cancel(jobId: string) {
    return this.once(`cancel-${jobId}`, () => this.doCancel(jobId));
  }

  private async doCancel(jobId: string) {
    const j = this.state.jobs.find((x) => x.id === jobId);
    if (!j || j.status !== 'booked') throw new Error('Job not cancellable');
    await this.ensureRealAuthorization(j);
    if (j.payment.kind === 'authorization') {
      const v = await this.paypal.voidAuthorization(j.payment.authorizationId);
      this.step(j.paypal, { label: 'Cancelled before shipment: hold released, nothing charged', status: v.status, id: j.payment.authorizationId, idKind: 'authorization', api: 'POST /v2/payments/authorizations/{id}/void', amountChf: j.payment.authorizedChf, source: 'call' });
      this.log('api', `Voided ${j.id}`, `POST /v2/payments/authorizations/{id}/void → ${v.status}: CHF ${j.payment.authorizedChf} hold released`, j.payment.authorizationId, j.payment.authorizedChf);
    }
    j.status = 'cancelled';
    if (j.rush) this.rushCancelled(j, 'void');
    this.state.schedule = schedule(this.state.jobs);
    return j;
  }

  /** Cancelled after shipment (parts returned): refund the capture in full. */
  async refund(jobId: string) {
    return this.once(`refund-${jobId}`, () => this.doRefund(jobId));
  }

  private async doRefund(jobId: string) {
    const j = this.state.jobs.find((x) => x.id === jobId);
    if (!j || j.status !== 'shipped' || !j.captureId) throw new Error('Nothing to refund: ship the job first');
    const r = await this.paypal.refundCapture(j.captureId, undefined, `Takt: ${j.id} cancelled, full refund.`);
    this.ownIds.add(r.refundId);
    this.step(j.paypal, { label: `Cancelled after shipment: CHF ${r.amount.value} refunded to the buyer`, status: r.status, id: r.refundId, idKind: 'refund', api: 'POST /v2/payments/captures/{id}/refund', amountChf: r.amount.value, source: 'call' });
    this.log('api', `Refunded ${j.id}`, `POST /v2/payments/captures/{id}/refund → ${r.status}`, r.refundId, r.amount.value);
    j.status = 'cancelled';
    if (j.rush) this.rushCancelled(j, 'refund');
    this.state.schedule = schedule(this.state.jobs);
    return j;
  }

  /** The rush premium is gone; the bumped customers keep what they agreed (they waited in good faith). */
  private rushCancelled(j: Job, via: 'void' | 'refund') {
    j.cancelledVia = via;
    const p = this.state.plan;
    if (!p) return;
    this.state.yield.premiumsChf -= p.rushPremiumChf;
    this.state.yield.netChf -= p.rushPremiumChf;
    this.state.yield.rushJobsWon -= 1;
    this.log('system', 'Rush cancelled', `${via === 'void' ? 'Authorization voided before shipment' : 'Capture refunded'}; premium CHF ${p.rushPremiumChf} lost. Bumped customers keep their compensation (CHF ${p.compensationTotalChf}) and new dates.`, undefined, -p.compensationTotalChf);
  }

  /** "Check in PayPal": read the job's current authorization / capture / payout straight from the API. */
  async checkPayPal(jobId: string) {
    const j = this.state.jobs.find((x) => x.id === jobId);
    if (!j) throw new Error('Unknown job');
    const out: string[] = [];
    if (j.payment.kind === 'authorization') {
      const seed = j.payment.authorizationId.startsWith('SEED-AUTH');
      // A placeholder booking the mock has never seen has no PayPal object yet: say so instead of failing.
      const a = await this.paypal.getAuthorization(j.payment.authorizationId).catch((e) => { if (seed) return undefined; throw e; });
      if (a) {
      this.step(j.paypal, { label: 'Live check: authorization', status: a.status, id: a.authorizationId, idKind: 'authorization', api: 'GET /v2/payments/authorizations/{id}', amountChf: a.amount.value, source: 'live-check' });
      out.push(`authorization ${a.status}`);
      }
    }
    if (j.captureId) {
      const c = await this.paypal.getCapture(j.captureId);
      this.step(j.paypal, { label: 'Live check: capture', status: c.status, id: c.captureId, idKind: 'capture', api: 'GET /v2/payments/captures/{id}', amountChf: c.amount.value, source: 'live-check' });
      out.push(`capture ${c.status}`);
    }
    for (const id of new Set(j.paypal?.filter((x) => x.idKind === 'payout-batch' && x.id).map((x) => x.id!))) {
      const p = await this.paypal.getPayout(id);
      const it = p.items?.[0];
      this.step(j.paypal, { label: `Live check: payout${it?.fee ? ` (PayPal fee ${it.fee.currency} ${it.fee.value})` : ''}`, status: it?.status ?? p.batchStatus, id, idKind: 'payout-batch', api: 'GET /v1/payments/payouts/{id}', source: 'live-check' });
      out.push(`payout ${it?.status ?? p.batchStatus}`);
    }
    if (!out.length) out.push('nothing on PayPal yet (placeholder booking: Takt creates the real authorization the first time it touches it)');
    this.log('api', `Checked ${j.id} in PayPal`, out.join(', '));
    return out;
  }
}
