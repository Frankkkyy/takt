import { useState } from 'react';
import type { BumpOffer, DemoState } from '../../../shared/types';
import { chf, dayShort, post } from '../api';
import { REPLY_SAMPLES } from '../samples';

const UI = {
  en: { title: 'Can you wait a little?', accept: 'Accept', decline: 'No, keep my date', from: 'Planned', to: 'New date', you: 'You get', done: 'Thank you! Your new delivery date is confirmed.', no: 'No problem — your date stays.', write: 'Or answer in your own words…', send: 'Send', owner: 'The workshop will get back to you shortly.', less: 'PayPal · captured less', payout: 'PayPal Payout' },
  de: { title: 'Können Sie etwas warten?', accept: 'Annehmen', decline: 'Nein, Termin behalten', from: 'Geplant', to: 'Neuer Termin', you: 'Sie erhalten', done: 'Danke! Ihr neuer Liefertermin ist bestätigt.', no: 'Kein Problem — Ihr Termin bleibt.', write: 'Oder in eigenen Worten antworten…', send: 'Senden', owner: 'Die Werkstatt meldet sich in Kürze bei Ihnen.', less: 'PayPal · weniger belastet', payout: 'PayPal-Auszahlung' },
  fr: { title: 'Pouvez-vous patienter un peu ?', accept: 'Accepter', decline: 'Non, garder ma date', from: 'Prévu', to: 'Nouvelle date', you: 'Vous recevez', done: 'Merci ! Votre nouvelle date de livraison est confirmée.', no: 'Pas de souci — votre date reste.', write: 'Ou répondez avec vos mots…', send: 'Envoyer', owner: "L'atelier revient vers vous très vite.", less: 'PayPal · prélevé en moins', payout: 'Versement PayPal' },
};

export function OfferCard({ offer, state, onState, standalone = false }: { offer: BumpOffer; state: DemoState; onState: (s: DemoState) => void; standalone?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [showEn, setShowEn] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const t = UI[offer.lang];
  const c = state.customers.find((x) => x.id === offer.customerId);
  const call = async (path: string, body: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post(path, body);
      onState(r.state);
      setText('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const [first, ...rest] = offer.thread;
  // Demo helper: scripted replies (recorded Claude responses) for this offer's language. Hidden from the customer
  // view by default; judges open the drawer.
  const samples = REPLY_SAMPLES.filter((s) => s.lang === offer.lang || s.lang === 'any');
  return (
    <div className={`phone ${standalone ? 'standalone' : ''}`}>
      <div className="phone-notch" />
      <div className="phone-screen">
        <div className="offer-shop">Werkstatt Reuss · via Takt</div>
        <h3>{t.title}</h3>
        <p className="offer-to">{c?.contact} · {c?.name}</p>
        <p className="offer-msg">{showEn ? first?.textEn ?? offer.messageEn : first?.text ?? offer.message}</p>
        {offer.lang !== 'en' && (
          <button className="link" onClick={() => setShowEn((v) => !v)}>{showEn ? 'Original' : 'Show English'}</button>
        )}
        <div className="offer-dates">
          <div><small>{t.from}</small><b>{dayShort(state.boardStartIso, offer.fromDay, offer.lang)}</b></div>
          <div className="arrow">→</div>
          <div><small>{t.to}</small><b>{dayShort(state.boardStartIso, offer.toDay, offer.lang)}</b></div>
        </div>
        <div className="offer-amount"><small>{t.you}</small><b>{chf(offer.compensationChf)}</b>
          <span className="pp-tag">{offer.mechanism === 'reduced-capture' ? t.less : t.payout}</span>
        </div>
        {rest.length > 0 && (
          <div className="thread">
            {rest.map((m, i) => (
              <div key={i} className={`bubble ${m.from}`}>
                {showEn && m.textEn ? m.textEn : m.text}
              </div>
            ))}
          </div>
        )}
        {offer.escalation && <p className="callout warn small">{t.owner} <span className="owner-only">Owner: {offer.escalation}</span></p>}
        {offer.status === 'sent' && (
          <>
            <div className="offer-actions">
              <button className="btn primary" disabled={busy} onClick={() => call(`/api/offers/${offer.id}/respond`, { accept: true })}>{t.accept} — {chf(offer.compensationChf)}</button>
              <button className="btn ghost" disabled={busy} onClick={() => call(`/api/offers/${offer.id}/respond`, { accept: false })}>{t.decline}</button>
            </div>
            <div className="reply">
              <textarea rows={2} placeholder={t.write} value={text} onChange={(e) => setText(e.target.value)} />
              <button className="btn small primary send-reply" disabled={busy || !text.trim()} onClick={() => call(`/api/offers/${offer.id}/reply`, { text })}>
                {busy ? '…' : t.send}
              </button>
              <details className="demo-helper">
                <summary>Demo helper (not shown to customers)</summary>
                <div className="chips">
                  {samples.map((s) => <button key={s.label} className="chip" onClick={() => setText(s.text)}>{s.label}</button>)}
                </div>
                <small className="muted">Chips replay recorded Claude output. Anything you type goes to Claude live (rate-limited) or the rules fallback.</small>
              </details>
            </div>
          </>
        )}
        {offer.status === 'accepted' && <p className="offer-done">✓ {t.done}</p>}
        {offer.status === 'declined' && <p className="offer-done muted">{t.no}</p>}
        {err && <p className="callout bad">{err}</p>}
      </div>
    </div>
  );
}

export function OfferPage({ id, state, onState }: { id: string; state: DemoState; onState: (s: DemoState) => void }) {
  const offer = state.plan?.offers.find((o) => o.id === id) ?? (state.move?.offer?.id === id ? state.move.offer : undefined) ?? state.pastOffers?.find((o) => o.id === id);
  if (!offer) return <div className="center muted">This offer is no longer open. Open it from the same browser as the owner console (each browser runs its own demo).</div>;
  return <div className="center offer-page"><OfferCard offer={offer} state={state} onState={onState} standalone /></div>;
}
