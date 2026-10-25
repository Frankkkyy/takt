import { useState } from 'react';
import type { DemoState } from '../../../shared/types';
import { chf, dayLong, dayShort, post } from '../api';
import { OfferCard } from './Offer';
import { RUSH_SAMPLES } from '../samples';

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

export function Flow({ state, onState, draft: text, setDraft: setText }: { state: DemoState; onState: (s: DemoState) => void; draft: string; setDraft: (t: string) => void }) {
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

      {(stage === 'idle' || stage === 'intake') && (
        <section className="card">
          <h2>Rush request</h2>
          <div className="intake">
            <div className="photo" aria-label="Photo of the broken bracket">
              <svg viewBox="0 0 80 60" width="80" height="60"><rect width="80" height="60" rx="6" fill="#e9edf3" /><path d="M14 46 L14 16 L40 16 L40 26 L26 26 L26 46 Z" fill="#8a96a8" /><path d="M30 18 l6 8 l-3 2 l4 6" stroke="#d1495b" strokeWidth="2" fill="none" /><circle cx="20" cy="40" r="3" fill="#e9edf3" /></svg>
              <small>photo.jpg</small>
            </div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} />
          </div>
          <div className="chips">
            {RUSH_SAMPLES.map((s) => <button key={s.label} className="chip" onClick={() => setText(s.text)}>{s.label}</button>)}
          </div>
          <button className="btn primary" disabled={!!busy} onClick={() => run('intake', '/api/rush/intake', { text })}>
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
              <div className="kv"><span>Routing</span><b>{rush.ops.map((o) => `${o.label} ${o.hours} h (${o.machineId})`).join(' → ')}</b></div>
              <div className="kv"><span>Needed by</span><b>{dayShort(state.boardStartIso, rush.dueDay)} evening</b></div>
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
            <button className="btn primary" disabled={!!busy} onClick={() => run('send', '/api/offers/send')}>
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
          <button className="btn primary" id="approve-moves" disabled={!!busy || !state.approval.checks.every((c) => c.ok)} onClick={() => run('approve', '/api/approval/approve')}>
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
          <div className="kv"><span>{rush?.customer.name}</span><b>{chf(plan.rushPriceChf)}</b></div>
          <p className="muted">Authorization only — charged when the brackets ship.</p>
          {stage === 'awaiting-payment' && state.paypalNotice && (
            <p className={`callout ${state.paypalNotice.kind === 'error' ? 'bad' : 'warn'}`} role="alert" id="paypal-notice">{state.paypalNotice.text}</p>
          )}
          {stage === 'awaiting-payment' && state.modes.paypal === 'mock' && (
            <div className="pay-row">
              <button className="btn paypal" disabled={!!busy} onClick={() => run('approve', '/api/rush/mock-approve')}>
                Pay with PayPal <small>(mock)</small>
              </button>
              {state.rushOrder?.status === 'created' && (
                <button className="btn small ghost dark" disabled={!!busy} onClick={() => run('cancel', '/api/rush/mock-cancel')} title="Simulates the buyer pressing Cancel on the PayPal page">Buyer cancels (mock)</button>
              )}
            </div>
          )}
          {stage === 'awaiting-payment' && state.modes.paypal === 'sandbox' && (
            // Redirect approval on the real PayPal sandbox; the server reconciles by polling the order.
            // (JS SDK v6 popup button replaces this link in phase 2.)
            state.rushOrder?.approveUrl ? (
              <a id="paypal-approve" className="btn paypal" href={state.rushOrder.approveUrl} target="_blank" rel="noreferrer">
                Pay with PayPal <small>(sandbox)</small>
              </a>
            ) : <p className="muted">Creating PayPal order…</p>
          )}
          {stage === 'awaiting-payment' && state.rushOrder?.status !== 'created' && <p className="muted">Waiting for PayPal to confirm…</p>}
          {stage === 'awaiting-payment' && state.modes.paypal === 'sandbox' && state.rushOrder?.status === 'created' && <p className="muted">Waiting for the buyer to approve in PayPal…</p>}
          {stage === 'committed' && (
            <>
              <p className="callout good">Confirmed by PayPal. Nobody let down: {plan.offers.length} customer(s) agreed and are compensated.</p>
              <h3>Settle</h3>
              <div className="settle">
                {state.jobs.filter((j) => (j.rush || j.compensationChf) && j.status !== 'cancelled').map((j) => (
                  <div key={j.id} className="offer-row">
                    <b>{j.id} · {state.customers.find((c) => c.id === j.customerId)?.name ?? (j.rush ? rush?.customer.name : '')}</b>
                    <span>{j.status === 'shipped'
                      ? <span className="good">✓ {j.payment.kind === 'authorization'
                          ? `captured ${chf(j.payment.authorizedChf - (j.compensationChf ?? 0))} of ${chf(j.payment.authorizedChf)}${j.compensationChf ? `: ${chf(j.compensationChf)} less, no refund, no second payment` : ''}`
                          : 'shipped'}</span>
                      : j.payment.kind === 'authorization'
                        ? <>capture {chf(j.payment.authorizedChf - (j.compensationChf ?? 0))}{j.compensationChf ? <small className="muted"> of {chf(j.payment.authorizedChf)}</small> : null}</>
                        : 'prepaid · compensation paid out'}</span>
                    {j.payment.kind === 'authorization' && j.status === 'booked' && (
                      <button className="btn small" disabled={!!busy} onClick={() => run('ship' + j.id, `/api/jobs/${j.id}/ship`)}>Ship</button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}
      {err && <p className="callout bad">{err}</p>}
    </aside>
  );
}
