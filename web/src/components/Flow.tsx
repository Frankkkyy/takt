import { useState } from 'react';
import type { DemoState, Job } from '../../../shared/types';
import { chf, dayLong, MACHINE_SHORT, plural, post } from '../api';
import { OfferCard } from './Offer';
import { RUSH_SAMPLES } from '../samples';
import { PayPalTrail, RushCheckout } from './PayPal';

function AgentTag({ by, state }: { by: 'llm' | 'deterministic'; state: DemoState }) {
  const a = state.agent;
  const how = a.last === 'live' ? 'live' : a.last === 'replay' ? 'recorded' : a.last === 'fallback' ? 'fallback' : '';
  return by === 'llm'
    ? <span className="agent-tag llm">Claude {a.model.replace('claude-', '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/^\w/, (c) => c.toUpperCase())}{how && how !== 'fallback' ? ` · ${how}` : ''}</span>
    : <span className="agent-tag rules">rules{a.last === 'fallback' ? ' · fallback' : ''}</span>;
}

const STEPS: { key: DemoState['stage'][]; label: string }[] = [
  { key: ['idle', 'intake'], label: 'Rush request' },
  { key: ['planned'], label: 'Make room' },
  { key: ['offers-sent'], label: 'Offers' },
  { key: ['awaiting-approval'], label: 'Owner OK' },
  { key: ['awaiting-payment'], label: 'Rush pays' },
  { key: ['committed'], label: 'Committed' },
];

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
function SettleJob({ job: j, state, busy, run }: { job: Job; state: DemoState; busy: string | null; run: Run }) {
  const rush = state.rush;
  const auth = j.payment.kind === 'authorization' ? j.payment : undefined;
  const comp = j.compensationChf ?? 0;
  return (
    <div className="settle-job" data-job={j.id}>
      <div className="offer-row">
        <b>{j.id} · {state.customers.find((c) => c.id === j.customerId)?.name ?? (j.rush ? rush?.customer.name : '')}{j.rush ? ' (rush)' : ''}</b>
        <span>{j.status === 'cancelled'
          ? <span className="bad-text">✕ cancelled: {j.cancelledVia === 'refund' ? `${chf(auth?.authorizedChf ?? 0)} refunded` : 'hold voided, nothing charged'}</span>
          : j.status === 'shipped'
            ? <span className="good">✓ {auth ? `captured ${chf(auth.authorizedChf - comp)} of ${chf(auth.authorizedChf)}${comp ? `: ${chf(comp)} less, no refund, no second payment` : ''}` : 'shipped'}</span>
            : auth
              ? <>capture {chf(auth.authorizedChf - comp)}{comp ? <small className="muted"> of {chf(auth.authorizedChf)}</small> : null}</>
              : 'prepaid · compensation paid out'}</span>
        <span className="settle-actions">
          {auth && j.status === 'booked' && <button className="btn small" disabled={!!busy} onClick={() => run('ship' + j.id, `/api/jobs/${j.id}/ship`)}>Ship</button>}
          {j.rush && j.status === 'booked' && <button className="btn small ghost dark" disabled={!!busy} onClick={() => run('cancel' + j.id, `/api/jobs/${j.id}/cancel`)} title="POST /v2/payments/authorizations/{id}/void">Cancel rush (void)</button>}
          {j.rush && j.status === 'shipped' && <button className="btn small ghost dark" disabled={!!busy} onClick={() => run('refund' + j.id, `/api/jobs/${j.id}/refund`)} title="POST /v2/payments/captures/{id}/refund">Parts returned: refund</button>}
        </span>
      </div>
      <details className="pp-box">
        <summary>PayPal timeline ({j.paypal?.length ?? 0})</summary>
        <PayPalTrail steps={j.paypal ?? []} mode={state.modes.paypal} />
        <button className="btn small ghost dark" disabled={!!busy} onClick={() => run('check' + j.id, `/api/jobs/${j.id}/paypal-check`)}>{busy === 'check' + j.id ? 'Asking PayPal…' : 'Check in PayPal'}</button>
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
        <h2>Board move · {m.jobId} {c?.name}</h2>
        {!open && <button className="close" aria-label="Dismiss" onClick={() => setHidden(m.id)}>×</button>}
      </div>
      <ol className="steps mini">
        {MOVE_STEPS.map((s, i) => <li key={s.label} className={i < active ? 'done' : i === active ? 'active' : ''}>{s.label}</li>)}
      </ol>
      <div className="kv"><span>Delivery</span><b>{dayLong(state.boardStartIso, r.fromDay)} → {dayLong(state.boardStartIso, o?.toDay ?? r.toDay)}</b>{o && <small className="muted">promised {dayLong(state.boardStartIso, r.dueDay)}</small>}</div>
      {r.frees && <div className="kv"><span>Why</span><b>It {r.frees}</b></div>}
      {o && (
        <div className="kv"><span>Compensation</span><b>{chf(o.compensationChf)}</b><span className="pp-tag">{o.mechanism === 'reduced-capture' ? 'capture less' : 'Payout'}</span><small className="muted">cap {chf(o.capChf)} (code)</small></div>
      )}
      {m.stage === 'drafted' && o && (
        <>
          <div className="why">
            <div className="why-head"><b>Offer to {c?.contact}</b>{m.draftedBy && <AgentTag by={m.draftedBy} state={state} />}</div>
            <p><span className="lang">{o.lang.toUpperCase()}</span> {showEn ? o.messageEn : o.message}</p>
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
                <div><b>{mv.kind === 'payout' ? 'Payout' : 'Capture less'}</b> · {mv.customerName}</div>
                <div className="amt">−{chf(mv.amountChf)}</div>
                <small><code>{mv.api}</code> {mv.detail}</small>
              </li>
            ))}
          </ul>
          <ul className="checks">
            {m.approval.checks.map((x) => <li key={x.label} className={x.ok ? 'ok' : 'fail'}>{x.ok ? '✓' : '✗'} {x.label}</li>)}
          </ul>
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
      {m.stage === 'declined' && <p className="callout warn small">{c?.name} said no. Their date stays; nothing moved, nothing was paid.</p>}
      {m.stage === 'committed' && (
        <>
          <p className="callout good small">{o ? `Moved with ${c?.name}'s consent; ${o.mechanism === 'payout' ? 'PayPal Payout sent' : `CHF ${o.compensationChf} less is captured at shipment`}.` : 'Moved within the promised date; no money involved.'}</p>
          {o && job && <div className="settle"><SettleJob job={job} state={state} busy={busy} run={run} /></div>}
        </>
      )}
    </section>
  );
}

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

  return (
    <aside className="flow">
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.label} className={i < active ? 'done' : i === active ? 'active' : ''}>{s.label}</li>
        ))}
      </ol>
      <FallbackNote state={state} />
      <MoveCard state={state} onState={onState} busy={busy} run={run} />

      {(stage === 'idle' || stage === 'intake') && (
        <section className={`card intake-card${primed ? ' primed' : ''}`} key={`intake-${primed}`}>
          <h2>Rush request</h2>
          {!primed && !rush && <p className="muted small intro">Start with the email on the left (<b>Open request</b>), or paste any request here.</p>}
          <div className="intake">
            <div className="photo" aria-label="Photo of the broken bracket">
              <svg viewBox="0 0 80 60" width="80" height="60"><rect width="80" height="60" rx="6" fill="#e9edf3" /><path d="M14 46 L14 16 L40 16 L40 26 L26 26 L26 46 Z" fill="#8a96a8" /><path d="M30 18 l6 8 l-3 2 l4 6" stroke="#d1495b" strokeWidth="2" fill="none" /><circle cx="20" cy="40" r="3" fill="#e9edf3" /></svg>
              <small>photo.jpg</small>
            </div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} />
          </div>
          <div className="chips">
            {RUSH_SAMPLES.map((s) => <button key={s.label} className="chip" onClick={() => { setText(s.text); onPrime?.(); }}>{s.label}</button>)}
          </div>
          <button id="read-request" className={`btn ${primed || rush ? 'primary' : 'ghost dark'}`} disabled={!!busy} onClick={() => run('intake', '/api/rush/intake', { text })}>
            {busy === 'intake' ? 'Agent is reading…' : 'Let Takt read it'}
          </button>
          {state.intakeQuestion && !rush && (
            <p className="callout warn" role="alert">
              <b>Takt needs the owner:</b> it could not find the {state.intakeQuestion.missing.join(', ') || 'job details'} in this request, so nothing was planned and no order was invented.
              Add them (for example "6 brackets S355 8 mm by Tuesday") and try again.
            </p>
          )}
          {rush && (
            <div className="extracted">
              <div className="kv"><span>Extracted by</span><AgentTag by={rush.extractedBy} state={state} /></div>
              <div className="kv"><span>Customer</span><b>{rush.customer.name}, {rush.customer.city}</b></div>
              <div className="kv"><span>Part</span><b>{rush.qty}× {rush.title} · {rush.material}</b></div>
              <div className="kv"><span>Routing</span><b>{rush.ops.map((o) => `${o.label} ${o.hours} h (${MACHINE_SHORT[o.machineId] ?? o.machineId})`).join(' → ')}</b></div>
              <div className="kv"><span>Needed by</span><b>{dayLong(state.boardStartIso, rush.dueDay)} evening</b></div>
              <div className="kv"><span>Base price</span><b>{chf(rush.basePriceChf)}</b> <small className="muted">rate card, not AI</small></div>
              {rush.firstFitDay !== undefined && rush.firstFitDay > rush.dueDay ? (
                <p className="callout warn">If nobody moves, this job ships <b>{dayLong(state.boardStartIso, rush.firstFitDay)}</b>: too late for {dayLong(state.boardStartIso, rush.dueDay)}. Takt can ask customers who said they are flexible to wait, for money.</p>
              ) : (
                <p className="callout good">There is free capacity: it ships {rush.firstFitDay !== undefined ? dayLong(state.boardStartIso, rush.firstFitDay) : 'in time'} without moving anyone.</p>
              )}
              <button className="btn accent" disabled={!!busy} onClick={() => run('plan', '/api/rush/plan')}>
                {busy === 'plan' ? 'Planner + agent working…' : 'Make room'}
              </button>
            </div>
          )}
        </section>
      )}

      {stage === 'planned' && plan && (
        <section className="card">
          <h2>{plan.feasible ? 'Takt can make room' : 'No room'}</h2>
          {plan.justification && (
            <div className="why">
              <div className="why-head"><b>Why these customers</b><AgentTag by={plan.chosenBy} state={state} /></div>
              <p>{plan.justification}</p>
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
                      <td>{o.bumps.map((b) => state.customers.find((c) => c.id === b.customerId)?.name ?? b.customerId).join(', ') || '—'}</td>
                      <td>{chf(o.compensationTotalChf)}</td>
                      <td>+{chf(o.netUpliftChf)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <ul className="explain">{plan.explanation.map((e, i) => <li key={i}>{e}</li>)}</ul>
          </details>
          {plan.offers.map((o) => {
            const c = state.customers.find((x) => x.id === o.customerId)!;
            return (
              <div key={o.id} className="offer-row">
                <b>{c.name}</b> <span className="lang">{o.lang.toUpperCase()}</span>
                <span>+{o.delayDays} d · {chf(o.compensationChf)}</span>
                <span className="pp-tag">{o.mechanism === 'reduced-capture' ? 'capture less' : 'Payout'}</span>
              </div>
            );
          })}
          <div className="kv total"><span>Rush price</span><b>{chf(plan.rushPriceChf)}</b></div>
          <div className="kv"><span>Compensation budget (code cap)</span><b>{chf(plan.budgetCapChf)}</b></div>
          <div className="kv total"><span>Net uplift</span><b className="good">+{chf(plan.netUpliftChf)}</b></div>
          {plan.feasible && (
            <button className="btn primary cta-sticky" disabled={!!busy} onClick={() => run('send', '/api/offers/send')}>
              {plan.offers.length ? `Send ${plan.offers.length} offer${plan.offers.length > 1 ? 's' : ''}` : 'Book the rush (nobody moves)'}
            </button>
          )}
        </section>
      )}

      {stage === 'awaiting-approval' && plan && state.approval && (
        <section className="card approval">
          <h2>Approve money moves</h2>
          <p className="muted">Everyone agreed. Nothing has reached PayPal yet: you approve every move first.</p>
          <ul className="moves">
            {state.approval.moves.map((m) => (
              <li key={m.id}>
                <div><b>{m.kind === 'payout' ? 'Payout' : m.kind === 'capture-less' ? 'Capture less' : 'Rush authorization'}</b> · {m.customerName}</div>
                <div className="amt">{m.kind === 'rush-authorize' ? '' : '−'}{chf(m.amountChf)}</div>
                <small><code>{m.api}</code> {m.detail}</small>
              </li>
            ))}
          </ul>
          <ul className="checks">
            {state.approval.checks.map((c) => <li key={c.label} className={c.ok ? 'ok' : 'fail'}>{c.ok ? '✓' : '✗'} {c.label}</li>)}
          </ul>
          <button className="btn primary cta-sticky" id="approve-moves" disabled={!!busy || !state.approval.checks.every((c) => c.ok)} onClick={() => run('approve', '/api/approval/approve')}>
            {busy === 'approve' ? 'Moving money…' : 'Approve & send to PayPal'}
          </button>
        </section>
      )}

      {(stage === 'offers-sent' || stage === 'awaiting-approval') && plan && (
        <section className="card">
          <h2>{stage === 'offers-sent' ? 'Waiting for answers' : 'Answers'}</h2>
          <p className="muted">Each customer gets a one-page offer in their language. They tap a button or answer in their own words; the agent reads the reply, code checks the caps.</p>
          <div className="phones">
            {plan.offers.map((o) => (
              <div key={o.id} className="phone-wrap">
                <a className="open-phone" href={`#/offer/${o.id}`} target="_blank" rel="noreferrer">Open {state.customers.find((c) => c.id === o.customerId)?.name}'s page on a phone ↗</a>
                <OfferCard offer={o} state={state} onState={onState} />
              </div>
            ))}
          </div>
        </section>
      )}

      {(stage === 'awaiting-payment' || stage === 'committed') && plan && (
        <section className="card">
          <h2>{stage === 'committed' ? 'Schedule committed' : 'Rush customer approves'}</h2>
          {stage === 'awaiting-payment' && (
            <>
              <p className="muted">{rush?.customer.name} gets a PayPal checkout for {chf(plan.rushPriceChf)} (intent AUTHORIZE: a hold, charged at shipment). The schedule changes only when PayPal confirms the authorization.</p>
              <div className="phone-wrap">
                <a className="open-phone" href="#/pay" target="_blank" rel="noreferrer">Open {rush?.customer.name}'s checkout on a phone ↗</a>
                <RushCheckout state={state} onState={onState} />
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
              <p className="callout good">Confirmed by PayPal. Nobody let down: {plural(plan.offers.length, 'customer')} agreed and {plan.offers.length === 1 ? 'is' : 'are'} compensated.</p>
              <h3>Settle</h3>
              <p className="muted small">Each job shows every PayPal object it touched. "Check in PayPal" reads the current status straight from the API.</p>
              <div className="settle">
                {state.jobs.filter((j) => (j.rush || j.compensationChf) && (j.status !== 'cancelled' || j.rush)).map((j) => (
                  <SettleJob key={j.id} job={j} state={state} busy={busy} run={run} />
                ))}
              </div>
              {state.jobs.some((j) => j.rush && j.status === 'cancelled') && (
                <p className="callout warn small">The rush was cancelled: its premium is gone, but the customers who moved keep their compensation and new dates. They waited in good faith.</p>
              )}
            </>
          )}
        </section>
      )}
      {err && <p className="callout bad">{err}</p>}
    </aside>
  );
}
