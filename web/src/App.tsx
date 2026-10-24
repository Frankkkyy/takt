import { useEffect, useState } from 'react';
import type { DemoState } from '../../shared/types';
import { chf, getState, post } from './api';
import { Board } from './components/Board';
import { Flow } from './components/Flow';
import { OfferPage } from './components/Offer';

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const h = () => setHash(location.hash);
    addEventListener('hashchange', h);
    return () => removeEventListener('hashchange', h);
  }, []);
  return hash;
}

export function App() {
  const [state, setState] = useState<DemoState | null>(null);
  const hash = useHash();

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await getState();
        if (alive) setState(s);
      } catch {
        /* server restarting */
      }
    };
    tick();
    const t = setInterval(tick, 1000); // also our "reconcile" loop: webhooks are confirmations, polling is the backstop
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!state) return <div className="center muted">Loading…</div>;

  const offerMatch = hash.match(/^#\/offer\/(.+)$/);
  if (offerMatch) return <OfferPage id={offerMatch[1]} state={state} onState={setState} />;

  const showProposal = ['planned', 'offers-sent', 'awaiting-payment'].includes(state.stage);
  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">▤</span>
          <div>
            <b>Takt</b>
            <small>Airline bumping for factory schedules</small>
          </div>
        </div>
        <div className="shop">Werkstatt Reuss · Emmen LU</div>
        <div className="yield">
          <div><small>Rush premiums</small><b>{chf(state.yield.premiumsChf)}</b></div>
          <div><small>Compensations</small><b>−{chf(state.yield.compensationsChf)}</b></div>
          <div className="net"><small>Net uplift</small><b>+{chf(state.yield.netChf)}</b></div>
        </div>
        <div className="modes">
          <span className={`badge ${state.modes.paypal}`}>PayPal: {state.modes.paypal}</span>
          <span className="badge">Agent: {state.modes.agent}</span>
          <button className="btn small ghost" onClick={async () => setState((await post('/api/demo/reset')).state)}>Reset demo</button>
        </div>
      </header>
      <main className="main">
        <section className="left">
          <Board state={state} showProposal={showProposal} />
          <div className="ledger">
            <h3>PayPal &amp; agent log</h3>
            <ul>
              {state.ledger.slice(0, 14).map((e) => (
                <li key={e.id} className={`src-${e.source}`}>
                  <span className="time">{new Date(e.at).toLocaleTimeString('de-CH')}</span>
                  <span className="src">{e.source}</span>
                  <b>{e.title}</b>
                  <span className="detail">{e.detail}</span>
                  {e.paypalId && <code>{e.paypalId}</code>}
                </li>
              ))}
            </ul>
          </div>
        </section>
        <Flow state={state} onState={setState} />
      </main>
    </div>
  );
}
