import type { PayPalGateway } from './gateway.js';
import { MockPayPal } from './mock.js';
import { RestPayPal } from './rest.js';

export function createPayPal(env = process.env): PayPalGateway {
  const id = env.PAYPAL_CLIENT_ID;
  const secret = env.PAYPAL_CLIENT_SECRET;
  const mode = env.PAYPAL_MODE ?? (id && secret ? 'sandbox' : 'mock');
  if (mode === 'sandbox') {
    if (!id || !secret) throw new Error('PAYPAL_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env');
    return new RestPayPal(id, secret, env.PAYPAL_WEBHOOK_ID);
  }
  return new MockPayPal(Number(env.MOCK_PAYPAL_DELAY_MS ?? 700));
}

export type { PayPalGateway } from './gateway.js';
