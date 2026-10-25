# Takt — airline bumping for factory schedules

When a job shop's schedule is full and a rush order arrives, Takt makes room. It finds booked customers who can wait, pays them for it through PayPal, and charges the rush customer a premium that covers the compensation. The schedule only changes when PayPal confirms the money moves.

> Status: phase 1. The PayPal layer runs against the real PayPal sandbox (verified end-to-end in CHF on 25 Oct 2026) or an offline mock. The timeline is a placeholder until Bryntum Scheduler Pro is wired in.

## Run locally

```bash
npm install
cp .env.example .env     # optional: add PayPal sandbox credentials
npm run dev              # API on :8787, web on http://localhost:5173
npm test                 # runs the full demo path 10x against the mock gateway
npm run dev:sandbox      # same app against the real PayPal sandbox
npm run smoke:sandbox    # the whole money story against the sandbox, 14 checks (headless buyer approval)
npm run build && npm start   # production: one process serves API + built web app on :8787
```

Without credentials the header shows **PayPal: MOCK**. Once `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set (in `.env`, or in the parent workspace's `.env`), it switches to the real sandbox.

### Sandbox notes

- **Rush customer:** "Pay with PayPal (sandbox)" opens PayPal's approval page. Log in with a sandbox *personal* account, or use "Pay with credit or debit card" with test card `4005519200000004`, any future expiry, CVV `123`. PayPal sends the buyer back to `/api/paypal/return`, and the server also polls the order, so the flow completes even without the redirect.
- **Seeded bookings** have placeholder authorizations. The first time Takt touches one, it creates a real sandbox authorization for the same amount with PayPal's test card (logged as "Sandbox booking authorization").
- **Payouts** go to `PAYPAL_SANDBOX_PAYOUT_RECEIVER` when it is set. Otherwise they end `UNCLAIMED`, because the seeded emails have no PayPal account.
- **No webhooks needed:** after each money move the server polls the resource and feeds a webhook-shaped event (`RECON-…`) into the same handler that verified webhooks use.

## How PayPal is used

| Step | API |
|---|---|
| Rush customer pays (hold only) | `POST /v2/checkout/orders` (intent `AUTHORIZE`), buyer approval (redirect now, JS SDK v6 next), then `POST /v2/checkout/orders/{id}/authorize` |
| Bumped customer who booked with an authorization | At shipment: `POST /v2/payments/authorizations/{id}/capture` for the authorized amount minus the compensation, with `final_capture:true` |
| Bumped customer who already paid in full | `POST /v1/payments/payouts` |
| Cancellation | `POST /v2/payments/authorizations/{id}/void` |
| Late-delivery policy | `POST /v2/payments/captures/{id}/refund` |
| Long jobs | `POST /v2/payments/authorizations/{id}/reauthorize` (after the 3-day honor period) |
| Confirmation | Reconcile by polling `GET` order / authorization / payout. Webhooks (`PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, …) go through the same handler once hosted, verified with `/v1/notifications/verify-webhook-signature` |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SPIKE.md](docs/SPIKE.md).

## License

MIT, see [LICENSE](LICENSE). Third-party services and libraries keep their own licences. In particular, Bryntum Scheduler Pro (planned) is a commercial library, used here under its trial terms and not included in this repository.
