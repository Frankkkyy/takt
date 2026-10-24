import { useState } from 'react';
import type { BumpOffer, DemoState } from '../../../shared/types';
import { chf, dayShort, post } from '../api';

const UI = {
  en: { title: 'Can you wait a little?', accept: 'Accept', decline: 'No, keep my date', from: 'Planned', to: 'New date', you: 'You get', done: 'Thank you! Your new delivery date is confirmed.', no: 'No problem — your date stays.' },
  de: { title: 'Können Sie etwas warten?', accept: 'Annehmen', decline: 'Nein, Termin behalten', from: 'Geplant', to: 'Neuer Termin', you: 'Sie erhalten', done: 'Danke! Ihr neuer Liefertermin ist bestätigt.', no: 'Kein Problem — Ihr Termin bleibt.' },
  fr: { title: 'Pouvez-vous patienter un peu ?', accept: 'Accepter', decline: 'Non, garder ma date', from: 'Prévu', to: 'Nouvelle date', you: 'Vous recevez', done: 'Merci ! Votre nouvelle date de livraison est confirmée.', no: 'Pas de souci — votre date reste.' },
};

export function OfferCard({ offer, state, onState }: { offer: BumpOffer; state: DemoState; onState: (s: DemoState) => void }) {
  const [busy, setBusy] = useState(false);
  const [showEn, setShowEn] = useState(false);
  const t = UI[offer.lang];
  const c = state.customers.find((x) => x.id === offer.customerId);
  const respond = async (accept: boolean) => {
    setBusy(true);
    try {
      const r = await post(`/api/offers/${offer.id}/respond`, { accept });
      onState(r.state);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="phone">
      <div className="phone-notch" />
      <div className="phone-screen">
        <div className="offer-shop">Werkstatt Reuss · via Takt</div>
        <h3>{t.title}</h3>
        <p className="offer-to">{c?.contact} · {c?.name}</p>
        <p className="offer-msg">{showEn ? offer.messageEn : offer.message}</p>
        {offer.lang !== 'en' && (
          <button className="link" onClick={() => setShowEn((v) => !v)}>{showEn ? 'Original' : 'Show English'}</button>
        )}
        <div className="offer-dates">
          <div><small>{t.from}</small><b>{dayShort(state.boardStartIso, offer.fromDay)}</b></div>
          <div className="arrow">→</div>
          <div><small>{t.to}</small><b>{dayShort(state.boardStartIso, offer.toDay)}</b></div>
        </div>
        <div className="offer-amount"><small>{t.you}</small><b>{chf(offer.compensationChf)}</b>
          <span className="pp-tag">{offer.mechanism === 'reduced-capture' ? 'PayPal · captured less' : 'PayPal Payout'}</span>
        </div>
        {offer.status === 'sent' && (
          <div className="offer-actions">
            <button className="btn primary" disabled={busy} onClick={() => respond(true)}>{t.accept} — {chf(offer.compensationChf)}</button>
            <button className="btn ghost" disabled={busy} onClick={() => respond(false)}>{t.decline}</button>
          </div>
        )}
        {offer.status === 'accepted' && <p className="offer-done">✓ {t.done}</p>}
        {offer.status === 'declined' && <p className="offer-done muted">{t.no}</p>}
      </div>
    </div>
  );
}

export function OfferPage({ id, state, onState }: { id: string; state: DemoState; onState: (s: DemoState) => void }) {
  const offer = state.plan?.offers.find((o) => o.id === id);
  if (!offer) return <div className="center muted">Offer not found or expired.</div>;
  return <div className="center"><OfferCard offer={offer} state={state} onState={onState} /></div>;
}
