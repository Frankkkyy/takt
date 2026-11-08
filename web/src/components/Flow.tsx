import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { DemoState, Job, RushRequest } from '../../../shared/types';
import { chf, dayLong, MACHINE_SHORT, plural, post } from '../api';
import { OfferCard, withParagraphs } from './Offer';
import { RUSH_SAMPLES } from '../samples';
import { PayPalTrail, RushCheckout } from './PayPal';

function AgentTag({ by, state }: { by: 'llm' | 'deterministic'; state: DemoState }) {
  const a = state.agent;
  const how = a.last === 'live' ? 'live' : a.last === 'replay' ? 'recorded' : a.last === 'fallback' ? 'fallback' : '';
  return by === 'llm'
    ? <span className="agent-tag llm">Claude {a.model.replace('claude-', '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/^\w/, (c) => c.toUpperCase())}{how && how !== 'fallback' ? ` · ${how}` : ''}</span>
    : <span className="agent-tag rules">rules{a.last === 'fallback' ? ' · fallback' : ''}</span>;
}

/** Long agent text, shown as a quote clamped to a few lines with "Read all"; the recorded text is never shortened. */
function ClampedQuote({ text, lines = 3 }: { text: string; lines?: number }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(open || el.scrollHeight > el.clientHeight + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  return (
    <>
      <p ref={ref} className={`quote${open ? '' : ' clamped'}`} style={{ WebkitLineClamp: open ? undefined : lines }}>{text}</p>
      {overflows && (
        <button type="button" className="link small more-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Read all'}
        </button>
      )}
    </>
  );
}

const STEPS: { key: DemoState['stage'][]; label: string }[] = [
  { key: ['idle', 'intake'], label: 'Request' },
  { key: ['planned'], label: 'Make room' },
  { key: ['offers-sent'], label: 'Offers' },
  { key: ['awaiting-approval'], label: 'Owner OK' },
  { key: ['awaiting-payment'], label: 'Rush pays' },
  { key: ['committed'], label: 'Committed' },
];

/* ---------- Narrative headlines: one plain-English sentence per step, built from live data (≤ ~12 words) ---------- */
const NUM_WORD = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];
const numWord = (n: number) => NUM_WORD[n] ?? String(n);
const WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
/** "Tuesday" this week; "Mon 16 Nov" further out, so it never reads as the wrong week. */
const dayWord = (state: DemoState, day: number) => (day < 5 ? WEEKDAY[day % 5] : dayLong(state.boardStartIso, day));
/** "the brackets" from "Header brackets for combine (rush)"; "the parts" when the title is not a simple noun. */
function partsOf(r: RushRequest): string {
  const core = r.title.replace(/\([^)]*\)/g, '').split(/\s+for\s+|,|;/)[0].trim();
  const word = core.split(/\s+/).pop()?.toLowerCase() ?? '';
  if (!/^[a-z-]{3,16}$/.test(word)) return 'the parts';
  return r.qty === 1 || /s$/.test(word) ? `the ${word}` : 'the parts';
}
const andList = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

function storyHeadline(state: DemoState, primedStory: boolean): string {
  const { plan, stage } = state;
  // Names never break across lines in a headline ("Hof / Schmid").
  const nb = (s: string) => s.replace(/ /g, '\u00a0');
  const rush = state.rush && { ...state.rush, customer: { ...state.rush.customer, name: nb(state.rush.customer.name) } };
  const name = (id: string) => nb(state.customers.find((c) => c.id === id)?.name ?? id);
  switch (stage) {
    case 'idle':
    case 'intake': {
      if (state.intakeQuestion && !rush) return 'Takt needs a few more details first.';
      if (!rush) return primedStory ? 'Hof\u00a0Schmid needs six brackets by Tuesday.' : 'A rush order lands in a full week.';
      const by = dayWord(state, rush.dueDay);
      if (rush.firstFitDay !== undefined && rush.firstFitDay > rush.dueDay) return `${rush.customer.name} needs ${partsOf(rush)} by ${by}. The shop is full.`;
      return `${rush.customer.name} needs ${partsOf(rush)} by ${by}. There is room.`;
    }
    case 'planned': {
      if (!plan || !rush) return 'Takt can make room.';
      if (!plan.feasible) return 'No room this time. Nobody is asked to wait.';
      const n = plan.offers.length;
      const gets = `${rush.customer.name} gets ${partsOf(rush)} ${dayWord(state, rush.dueDay)}.`;
      if (!n) return `Nobody has to move. ${gets}`;
      const d = Math.max(...plan.offers.map((o) => o.delayDays));
      const same = plan.offers.every((o) => o.delayDays === d);
      const wait = same ? (d === 1 ? 'one day' : `${numWord(d).toLowerCase()} days`) : `up to ${plural(d, 'day')}`;
      return `${numWord(n)} ${n === 1 ? 'customer waits' : 'customers wait'} ${wait}. ${gets}`;
    }
    case 'offers-sent': {
      const offers = plan?.offers ?? [];
      const needsYou = offers.find((o) => o.status === 'sent' && o.escalation);
      if (needsYou) return `${name(needsYou.customerId)}'s reply needs you.`;
      const agreed = offers.filter((o) => o.status === 'accepted').map((o) => name(o.customerId));
      const waiting = offers.filter((o) => o.status === 'sent').map((o) => name(o.customerId));
      if (!waiting.length) return 'Answers are in.';
      return agreed.length ? `${andList(agreed)} agreed. Waiting for ${andList(waiting)}.` : `Waiting for ${andList(waiting)}.`;
    }
    case 'awaiting-approval': {
      const n = plan?.offers.length ?? 0;
      if (n === 1 && plan) return `${name(plan.offers[0].customerId)} agreed. Your approval moves the money.`;
      return n ? 'Everyone agreed. Your approval moves the money.' : 'Your approval opens the rush checkout.';
    }
    case 'awaiting-payment':
      return rush ? `${rush.customer.name} pays with PayPal: a hold, not a charge.` : 'The rush customer pays with PayPal.';
    case 'committed':
      if (state.jobs.some((j) => j.rush && j.status === 'cancelled')) return 'Rush cancelled. PayPal released the hold.';
      return 'PayPal confirmed. The rush is on the board.';
  }
}

/** Eyebrow (the step's name, small) above the story headline (the h2 the keyboard focus lands on). */
function StepHead({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <header className="step-head">
      <span className="eyebrow">{eyebrow}</span>
      <h2 tabIndex={-1}>{children}</h2>
    </header>
  );
}

/** Progress stepper: numbered, done steps get a check, the current one is marked for screen readers too. */
function Stepper({ steps, active, mini = false, label }: { steps: { label: string }[]; active: number; mini?: boolean; label: string }) {
  return (
    <ol className={`steps${mini ? ' mini' : ''}`} aria-label={label}>
      {steps.map((s, i) => (
        <li key={s.label} className={i < active ? 'done' : i === active ? 'active' : ''} aria-current={i === active ? 'step' : undefined}>
          {s.label}{i < active && <span className="sr-only"> (done)</span>}
        </li>
      ))}
    </ol>
  );
}

/** A headline number. */
function Stat({ label, value, note, className = '' }: { label: string; value: string; note?: string; className?: string }) {
  return (
    <div className={`stat ${className}`}>
      <small>{label}</small>
      <b>{value}</b>
      {note && <span>{note}</span>}
    </div>
  );
}

/** Loading placeholder while the agent works (replays are fast; live Claude takes a few seconds). */
function Working({ title, lines = 3 }: { title: string; lines?: number }) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <div className="sk-head"><span className="dot" />{title}</div>
      {Array.from({ length: lines }, (_, i) => <div key={i} className={`sk-line ${['', 'w80', 'w60', 'w40'][i % 4]}`} />)}
    </div>
  );
}

function GuardrailChecks({ checks }: { checks: { label: string; ok: boolean }[] }) {
  const ok = checks.filter((c) => c.ok).length;
  return (
    <>
      <div className="checks-head">
        <span>Guardrail checks (code)</span>
        <span className={`tag${ok === checks.length ? '' : ' fail'}`}>{ok} of {checks.length} pass</span>
      </div>
      <ul className="checks">
        {checks.map((x) => <li key={x.label} className={x.ok ? 'ok' : 'fail'}><span className="ck" aria-hidden>{x.ok ? '✓' : '✗'}</span><span><span className="sr-only">{x.ok ? 'Pass: ' : 'Fail: '}</span>{x.label}</span></li>)}
      </ul>
    </>
  );
}

const MOVE_ICON: Record<string, string> = { payout: '↗', 'capture-less': '−', 'rush-authorize': '⏸' };

/** Shown whenever Claude was not used for the last step (limits, no key, API error): the demo never hides it. */
function FallbackNote({ state }: { state: DemoState }) {
  const a = state.agent;
  if (a.configured !== 'llm' || a.last !== 'fallback') return null;
  return (
    <p className="callout warn small" role="status">
      <b>Rules fallback:</b> Claude was not used for this step ({a.fallbackReason ?? 'unavailable'}). The rule-based agent
      answered with the same guardrails. The scripted demo inputs (chips) still replay recorded Claude output.
    </p>
  );
}

type Run = (label: string, path: string, body?: unknown) => Promise<void>;

/** One job in Settle: what PayPal will capture (or already did), its actions and its PayPal timeline. */
/** A job that PayPal can still capture on shipment. */
const canShip = (j: Job) => j.payment.kind === 'authorization' && j.status === 'booked';

function SettleJob({ job: j, state, busy, run, next = true }: { job: Job; state: DemoState; busy: string | null; run: Run; next?: boolean }) {
  const rush = state.rush;
  const auth = j.payment.kind === 'authorization' ? j.payment : undefined;
  const comp = j.compensationChf ?? 0;
  return (
    <div className="settle-job" data-job={j.id}>
      <div className="offer-row">
        <b>{j.id} · {state.customers.find((c) => c.id === j.customerId)?.name ?? (j.rush ? rush?.customer.name : '')}{j.rush ? ' (rush)' : ''} {auth ? <span className="pp-tag">{j.rush ? 'PayPal hold' : comp ? 'capture less' : 'PayPal hold'}</span> : <span className="pp-tag">PayPal Payout</span>}</b>
        <span>{j.status === 'cancelled'
          ? <span className="bad-text">✕ cancelled: {j.cancelledVia === 'refund' ? `${chf(auth?.authorizedChf ?? 0)} refunded` : 'hold voided, nothing charged'}</span>
          : j.status === 'shipped'
            ? <span className="good">✓ {auth ? `captured ${chf(auth.authorizedChf - comp)} of ${chf(auth.authorizedChf)}${comp ? `: ${chf(comp)} less, no refund, no second payment` : ''}` : 'shipped'}</span>
            : auth
              ? <>capture {chf(auth.authorizedChf - comp)}{comp ? <small className="muted"> of {chf(auth.authorizedChf)}</small> : null}</>
              : 'prepaid · compensation paid out'}</span>
        <span className="settle-actions">
          {auth && j.status === 'booked' && <button className={`btn small ${next ? 'primary' : 'ghost dark'}`} disabled={!!busy} onClick={() => run('ship' + j.id, `/api/jobs/${j.id}/ship`)} title={next ? 'Next job to ship' : undefined}>Ship</button>}
          {j.rush && j.status === 'booked' && <button className="btn small ghost dark" disabled={!!busy} onClick={() => run('cancel' + j.id, `/api/jobs/${j.id}/cancel`)} title="POST /v2/payments/authorizations/{id}/void">Cancel rush (void)</button>}
          {j.rush && j.status === 'shipped' && <button className="btn small ghost dark" disabled={!!busy} onClick={() => run('refund' + j.id, `/api/jobs/${j.id}/refund`)} title="POST /v2/payments/captures/{id}/refund">Parts returned: refund</button>}
        </span>
      </div>
      <details className="pp-box">
        <summary>PayPal timeline ({j.paypal?.length ?? 0})</summary>
        <PayPalTrail steps={j.paypal ?? []} mode={state.modes.paypal} />
        <button className={`btn small ghost dark${busy === 'check' + j.id ? ' is-busy' : ''}`} disabled={!!busy} onClick={() => run('check' + j.id, `/api/jobs/${j.id}/paypal-check`)}>{busy === 'check' + j.id ? 'Asking PayPal…' : 'Check in PayPal'}</button>
      </details>
    </div>
  );
}


const MOVE_STEPS: { key: string[]; label: string }[] = [
  { key: ['drafted'], label: 'Drag' },
  { key: ['offer-sent'], label: 'Offer' },
  { key: ['awaiting-approval'], label: 'Owner OK' },
  { key: ['committed'], label: 'Moved' },
];

/**
 * The owner's board move. Same path as the agent's proposals: Claude drafts the offer, the owner sends it, the
 * customer answers (the agent negotiates within the cap), the owner approves the money move with the guardrail
 * checklist, PayPal settles, then the schedule changes.
 */
function MoveCard({ state, onState, busy, run }: { state: DemoState; onState: (s: DemoState) => void; busy: string | null; run: Run }) {
  const [showEn, setShowEn] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);
  const m = state.move;
  if (!m || m.stage === 'discarded' || hidden === m.id) return null;
  const r = m.review;
  const o = m.offer;
  const c = state.customers.find((x) => x.id === state.jobs.find((j) => j.id === m.jobId)?.customerId);
  const job = state.jobs.find((j) => j.id === m.jobId);
  const active = MOVE_STEPS.findIndex((s) => s.key.includes(m.stage));
  const open = ['drafted', 'offer-sent', 'awaiting-approval'].includes(m.stage);
  return (
    <section className="card move-card" data-move-stage={m.stage}>
      <div className="move-head">
        <h2 tabIndex={-1}>Board move · {m.jobId} {c?.name}</h2>
        {!open && <button className="close" aria-label="Dismiss" onClick={() => setHidden(m.id)}>×</button>}
      </div>
      <Stepper steps={MOVE_STEPS} active={active} mini label="Board move progress" />
      <div className="kv kv-left"><span>Delivery</span><b>{dayLong(state.boardStartIso, r.fromDay)} → {dayLong(state.boardStartIso, o?.toDay ?? r.toDay)}</b>{o && <small className="muted">promised {dayLong(state.boardStartIso, r.dueDay)}</small>}</div>
      {r.frees && <div className="kv kv-left"><span>Why</span><span className="kv-text">It {r.frees}</span></div>}
      {o && (
        <div className="kv kv-left"><span>Compensation</span><b>{chf(o.compensationChf)}</b><span className="pp-tag">{o.mechanism === 'reduced-capture' ? 'capture less' : 'Payout'}</span><small className="muted">cap {chf(o.capChf)} (code)</small></div>
      )}
      {m.stage === 'drafted' && o && (
        <>
          <div className="why">
            <div className="why-head"><b>Offer to {c?.contact}</b>{m.draftedBy && <AgentTag by={m.draftedBy} state={state} />}</div>
            <p><span className="lang">{o.lang.toUpperCase()}</span> {showEn ? withParagraphs(o.messageEn, o.message) : o.message}</p>
            {o.lang !== 'en' && <button className="linkish" onClick={() => setShowEn((v) => !v)}>{showEn ? 'Original' : 'Show English'}</button>}
          </div>
          <p className="muted small">Nothing moves or pays yet. The customer can say yes, no, or answer in their own words; then you approve the money move.</p>
          <div className="row-actions">
            <button className="btn primary" id="move-send" disabled={!!busy} onClick={() => run('move-send', '/api/move/send')}>Send offer to {c?.name}</button>
            <button className="btn ghost dark" disabled={!!busy} onClick={() => run('move-discard', '/api/move/discard')}>Discard</button>
          </div>
        </>
      )}
      {m.stage === 'drafted' && !o && (
        <>
          <p className="callout good small">{r.reason}</p>
          <div className="row-actions">
            <button className="btn primary" id="move-apply" disabled={!!busy} onClick={() => run('move-apply', '/api/move/approve')}>Apply move (no money)</button>
            <button className="btn ghost dark" disabled={!!busy} onClick={() => run('move-discard', '/api/move/discard')}>Discard</button>
          </div>
        </>
      )}
      {m.stage === 'awaiting-approval' && m.approval && (
        <div className="approval">
          <h3>Approve the money move</h3>
          <p className="muted small">{c?.name} agreed. Nothing has reached PayPal yet.</p>
          <ul className="moves">
            {m.approval.moves.map((mv) => (
              <li key={mv.id}>
                <span className="mv-ico" aria-hidden>{MOVE_ICON[mv.kind] ?? '·'}</span>
                <div><b>{mv.kind === 'payout' ? 'Payout' : 'Capture less'}</b> · {mv.customerName}</div>
                <div className="amt">−{chf(mv.amountChf)}</div>
                <small><code>{mv.api}</code> {mv.detail}</small>
              </li>
            ))}
          </ul>
          <GuardrailChecks checks={m.approval.checks} />
          <div className="row-actions">
            <button className="btn primary" id="move-approve" disabled={!!busy || !m.approval.checks.every((x) => x.ok)} onClick={() => run('move-approve', '/api/move/approve')}>
              {busy === 'move-approve' ? 'Moving money…' : 'Approve & send to PayPal'}
            </button>
            <button className="btn ghost dark" disabled={!!busy} onClick={() => run('move-discard', '/api/move/discard')}>Discard</button>
          </div>
        </div>
      )}
      {o && (m.stage === 'offer-sent' || m.stage === 'awaiting-approval') && (
        <div className="phone-wrap">
          <a className="open-phone" href={`#/offer/${o.id}`} target="_blank" rel="noreferrer">Open {c?.name}'s page on a phone ↗</a>
          <OfferCard offer={o} state={state} onState={onState} />
          {m.stage === 'offer-sent' && <button className="btn small ghost dark" disabled={!!busy} onClick={() => run('move-discard', '/api/move/discard')}>Withdraw offer</button>}
        </div>
      )}
      {m.stage === 'declined' && <p className="callout warn small" role="status">{c?.name} said no. Their date stays; nothing moved, nothing was paid.</p>}
      {m.stage === 'committed' && (
        <>
          <p className="callout good small">{o ? `Moved with ${c?.name}'s consent; ${o.mechanism === 'payout' ? 'PayPal Payout sent' : `CHF ${o.compensationChf} less is captured at shipment`}.` : 'Moved within the promised date; no money involved.'}</p>
          {o && job && <div className="settle"><SettleJob job={job} state={state} busy={busy} run={run} /></div>}
        </>
      )}
    </section>
  );
}

const STORY_FROM = 'Grüezi Marco, am Mähdrescher';

export function Flow({ state, onState, draft: text, setDraft: setText, primed = 0, onPrime }: { state: DemoState; onState: (s: DemoState) => void; draft: string; setDraft: (t: string) => void; primed?: number; onPrime?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (label: string, path: string, body?: unknown) => {
    setBusy(label);
    setErr(null);
    try {
      const r = await post(path, body);
      onState(r.state);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(null);
    }
  };
  const { rush, plan, stage } = state;
  const active = STEPS.findIndex((s) => s.key.includes(stage));

  // Keyboard users: when a step replaces the card they were in, continue from the new step's heading.
  const ref = useRef<HTMLElement>(null);
  const prevStage = useRef(stage);
  useEffect(() => {
    if (prevStage.current === stage) return;
    prevStage.current = stage;
    const a = document.activeElement;
    if (a && a !== document.body && ref.current && !ref.current.contains(a)) return;
    if (a && a !== document.body && a.isConnected) return;
    ref.current?.querySelector<HTMLElement>('.step-card h2')?.focus({ preventScroll: true });
  }, [stage]);

  const customer = (id: string) => state.customers.find((c) => c.id === id);
  const fmtSigned = (n: number) => `${n < 0 ? '−' : '+'}${chf(Math.abs(n))}`;
  const settleJobs = state.jobs.filter((j) => (j.rush || j.compensationChf) && (j.status !== 'cancelled' || j.rush));
  const nextShip = settleJobs.find(canShip);
  const headline = storyHeadline(state, !!primed && text.startsWith(STORY_FROM));

  return (
    <aside className="flow" id="flow" ref={ref} aria-label="Current step" tabIndex={-1}>
      <Stepper steps={STEPS} active={active} label="Rush order progress" />
      <FallbackNote state={state} />
      <MoveCard state={state} onState={onState} busy={busy} run={run} />

      {(stage === 'idle' || stage === 'intake') && (
        <section className={`card step-card intake-card${primed ? ' primed' : ''}`} key={`intake-${primed}`} data-step="request">
          <StepHead eyebrow="Request">{headline}</StepHead>
          {!primed && !rush && <p className="muted small intro">Start with the email in the banner above (<b>Open request</b>), or paste any request in German, French or English.</p>}
          {!rush && text.startsWith(STORY_FROM) && (
            <div className="mail-from"><span aria-hidden>✉</span><span><b>Thomas Schmid</b> · Hof Schmid (farm), Escholzmatt</span></div>
          )}
          <div className="intake">
            <div className="photo" aria-label="Photo of the broken bracket" role="img">
              <svg viewBox="0 0 80 60" width="72" height="54" aria-hidden><rect width="80" height="60" rx="6" fill="#eceef2" /><path d="M14 46 L14 16 L40 16 L40 26 L26 26 L26 46 Z" fill="#8a93a3" /><path d="M30 18 l6 8 l-3 2 l4 6" stroke="#b42318" strokeWidth="2" fill="none" /><circle cx="20" cy="40" r="3" fill="#eceef2" /></svg>
              <small>photo.jpg</small>
            </div>
            <textarea aria-label="Rush request text" value={text} onChange={(e) => setText(e.target.value)} rows={5} />
          </div>
          <div className="chips" role="group" aria-label="Sample requests">
            {RUSH_SAMPLES.map((s) => <button key={s.label} className="chip" onClick={() => { setText(s.text); onPrime?.(); }}>{s.label}</button>)}
          </div>
          <button id="read-request" className={`btn block ${primed && !rush ? 'primary' : 'ghost dark'}${busy === 'intake' ? ' is-busy' : ''}`} disabled={!!busy || !text.trim()} onClick={() => run('intake', '/api/rush/intake', { text })}>
            {busy === 'intake' ? 'Agent is reading…' : 'Let Takt read it'}
          </button>
          {busy === 'intake' && <Working title="Claude is reading the request and recording the job…" lines={4} />}
          {state.intakeQuestion && !rush && busy !== 'intake' && (
            <p className="callout warn icon" role="alert">
              <span className="ci" aria-hidden>?</span>
              <span><b>Takt needs a bit more.</b> It could not find the {state.intakeQuestion.missing.join(', ') || 'job details'} in this request, so nothing was planned and no order was invented.
              Add them (for example "6 brackets S355 8 mm by Tuesday") and try again.</span>
            </p>
          )}
          {rush && busy !== 'intake' && (
            <div className="extracted">
              <div className="job-head">
                <b>{rush.qty}× {rush.title}</b>
                <small>{rush.customer.name}, {rush.customer.city} · {rush.material}</small>
              </div>
              <div className="kv"><span>Extracted by</span><AgentTag by={rush.extractedBy} state={state} /></div>
              <div className="kv"><span>Customer</span><b>{rush.customer.name}, {rush.customer.city}</b></div>
              <div className="kv"><span>Routing</span><b>{rush.ops.map((o) => `${o.label} ${o.hours} h (${MACHINE_SHORT[o.machineId] ?? o.machineId})`).join(' → ')}</b></div>
              <div className="kv"><span>Needed by</span><b>{dayLong(state.boardStartIso, rush.dueDay)} evening</b></div>
              <div className="kv"><span>Base price</span><b>{chf(rush.basePriceChf)} <small className="muted">· rate card, not AI</small></b></div>
              {rush.firstFitDay !== undefined && rush.firstFitDay > rush.dueDay ? (
                <p className="callout warn icon"><span className="ci" aria-hidden>!</span><span>If nobody moves, this job ships <b>{dayLong(state.boardStartIso, rush.firstFitDay)}</b>: too late for {dayLong(state.boardStartIso, rush.dueDay)}. Takt can ask customers who said they are flexible to wait, for money.</span></p>
              ) : (
                <p className="callout good icon"><span className="ci" aria-hidden>✓</span><span>There is free capacity: it ships {rush.firstFitDay !== undefined ? dayLong(state.boardStartIso, rush.firstFitDay) : 'in time'} without moving anyone.</span></p>
              )}
              <button className={`btn primary${busy === 'plan' ? ' is-busy' : ''}`} disabled={!!busy} onClick={() => run('plan', '/api/rush/plan')}>
                {busy === 'plan' ? 'Planner + agent working…' : 'Make room'}
              </button>
              {busy === 'plan' && <Working title="The planner compares options; Claude chooses whom to ask and writes the offers…" lines={3} />}
            </div>
          )}
        </section>
      )}

      {stage === 'planned' && plan && (
        <section className="card step-card" key="planned" data-step="make-room" data-feasible={plan.feasible}>
          <StepHead eyebrow="Make room">{headline}</StepHead>
          {plan.feasible ? (
            <div className="stats">
              <Stat label="Rush price" value={chf(plan.rushPriceChf)} note={`premium ${chf(plan.rushPremiumChf)}`} />
              <Stat label="Compensation" value={`−${chf(plan.compensationTotalChf)}`} note={`cap ${chf(plan.budgetCapChf)} (code)`} />
              <Stat label="Net uplift" value={fmtSigned(plan.netUpliftChf)} note="nobody let down" className="net" />
            </div>
          ) : (
            <p className="callout warn icon"><span className="ci" aria-hidden>!</span><span>{plan.reason || 'No combination of flexible customers frees the slot in time without breaking a firm promise.'} The details below show what the planner tried.</span></p>
          )}
          {plan.offers.length > 0 && (
            <>
              <p className="section-label">Who is asked to wait</p>
              <div className="who-list">
                {plan.offers.map((o) => (
                  <div key={o.id} className="offer-row">
                    <b>{customer(o.customerId)?.name}</b> <span className="lang">{o.lang.toUpperCase()}</span>
                    <span className="when">+{plural(o.delayDays, 'day')} · {chf(o.compensationChf)}</span>
                    <span className="pp-tag">{o.mechanism === 'reduced-capture' ? 'capture less' : 'Payout'}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {plan.justification && (
            <div className="why">
              <div className="why-head"><b>Why these customers</b><AgentTag by={plan.chosenBy} state={state} /></div>
              <ClampedQuote text={plan.justification} />
            </div>
          )}
          <details className="more" open={!plan.feasible}>
            <summary>Details: {plan.options.length > 1 ? `${plan.options.length} options compared, ` : ''}planner notes</summary>
            {plan.options.length > 1 && (
              <table className="options">
                <thead><tr><th>Option</th><th>Ask</th><th>Comp.</th><th>Net</th></tr></thead>
                <tbody>
                  {plan.options.map((o) => (
                    <tr key={o.optionId} className={o.optionId === plan.chosenOptionId ? 'chosen' : ''}>
                      <td>{o.optionId}{o.optionId === plan.chosenOptionId ? ' ✓' : ''}</td>
                      <td>{o.bumps.map((b) => customer(b.customerId)?.name ?? b.customerId).join(', ') || '—'}</td>
                      <td>{chf(o.compensationTotalChf)}</td>
                      <td>+{chf(o.netUpliftChf)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <ul className="explain">{plan.explanation.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </details>
          {plan.feasible && (
            <button className={`btn primary block cta-sticky${busy === 'send' ? ' is-busy' : ''}`} disabled={!!busy} onClick={() => run('send', '/api/offers/send')}>
              {plan.offers.length ? `Send ${plan.offers.length} offer${plan.offers.length > 1 ? 's' : ''}` : 'Book the rush (nobody moves)'}
            </button>
          )}
        </section>
      )}

      {stage === 'awaiting-approval' && plan && state.approval && (
        <section className="card step-card approval" key="approval" data-step="owner-ok">
          <StepHead eyebrow="Owner OK">{headline}</StepHead>
          <p className="muted">Nothing has reached PayPal yet: you approve every move first.</p>
          <div className="stats">
            <Stat label="Compensation" value={`−${chf(plan.compensationTotalChf)}`} note={plural(plan.offers.length, 'customer')} />
            <Stat label="Rush hold" value={chf(plan.rushPriceChf)} note="PayPal authorization" />
            <Stat label="Net uplift" value={fmtSigned(plan.netUpliftChf)} className="net" />
          </div>
          <ul className="moves">
            {state.approval.moves.map((m) => (
              <li key={m.id}>
                <span className="mv-ico" aria-hidden>{MOVE_ICON[m.kind] ?? '·'}</span>
                <div><b>{m.kind === 'payout' ? 'Payout' : m.kind === 'capture-less' ? 'Capture less' : 'Rush authorization'}</b> · {m.customerName}</div>
                <div className="amt">{m.kind === 'rush-authorize' ? '' : '−'}{chf(m.amountChf)}</div>
                <small><code>{m.api}</code> {m.detail}</small>
              </li>
            ))}
          </ul>
          <GuardrailChecks checks={state.approval.checks} />
          <button className={`btn primary block cta-sticky${busy === 'approve' ? ' is-busy' : ''}`} id="approve-moves" disabled={!!busy || !state.approval.checks.every((c) => c.ok)} onClick={() => run('approve', '/api/approval/approve')}>
            {busy === 'approve' ? 'Moving money…' : 'Approve & send to PayPal'}
          </button>
        </section>
      )}

      {(stage === 'offers-sent' || stage === 'awaiting-approval') && plan && (
        <section className={`card${stage === 'offers-sent' ? ' step-card' : ''}`} key="answers" data-step={stage === 'offers-sent' ? 'offers' : undefined}>
          {stage === 'offers-sent' ? <StepHead eyebrow="Offers">{headline}</StepHead> : <h3>Customer answers</h3>}
          {stage === 'offers-sent' && <p className="muted">Each customer gets a one-page offer in their language. They tap a button or answer in their own words; the agent reads the reply, code checks the caps.</p>}
          <div className="answer-status" aria-live="polite">
            {plan.offers.map((o) => (
              <div key={o.id} className="offer-row">
                <b>{customer(o.customerId)?.name}</b>
                <span className="when">{chf(o.compensationChf)}</span>
                <span className={`st ${o.status === 'sent' ? 'waiting' : o.status}`}>{o.status === 'sent' ? (o.escalation ? 'needs you' : 'waiting') : o.status === 'accepted' ? '✓ agreed' : o.status}</span>
              </div>
            ))}
          </div>
          <div className="phones">
            {plan.offers.map((o) => (
              <div key={o.id} className="phone-wrap">
                <a className="open-phone" href={`#/offer/${o.id}`} target="_blank" rel="noreferrer">Open {customer(o.customerId)?.name}'s page on a phone ↗</a>
                <OfferCard offer={o} state={state} onState={onState} />
              </div>
            ))}
          </div>
        </section>
      )}

      {(stage === 'awaiting-payment' || stage === 'committed') && plan && (
        <section className="card step-card" key={stage} data-step={stage === 'committed' ? 'committed' : 'rush-pays'}>
          <StepHead eyebrow={stage === 'committed' ? 'Schedule committed' : 'Rush pays'}>{headline}</StepHead>
          {stage === 'awaiting-payment' && (
            <>
              <p className="muted">{rush?.customer.name} gets a PayPal checkout for {chf(plan.rushPriceChf)} (intent AUTHORIZE: a hold, charged at shipment). The schedule changes only when PayPal confirms the authorization.</p>
              <div className="phone-wrap">
                <a className="open-phone" href="#/pay" target="_blank" rel="noreferrer">Open {rush?.customer.name}'s checkout on a phone ↗</a>
                <RushCheckout state={state} onState={onState} />
              </div>
            </>
          )}
          {stage === 'committed' && (
            <>
              <div className="committed-hero" role="status">
                <span className="big-check" aria-hidden>✓</span>
                <b>Confirmed by PayPal.</b>
                <span>Nobody let down: {plural(plan.offers.length, 'customer')} agreed and {plan.offers.length === 1 ? 'is' : 'are'} compensated.</span>
              </div>
              <div className="stats">
                <Stat label="Rush premium" value={chf(plan.rushPremiumChf)} />
                <Stat label="Compensation" value={`−${chf(plan.compensationTotalChf)}`} />
                <Stat label="Net uplift" value={fmtSigned(plan.netUpliftChf)} className="net" />
              </div>
            </>
          )}
          {state.rushOrder && (
            <details className="pp-box" open={stage === 'awaiting-payment'}>
              <summary>PayPal timeline · rush order <code>{state.rushOrder.orderId}</code></summary>
              <PayPalTrail steps={state.rushOrder.paypal} mode={state.modes.paypal} />
            </details>
          )}
          {stage === 'committed' && (
            <>
              <header className="step-head sub" data-step="settle">
                <span className="eyebrow">Settle</span>
                <h3>{settleJobs.some(canShip) ? 'Ship jobs to capture payments.' : 'Every job settled with PayPal.'}</h3>
              </header>
              <p className="muted small">Ship a job and PayPal captures what was agreed. Each job shows every PayPal object it touched; "Check in PayPal" reads the live status from the API.</p>
              <div className="settle">
                {settleJobs.map((j) => (
                  <SettleJob key={j.id} job={j} state={state} busy={busy} run={run} next={j.id === nextShip?.id} />
                ))}
              </div>
              {state.jobs.some((j) => j.rush && j.status === 'cancelled') && (
                <p className="callout warn small" role="status">The rush was cancelled: its premium is gone, but the customers who moved keep their compensation and new dates. They waited in good faith.</p>
              )}
            </>
          )}
        </section>
      )}
      {err && (
        <p className="callout bad icon" role="alert">
          <span className="ci" aria-hidden>!</span>
          <span><b>That step didn't go through.</b> {err} Your demo is safe: try again, or use Reset demo to start over.</span>
        </p>
      )}
    </aside>
  );
}
