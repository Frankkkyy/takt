# Takt — airline bumping for factory schedules

When a job shop's schedule is full and a rush order arrives, Takt makes room. It finds booked customers who can wait, pays them for it through PayPal, and charges the rush customer a premium that covers the compensation. The schedule only changes when PayPal confirms the money moves.

> Status: early skeleton (phase 1). The PayPal layer runs against an offline mock until sandbox credentials are set. The timeline is a placeholder until Bryntum Scheduler Pro is wired in.

## Run locally

```bash
npm install
cp .env.example .env     # optional: add PayPal sandbox credentials
npm run dev              # API on :8787, web on http://localhost:5173
npm test                 # runs the full demo path 10x against the mock gateway
npm run build && npm start   # production: one process serves API + built web app on :8787
```

Without credentials the header shows **PayPal: MOCK**. Once `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set, it switches to the real sandbox.

## How PayPal is used

| Step | API |
|---|---|
| Rush customer pays (hold only) | `POST /v2/checkout/orders` (intent `AUTHORIZE`), JS SDK v6 approval, then `POST /v2/checkout/orders/{id}/authorize` |
| Bumped customer who booked with an authorization | At shipment: `POST /v2/payments/authorizations/{id}/capture` for the authorized amount minus the compensation, with `final_capture:true` |
| Bumped customer who already paid in full | `POST /v1/payments/payouts` |
| Cancellation | `POST /v2/payments/authorizations/{id}/void` |
| Late-delivery policy | `POST /v2/payments/captures/{id}/refund` |
| Long jobs | `POST /v2/payments/authorizations/{id}/reauthorize` (after the 3-day honor period) |
| Confirmation | Webhooks (`PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, …), verified with `/v1/notifications/verify-webhook-signature` |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SPIKE.md](docs/SPIKE.md).

## License

MIT, see [LICENSE](LICENSE). Third-party services and libraries keep their own licences. In particular, Bryntum Scheduler Pro (planned) is a commercial library, used here under its trial terms and not included in this repository.
