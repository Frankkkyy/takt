// PayPal pieces of the UI: the rush customer's checkout (JS SDK v6 button, redirect fallback) and the per-job
// PayPal timeline. JS SDK v6 per developer.paypal.com (checked 2026-10-26): load https://www.sandbox.paypal.com/web-sdk/v6/core,
// window.paypal.createInstance({ clientToken | clientId, components: ['paypal-payments'], pageType, locale }),
// sdk.findEligibleMethods(), sdk.createPayPalOneTimePaymentSession({ onApprove, onCancel, onError }),
// session.start({ presentationMode: 'auto' }, createOrderPromise) where the promise resolves to { orderId }.
import { useEffect, useRef, useState } from 'react';
import type { DemoState, PayPalStep } from '../../../shared/types';
import { chf, post } from '../api';

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'paypal-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { type?: string };
    }
  }
}

type Json = Record<string, any>;
const SDK_URL = 'https://www.sandbox.paypal.com/web-sdk/v6/core';
let sdkScript: Promise<Json> | undefined;

function loadSdk(): Promise<Json> {
  sdkScript ??= new Promise((resolve, reject) => {
    const w = window as unknown as { paypal?: Json };
    if (w.paypal?.createInstance) return resolve(w.paypal);
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => (w.paypal?.createInstance ? resolve(w.paypal) : reject(new Error('PayPal SDK loaded without createInstance')));
    s.onerror = () => { sdkScript = undefined; reject(new Error('Could not load the PayPal JS SDK')); };
    document.head.appendChild(s);
  });
  return sdkScript;
}

let instance: Promise<{ sdk: Json; auth: 'clientToken' | 'clientId'; locale: string }> | undefined;

/** One SDK instance per page: browser-safe client token from our server, client id as the fallback. */
function sdkInstance(): Promise<{ sdk: Json; auth: 'clientToken' | 'clientId'; locale: string }> {
  instance ??= (async () => {
    const paypal = await loadSdk();
    const cfg = await (await fetch('/api/config')).json();
    const locale: string = cfg.paypalLocale || 'en-CH';
    const base = { components: ['paypal-payments'], pageType: 'checkout' };
    const tries: [Json, 'clientToken' | 'clientId'][] = [];
    const tok = await fetch('/api/paypal/client-token').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (tok?.clientToken) tries.push([{ ...base, clientToken: tok.clientToken }, 'clientToken']);
    if (cfg.paypalClientId) tries.push([{ ...base, clientId: cfg.paypalClientId }, 'clientId']);
    let last: unknown;
    for (const [opts, auth] of tries) {
      // en-CH first (English, Swiss formats); en-GB if this SDK build rejects it.
      for (const loc of [locale, 'en-GB']) {
        try {
          return { sdk: await paypal.createInstance({ ...opts, locale: loc }), auth, locale: loc };
        } catch (e) {
          last = e;
        }
      }
    }
    instance = undefined;
    throw last ?? new Error('No PayPal credentials for the JS SDK');
  })();
  return instance;
}

/** JS SDK v6 PayPal button for an order the server already created (intent=AUTHORIZE, amount from the server). */
function SdkButton({ orderId, onState, onFail }: { orderId: string; onState: (s: DemoState) => void; onFail: (why: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const [ready, setReady] = useState<{ auth: string; locale: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let cleanup = () => {};
    (async () => {
      try {
        const { sdk, auth, locale } = await sdkInstance();
        const eligible = await sdk.findEligibleMethods({ currencyCode: 'CHF' });
        if (!eligible.isEligible('paypal')) throw new Error('PayPal is not eligible for this buyer / currency');
        const session = sdk.createPayPalOneTimePaymentSession({
          onApprove: async (data: { orderId: string }) => {
            setBusy(true);
            try {
              onState((await post('/api/rush/authorize', { orderId: data.orderId })).state);
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          },
          onCancel: async () => {
            try { onState((await post('/api/rush/buyer-cancelled', { orderId })).state); } catch { /* notice is optional */ }
          },
          onError: (e: Error) => setErr(`PayPal: ${e?.message ?? e}`),
        });
        const el = ref.current;
        if (!alive || !el) return;
        const click = async () => {
          setErr(null);
          try {
            // The order exists already (created when the owner approved): resolve it, don't create a new one.
            await session.start({ presentationMode: 'auto' }, Promise.resolve({ orderId }));
          } catch (e) {
            setErr(`PayPal button: ${(e as Error).message}`);
          }
        };
        el.addEventListener('click', click);
        cleanup = () => el.removeEventListener('click', click);
        el.removeAttribute('hidden');
        setReady({ auth, locale });
      } catch (e) {
        if (alive) onFail((e as Error).message);
      }
    })();
    return () => { alive = false; cleanup(); };
  }, [orderId]);
  return (
    <div className="sdk-pay">
      <paypal-button id="paypal-sdk-button" type="pay" ref={ref} hidden />
      {!ready && <small className="muted">Loading PayPal…</small>}
      {ready && <small className="muted">PayPal JS SDK v6 · {ready.auth === 'clientToken' ? 'client token' : 'client id'} · locale {ready.locale}</small>}
      {busy && <small className="muted">Authorizing with PayPal…</small>}
      {err && <p className="callout bad small">{err}</p>}
    </div>
  );
}

/** The rush customer's checkout. Inline in the owner console, and standalone at #/pay (phone). */
export function RushCheckout({ state, onState, standalone = false }: { state: DemoState; onState: (s: DemoState) => void; standalone?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [sdkFailed, setSdkFailed] = useState<string | null>(null);
  const { rush, plan, rushOrder: o } = state;
  if (!rush || !plan || !o) return null;
  const run = async (path: string) => {
    setBusy(true);
    try { onState((await post(path)).state); } finally { setBusy(false); }
  };
  const open = state.stage === 'awaiting-payment' && o.status === 'created';
  return (
    <div className={`phone checkout ${standalone ? 'standalone' : ''}`}>
      <div className="phone-notch" />
      <div className="phone-screen">
        <div className="offer-shop">Werkstatt Reuss · rush order</div>
        <h3>{rush.qty}× {rush.title}</h3>
        <p className="offer-to">{rush.customer.contact} · {rush.customer.name}</p>
        <div className="offer-amount"><small>Total</small><b>{chf(plan.rushPriceChf)}</b><span className="pp-tag">PayPal · hold only</span></div>
        <p className="small muted">PayPal holds the amount now. You are charged only when the parts ship; if the workshop cancels, the hold is released and nothing is charged.</p>
        {open && state.modes.paypal === 'mock' && (
          <div className="pay-row">
            <button className="btn paypal" disabled={busy} onClick={() => run('/api/rush/mock-approve')}>Pay with PayPal <small>(mock)</small></button>
            <button className="btn small ghost dark" disabled={busy} onClick={() => run('/api/rush/mock-cancel')} title="Simulates the buyer closing the PayPal window">Buyer cancels (mock)</button>
          </div>
        )}
        {open && state.modes.paypal === 'sandbox' && (
          <>
            {!sdkFailed && <SdkButton orderId={o.orderId} onState={onState} onFail={setSdkFailed} />}
            {sdkFailed && <p className="callout warn small">PayPal button unavailable ({sdkFailed}). Use the PayPal page instead:</p>}
            {o.approveUrl && (
              <a id="paypal-approve" className={sdkFailed ? 'btn paypal' : 'link small'} href={o.approveUrl} target={standalone ? '_self' : '_blank'} rel="noreferrer">
                {sdkFailed ? 'Pay with PayPal (redirect)' : 'Or continue on the PayPal page (redirect)'}
              </a>
            )}
          </>
        )}
        {state.stage === 'awaiting-payment' && o.status !== 'created' && <p className="muted small">Approved. Waiting for PayPal to confirm the authorization…</p>}
        {state.stage === 'committed' && <p className="offer-done">✓ Payment held by PayPal. Your parts are scheduled.</p>}
        {state.paypalNotice && state.stage === 'awaiting-payment' && <p className={`callout ${state.paypalNotice.kind === 'error' ? 'bad' : 'warn'} small`} role="alert" id="paypal-notice">{state.paypalNotice.text}</p>}
      </div>
    </div>
  );
}

export function RushPayPage({ state, onState }: { state: DemoState; onState: (s: DemoState) => void }) {
  if (!state.rushOrder) return <div className="center muted">No rush checkout is open. Open it from the same browser as the owner console (each browser runs its own demo).</div>;
  return <div className="center offer-page"><RushCheckout state={state} onState={onState} standalone /></div>;
}

/** Merchant-side sandbox page for a transaction id (needs the sandbox business login; ids are also readable via the API). */
const sandboxUrl = (s: PayPalStep) =>
  s.id && !s.id.startsWith('SEED-') && (s.idKind === 'authorization' || s.idKind === 'capture' || s.idKind === 'refund')
    ? `https://www.sandbox.paypal.com/activity/payment/${s.id}` : undefined;

const STATUS_TONE: Record<string, string> = {
  COMPLETED: 'ok', CAPTURED: 'ok', SUCCESS: 'ok', APPROVED: 'ok', CREATED: 'hold', PAYER_ACTION_REQUIRED: 'wait', PENDING: 'wait',
  PROCESSING: 'wait', VOIDED: 'void', REFUNDED: 'void', PARTIALLY_REFUNDED: 'void', UNCLAIMED: 'warn', PAID: 'ok',
};

export function PayPalTrail({ steps, mode }: { steps: PayPalStep[]; mode: 'mock' | 'sandbox' }) {
  return (
    <ol className="pp-trail">
      {steps.map((s, i) => {
        const url = mode === 'sandbox' ? sandboxUrl(s) : undefined;
        return (
          <li key={i} className={`src-${s.source}`}>
            <span className="time">{new Date(s.at).toLocaleTimeString('de-CH')}</span>
            <span className={`pp-status ${STATUS_TONE[s.status] ?? ''}`}>{s.status || '—'}</span>
            <span className="pp-label">{s.label}{s.source === 'confirmed' ? ' ✓' : ''}</span>
            {s.id && (url
              ? <a className="pp-id" href={url} target="_blank" rel="noreferrer" title="Open in the PayPal sandbox (business account login)">{s.id} ↗</a>
              : <code className="pp-id">{s.id}</code>)}
            {s.api && <small className="pp-api">{s.api}</small>}
          </li>
        );
      })}
    </ol>
  );
}
