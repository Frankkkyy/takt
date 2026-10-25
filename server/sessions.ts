// One demo shop per browser session, so judges never share (or reset) each other's state on the hosted demo.
// The session id lives in an HttpOnly cookie; state is in memory and expires after a TTL without requests.
import { randomBytes } from 'node:crypto';
import type { TaktApp } from './app.js';

export const SESSION_COOKIE = 'takt_sid';
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface Session {
  id: string;
  app: TaktApp;
  lastSeen: number;
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(
    private make: (id: string) => TaktApp,
    private opts: { ttlMs: number; max: number; onDrop?: (id: string) => void; now?: () => number },
  ) {}

  private now() { return (this.opts.now ?? Date.now)(); }

  static newId() { return randomBytes(18).toString('base64url'); }
  static validId(id: unknown): id is string { return typeof id === 'string' && ID_RE.test(id); }

  get size() { return this.sessions.size; }

  /** Existing live session for this id, or a fresh one (the id is kept when valid, so a cookie survives a restart). */
  get(id?: string): { session: Session; created: boolean } {
    this.sweep();
    const known = id && this.sessions.get(id);
    if (known) {
      known.lastSeen = this.now();
      return { session: known, created: false };
    }
    const sid = SessionStore.validId(id) ? id : SessionStore.newId();
    while (this.sessions.size >= this.opts.max) this.drop(this.oldest()!);
    const session = { id: sid, app: this.make(sid), lastSeen: this.now() };
    this.sessions.set(sid, session);
    return { session, created: true };
  }

  peek(id?: string) { return id ? this.sessions.get(id) : undefined; }

  /** PayPal return / cancel redirects only carry the order id: find the demo that created that order. */
  findByOrder(orderId: string) {
    for (const s of this.sessions.values()) if (s.app.ownsOrder(orderId)) return s;
    return undefined;
  }

  sweep() {
    const cutoff = this.now() - this.opts.ttlMs;
    for (const s of [...this.sessions.values()]) if (s.lastSeen < cutoff) this.drop(s.id);
  }

  private oldest() {
    let o: Session | undefined;
    for (const s of this.sessions.values()) if (!o || s.lastSeen < o.lastSeen) o = s;
    return o?.id;
  }

  private drop(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.app.dispose();
    this.sessions.delete(id);
    this.opts.onDrop?.(id);
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
