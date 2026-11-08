import { useState } from 'react';
import type { BumpOffer, DemoState } from '../../../shared/types';
import { chf, dayShort, post } from '../api';
import { REPLY_SAMPLES } from '../samples';

const UI = {
  en: { title: 'Can you wait a little?', accept: 'Accept', decline: 'No, keep my date', from: 'Planned', to: 'New date', you: 'You get', done: 'Thank you! Your new delivery date is confirmed.', newDate: 'new date', no: 'No problem — your date stays.', write: 'Or answer in your own words…', send: 'Send', owner: 'The workshop will get back to you shortly.', thanks: 'Thank you!', shopSub: 'Metal works · Emmen LU', reading: 'The workshop is reading your answer', error: 'Your answer did not go through. Please try again.', less: 'PayPal · captured less', payout: 'PayPal Payout' },
  de: { title: 'Können Sie etwas warten?', accept: 'Annehmen', decline: 'Nein, Termin behalten', from: 'Geplant', to: 'Neuer Termin', you: 'Sie erhalten', done: 'Danke! Ihr neuer Liefertermin ist bestätigt.', newDate: 'neuer Termin', no: 'Kein Problem — Ihr Termin bleibt.', write: 'Oder in eigenen Worten antworten…', send: 'Senden', owner: 'Die Werkstatt meldet sich in Kürze bei Ihnen.', thanks: 'Vielen Dank!', shopSub: 'Metallbau · Emmen LU', reading: 'Die Werkstatt liest Ihre Antwort', error: 'Ihre Antwort kam nicht an. Bitte versuchen Sie es noch einmal.', less: 'PayPal · weniger belastet', payout: 'PayPal-Auszahlung' },
  fr: { title: 'Pouvez-vous patienter un peu ?', accept: 'Accepter', decline: 'Non, garder ma date', from: 'Prévu', to: 'Nouvelle date', you: 'Vous recevez', done: 'Merci ! Votre nouvelle date de livraison est confirmée.', newDate: 'nouvelle date', no: 'Pas de souci — votre date reste.', write: 'Ou répondez avec vos mots…', send: 'Envoyer', owner: "L'atelier revient vers vous très vite.", thanks: 'Merci !', shopSub: 'Construction métallique · Emmen LU', reading: "L'atelier lit votre réponse", error: "Votre réponse n'est pas passée. Veuillez réessayer.", less: 'PayPal · prélevé en moins', payout: 'Versement PayPal' },
};

/**
 * Recorded English translations come as one line while the original has paragraphs. For display only, put the
 * greeting, the thank-you and the signature on their own lines like the original (the recorded text is unchanged).
 */
export function withParagraphs(en: string, original: string): string {
  if (en.includes('\n') || !original.includes('\n')) return en;
  return en
    .replace(/^((?:Dear|Hello|Hi|Good (?:morning|afternoon))\b[^,.!?\n]{0,40},)\s+/, '$1\n\n')
    .replace(/\s+((?:Thank you|Thanks|Many thanks|Kind regards|Best regards|Best wishes)\b[^.!]*[.!,]?)\s+(Werkstatt Reuss\.?)$/, '\n\n$1\n$2')
    .replace(/([.!?])[ \t]+(Werkstatt Reuss\.?)$/, '$1\n\n$2');
}

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
  const accepted = offer.status === 'accepted';
  return (
    <div className={`phone ${standalone ? 'standalone' : ''}`}>
      <div className="phone-notch" />
      <div className="phone-screen" lang={offer.lang}>
        <ShopHeader sub={t.shopSub} />
        <h3>{accepted ? t.thanks : t.title}</h3>
        <p className="offer-to">{c?.contact} · {c?.name}</p>
        {accepted ? (
          <div className="offer-done confirm" role="status">
            <span className="confirm-check" aria-hidden>✓</span>
            <b>{t.done}</b>
            <span className="confirm-line">{chf(offer.compensationChf)} · {t.newDate} {dayShort(state.boardStartIso, offer.toDay, offer.lang)}</span>
            <small>{offer.mechanism === 'reduced-capture' ? t.less : t.payout}</small>
          </div>
        ) : (
          <div className="offer-card">
            <div className="offer-amount"><small>{t.you}</small><b>{chf(offer.compensationChf)}</b>
              <span className="pp-tag">{offer.mechanism === 'reduced-capture' ? t.less : t.payout}</span>
            </div>
            <div className="offer-dates">
              <div><small>{t.from}</small><b>{dayShort(state.boardStartIso, offer.fromDay, offer.lang)}</b></div>
              <div className="arrow" aria-hidden>→</div>
              <div><small>{t.to}</small><b>{dayShort(state.boardStartIso, offer.toDay, offer.lang)}</b></div>
            </div>
          </div>
        )}
        <p className="offer-msg">{showEn ? withParagraphs(first?.textEn ?? offer.messageEn, first?.text ?? offer.message) : first?.text ?? offer.message}</p>
        {offer.lang !== 'en' && (
          <button className="link" lang="en" onClick={() => setShowEn((v) => !v)}>{showEn ? 'Original' : 'Show English'}</button>
        )}
        {(rest.length > 0 || busy) && (
          <div className="thread">
            {rest.map((m, i) => (
              <div key={i} className={`bubble ${m.from}`}>
                {showEn && m.textEn ? withParagraphs(m.textEn, m.text) : m.text}
              </div>
            ))}
            {busy && <div className="bubble typing" role="status" aria-label={t.reading}><i /><i /><i /></div>}
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
              <textarea rows={2} aria-label={t.write} placeholder={t.write} value={text} onChange={(e) => setText(e.target.value)} />
              <button className="btn small primary send-reply" disabled={busy || !text.trim()} onClick={() => call(`/api/offers/${offer.id}/reply`, { text })}>
                {busy ? '…' : t.send}
              </button>
              <details className="demo-helper" lang="en">
                <summary>Demo helper (not shown to customers)</summary>
                <div className="chips">
                  {samples.map((s) => <button key={s.label} className="chip" onClick={() => setText(s.text)}>{s.label}</button>)}
                </div>
                <small className="muted">Chips replay recorded Claude output. Anything you type goes to Claude live (rate-limited) or the rules fallback.</small>
              </details>
            </div>
          </>
        )}
        {offer.status === 'declined' && <p className="offer-done declined" role="status">{t.no}</p>}
        {err && <p className="callout bad small" role="alert">{t.error}</p>}
      </div>
    </div>
  );
}

/** Customer-facing header: who is writing (the shop), not the tool. */
export function ShopHeader({ sub }: { sub: string }) {
  return (
    <header className="offer-head">
      <span className="shop-mark" aria-hidden>WR</span>
      <div><b>Werkstatt Reuss</b><small>{sub}</small></div>
    </header>
  );
}

/** Friendly full-page message for links that no longer lead anywhere. */
export function EmptyPage({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="center offer-page">
      <div className="empty" role="status">
        <span className="empty-ico" aria-hidden>{icon}</span>
        <b>{title}</b>
        <p>{children}</p>
      </div>
    </div>
  );
}

export function OfferPage({ id, state, onState }: { id: string; state: DemoState; onState: (s: DemoState) => void }) {
  const offer = state.plan?.offers.find((o) => o.id === id) ?? (state.move?.offer?.id === id ? state.move.offer : undefined) ?? state.pastOffers?.find((o) => o.id === id);
  if (!offer) return <EmptyPage icon="✉" title="This offer is no longer open">It may have been answered already, or the demo was reset. Open it from the same browser as the owner console: each browser runs its own demo shop. <a href="#/">Back to the console</a></EmptyPage>;
  return <div className="center offer-page"><OfferCard key={offer.id} offer={offer} state={state} onState={onState} standalone /></div>;
}
