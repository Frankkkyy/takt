import { useState } from 'react';
import type { DemoState } from '../../../shared/types';
import { chf, dayShort, post } from '../api';
import { OfferCard } from './Offer';

const DEFAULT_REQUEST =
  'Our harvester header brackets cracked. Need 6x brackets like the photo, S355 8 mm, by Tuesday evening — harvest starts Wednesday. — Thomas Schmid, Escholzmatt';

const STEPS: { key: DemoState['stage'][]; label: string }[] = [
  { key: ['idle', 'intake'], label: 'Rush request' },
  { key: ['planned'], label: 'Make room' },
  { key: ['offers-sent'], label: 'Offers' },
  { key: ['awaiting-payment'], label: 'Rush pays' },
  { key: ['committed'], label: 'Committed' },
];

export function Flow({ state, onState }: { state: DemoState; onState: (s: DemoState) => void }) {
  const [text, setText] = useState(DEFAULT_REQUEST);
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
          <button className="btn primary" disabled={!!busy} onClick={() => run('intake', '/api/rush/intake', { text })}>
            {busy === 'intake' ? 'Reading…' : 'Let Takt read it'}
          </button>
          {rush && (
            <div className="extracted">
              <div className="kv"><span>Customer</span><b>{rush.customer.name}, {rush.customer.city}</b></div>
              <div className="kv"><span>Part</span><b>{rush.qty}× {rush.title} · {rush.material}</b></div>
              <div className="kv"><span>Routing</span><b>{rush.ops.map((o) => `${o.label} ${o.hours} h (${o.machineId})`).join(' → ')}</b></div>
              <div className="kv"><span>Needed by</span><b>{dayShort(state.boardStartIso, rush.dueDay)} evening</b></div>
              <div className="kv"><span>Base price</span><b>{chf(rush.basePriceChf)}</b> <small className="muted">rate card, not AI</small></div>
              <p className="callout warn">The laser and press brake are fully booked. Takt can look for customers willing to wait.</p>
              <button className="btn accent" disabled={!!busy} onClick={() => run('plan', '/api/rush/plan')}>
                {busy === 'plan' ? 'Simulating…' : 'Make room'}
              </button>
            </div>
          )}
        </section>
      )}

      {stage === 'planned' && plan && (
        <section className="card">
          <h2>{plan.feasible ? 'Takt can make room' : 'No room'}</h2>
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
          <div className="kv total"><span>Net uplift</span><b className="good">+{chf(plan.netUpliftChf)}</b></div>
          {plan.feasible && (
            <button className="btn primary" disabled={!!busy} onClick={() => run('send', '/api/offers/send')}>Send offers</button>
          )}
        </section>
      )}

      {stage === 'offers-sent' && plan && (
        <section className="card">
          <h2>Waiting for answers</h2>
          <p className="muted">Each customer gets a one-page offer in their language. Open it on a phone: <code>#/offer/&lt;id&gt;</code></p>
          <div className="phones">
            {plan.offers.map((o) => <OfferCard key={o.id} offer={o} state={state} onState={onState} />)}
          </div>
        </section>
      )}

      {(stage === 'awaiting-payment' || stage === 'committed') && plan && (
        <section className="card">
          <h2>{stage === 'committed' ? 'Schedule committed' : 'Rush customer approves'}</h2>
          <div className="kv"><span>{rush?.customer.name}</span><b>{chf(plan.rushPriceChf)}</b></div>
          <p className="muted">Authorization only — charged when the brackets ship.</p>
          {stage === 'awaiting-payment' && state.modes.paypal === 'mock' && (
            <button className="btn paypal" disabled={!!busy} onClick={() => run('approve', '/api/rush/mock-approve')}>
              Pay with PayPal <small>(mock)</small>
            </button>
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
                {state.jobs.filter((j) => j.status === 'booked' && (j.rush || j.compensationChf)).map((j) => (
                  <div key={j.id} className="offer-row">
                    <b>{j.id}</b>
                    <span>{j.payment.kind === 'authorization' ? `capture ${chf(j.payment.authorizedChf - (j.compensationChf ?? 0))}` : 'prepaid (paid out)'}</span>
                    {j.payment.kind === 'authorization' && (
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
