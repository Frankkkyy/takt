// Rough-cut demo video: drives the real app (PayPal sandbox, recorded Claude replays) through the shot list in
// contests/paypal-ai/submission/VIDEO_SCRIPT.md, burns the voice-over lines in as on-screen captions, cuts the dead
// waits (agent replies, PayPal popup, payout) and stitches everything into one MP4 with ffmpeg-static.
//
//   ANTHROPIC_API_KEY= PAYPAL_MODE=sandbox npm run dev     (empty key = replay/fallback only: zero Claude spend)
//   npm run record [baseUrl]
//
// Env: VIDEO_OUT (default ../../contests/paypal-ai/submission/video/takt-roughcut-v2.mp4)
//      VIDEO_WIDTH (default 1920: the 1440×900 capture is upscaled (lanczos) to 1920×1200 so YouTube serves its 1080p+ bitrate)
//      KEEP_CLIPS=1 (keep the raw Playwright .webm files and the cut segments next to the output)
// Captions and the cursor dot are overlays injected into the recorded page only; the app itself is unchanged.
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true }); // sandbox buyer login
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = path.resolve(process.env.VIDEO_OUT ?? new URL('../../../contests/paypal-ai/submission/video/takt-roughcut-v2.mp4', import.meta.url).pathname);
const W = 1440, H = 900;
const OW = Number(process.env.VIDEO_WIDTH ?? 1920), OH = Math.round((OW * H) / W / 2) * 2; // output size (even)
const work = mkdtempSync(path.join(tmpdir(), 'takt-video-'));
mkdirSync(path.dirname(out), { recursive: true });

// ---------- timeline bookkeeping: which seconds of which page video end up in the cut ----------
type Seg = { page: Page; start: number; end: number; shot: number; crop?: { w: number; h: number } };
const segs: Seg[] = [];
const t0 = new Map<Page, number>();
const popupSize = new Map<Page, { w: number; h: number }>(); // a popup window is smaller than the video frame: crop it
const now = (p: Page) => (Date.now() - t0.get(p)!) / 1000;
let open: { page: Page; start: number; shot: number } | null = null;
let shotNo = 0;
const shotVisible = new Map<number, number>();

function startSeg(page: Page) { open = { page, start: now(page), shot: shotNo }; }
function endSeg() {
  if (!open) return;
  const end = now(open.page);
  if (end - open.start > 0.15) {
    segs.push({ ...open, end, crop: popupSize.get(open.page) });
    shotVisible.set(open.shot, (shotVisible.get(open.shot) ?? 0) + end - open.start);
  }
  open = null;
}
const visibleInShot = () => (shotVisible.get(shotNo) ?? 0) + (open ? now(open.page) - open.start : 0);
/** Runs `fn` off camera (the wait is cut out of the video). */
async function offCamera<T>(page: Page, fn: () => Promise<T>, laterNote?: string): Promise<T> {
  endSeg();
  const t = Date.now();
  const r = await fn();
  if (laterNote !== undefined) await note(page, `~${Math.max(1, Math.round((Date.now() - t) / 1000))} s later${laterNote ? ` · ${laterNote}` : ''}`);
  startSeg(page);
  return r;
}
/** Pads the current shot with a hold until it reaches its scripted length. */
async function holdTo(page: Page, seconds: number) {
  const left = seconds - visibleInShot();
  if (left > 0) await page.waitForTimeout(left * 1000);
}
const pause = (page: Page, s: number) => page.waitForTimeout(s * 1000);

// ---------- overlays (recording only) ----------
// Plain JS string (tsx's keepNames helpers do not exist inside the page).
const OVERLAY = `(() => {
  if (document.getElementById('rec-cap')) return;
  const css = document.createElement('style');
  css.textContent = \`
  #rec-cap{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);max-width:min(1180px,calc(100vw - 40px));width:max-content;z-index:2147483647;
    background:rgba(10,14,24,.86);color:#fff;font:600 25px/1.35 system-ui,Segoe UI,Roboto,sans-serif;padding:12px 22px;border-radius:10px;
    text-align:center;pointer-events:none;transition:opacity .25s;box-shadow:0 4px 24px rgba(0,0,0,.35)}
  #rec-cap:empty{opacity:0}
  #rec-tag{position:fixed;left:12px;top:76px;z-index:2147483647;background:rgba(200,30,60,.9);color:#fff;font:700 13px system-ui,sans-serif;
    padding:3px 8px;border-radius:5px;pointer-events:none}
  #rec-note{position:fixed;right:18px;top:80px;z-index:2147483647;background:#111;color:#ffd75e;font:600 16px system-ui,sans-serif;padding:6px 12px;
    border-radius:6px;pointer-events:none}
  #rec-note:empty{display:none}
  #rec-cursor{position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;z-index:2147483647;pointer-events:none;
    background:rgba(255,200,0,.45);border:2px solid rgba(220,120,0,.9);transition:transform .12s}
  #rec-cursor.down{transform:scale(.7);background:rgba(255,120,0,.7)}
  .rec-hl{position:fixed;z-index:2147483646;border:4px solid #ff3b5c;border-radius:10px;pointer-events:none;box-shadow:0 0 0 4000px rgba(0,0,0,.18)}
  .rec-hl-label{position:absolute;left:-4px;top:-34px;background:#ff3b5c;color:#fff;font:700 15px system-ui,sans-serif;padding:3px 9px;border-radius:5px;white-space:nowrap}\`;
  function add() {
    if (document.getElementById('rec-cap')) return;
    document.head.appendChild(css);
    for (const id of ['rec-cap', 'rec-tag', 'rec-note', 'rec-cursor']) {
      const d = document.createElement('div'); d.id = id; document.body.appendChild(d);
    }
    const c = document.getElementById('rec-cursor');
    document.addEventListener('mousemove', function (e) { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    document.addEventListener('mousedown', function () { c.classList.add('down'); }, true);
    document.addEventListener('mouseup', function () { c.classList.remove('down'); }, true);
  }
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})()`;
async function ensureOverlay(page: Page) { await page.evaluate(OVERLAY); }
async function caption(page: Page, text: string) {
  await ensureOverlay(page);
  await page.evaluate((t) => { document.getElementById('rec-cap')!.textContent = t; }, text);
}
async function note(page: Page, text: string) {
  await ensureOverlay(page);
  await page.evaluate((t) => { document.getElementById('rec-note')!.textContent = t; }, text);
}
async function tag(page: Page, text: string) {
  await ensureOverlay(page);
  await page.evaluate((t) => { document.getElementById('rec-tag')!.textContent = t; }, text);
}
async function highlight(page: Page, loc: Locator, label = '', seconds = 2.5) {
  const b = await loc.boundingBox();
  if (!b) return;
  await page.evaluate(({ b, label }) => {
    const d = document.createElement('div'); d.className = 'rec-hl';
    Object.assign(d.style, { left: b.x - 6 + 'px', top: b.y - 6 + 'px', width: b.width + 12 + 'px', height: b.height + 12 + 'px' });
    if (label) { const l = document.createElement('div'); l.className = 'rec-hl-label'; l.textContent = label; d.appendChild(l); }
    document.body.appendChild(d);
  }, { b, label });
  await pause(page, seconds);
  await page.evaluate(() => document.querySelectorAll('.rec-hl').forEach((e) => e.remove()));
}

let mouse = { x: W / 2, y: H / 2 };
async function moveTo(page: Page, loc: Locator) {
  await loc.scrollIntoViewIfNeeded();
  const b = (await loc.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y, { steps: 18 });
  mouse = { x, y };
  await pause(page, 0.35);
}
async function clickOn(page: Page, loc: Locator) {
  await moveTo(page, loc);
  await page.mouse.down(); await pause(page, 0.08); await page.mouse.up();
}
/** Smooth scroll so the element sits near the top (or `block`) of the viewport. */
async function scrollTo(page: Page, loc: Locator, block: 'start' | 'center' | 'end' = 'start') {
  await loc.evaluate((e, block) => e.scrollIntoView({ behavior: 'smooth', block }), block);
  await pause(page, 0.9);
}
async function scrollTop(page: Page) { await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await pause(page, 0.9); }

async function newPage(ctx: BrowserContext) {
  const p = await ctx.newPage();
  t0.set(p, Date.now());
  await p.addInitScript({ content: OVERLAY });
  return p;
}

// ---------- shots ----------
const VO = {
  1: ["It's Friday afternoon in a small Swiss metal shop.", 'The laser and the press brake are booked all week.', 'Then a farmer writes: his harvester broke, and he needs six brackets by Tuesday.'],
  2: ['Saying no loses the best order of the week.', 'Squeezing it in silently costs another customer.', 'Airlines solved this long ago: they pay passengers who can wait.', 'Takt does the same for factory schedules.'],
  3: ['Claude reads the request in German, French or English and records a structured job.', "Notice what it doesn't do: the hours and the price come from code, from the shop's rate card."],
  4: ['A planner finds options that ship the rush on time and keep every firm promise.', "Claude picks whom to ask, and explains why: both customers told the shop they're flexible.", "It then writes each offer in the customer's own language."],
  5: ['Customers answer in their own words.', 'Atelier Rochat asks for Thursday and seventy francs.', "That's inside the limits, so Claude accepts, in French.", 'Studio Meier simply says yes.', 'And if someone tries to talk the agent into a big payout, it goes straight to the owner. Nothing changes.'],
  6: ['Until now, no money has moved.', 'The owner sees every payment and five checks that code enforces, then approves with one click.'],
  7: ['PayPal now moves the money.', 'Meier had prepaid, so they get a PayPal Payout.', 'The farmer pays with the PayPal button, but only as an authorization:', 'the money is held, not charged, until his parts ship.'],
  8: ['The schedule only changes once PayPal confirms the authorization.', 'The shop earns five hundred and seventy francs more this week, and nobody was let down.'],
  9: ['Rochat booked with a PayPal authorization.', 'At shipment, Takt simply captures seventy francs less. No refund, no second payment.', "Every PayPal id is on the job's timeline, and a cancelled rush is voided."],
  10: ['The AI reads and writes. Code does the numbers.', 'The owner decides. PayPal moves the money.'],
  11: ["Takt. Pay the customer who can wait, charge the one who can't."],
} as const;
const LEN: Record<number, number> = { 1: 12, 2: 12, 3: 16, 4: 18, 5: 18, 6: 16, 7: 20, 8: 14, 9: 16, 10: 14, 11: 6 }; // shot 5: + ~3 s injection insert
const skipped: string[] = [];

async function beginShot(page: Page, n: number) {
  endSeg();
  shotNo = n;
  await tag(page, `DRAFT · shot ${n}`);
  startSeg(page);
}

const email = process.env.PAYPAL_SANDBOX_BUYER_EMAIL, password = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
if (!email || !password) throw new Error('Needs PAYPAL_SANDBOX_BUYER_EMAIL / PAYPAL_SANDBOX_BUYER_PASSWORD (workspace .env)');

const browser = await chromium.launch();
const ctxOpts = { viewport: { width: W, height: H }, locale: 'en-GB', recordVideo: { dir: work, size: { width: W, height: H } } };
const ctx = await browser.newContext(ctxOpts);
const page = await newPage(ctx);
const cfg = await (await page.request.get(`${base}/api/config`)).json();
if (cfg.paypalMode !== 'sandbox') throw new Error(`PayPal mode is ${cfg.paypalMode}; start the app with PAYPAL_MODE=sandbox`);
await page.goto(base);
const board = page.locator('.bryntum-board');
await board.locator('.b-sch-event').first().waitFor({ timeout: 30_000 });
await page.mouse.move(W / 2, H / 2);

// Shot 1 + 2: cold open (CSS-timed: full shop -> email slides in -> hook). Reset replays the animation.
await page.getByRole('button', { name: 'Reset demo' }).click();
await page.mouse.move(1200, 330, { steps: 5 }); // on the story panel: no board tooltip
await beginShot(page, 1);
await caption(page, VO[1][0]); await pause(page, 3.5);
await caption(page, VO[1][1]); await pause(page, 3.5);
await caption(page, VO[1][2]); await holdTo(page, LEN[1]);
await beginShot(page, 2);
await caption(page, VO[2][0]); await pause(page, 2.6);
await caption(page, VO[2][1]); await pause(page, 2.8);
await caption(page, VO[2][2]);
await highlight(page, page.locator('.story .hook'), '', 3.4);
await caption(page, VO[2][3]); await holdTo(page, LEN[2]);

// Shot 3: intake.
await beginShot(page, 3);
await caption(page, VO[3][0]);
await clickOn(page, page.getByRole('button', { name: 'Open request' }));
await pause(page, 1.2);
await clickOn(page, page.getByRole('button', { name: 'DE email', exact: true }));
await pause(page, 1.2);
await clickOn(page, page.getByRole('button', { name: 'Let Takt read it' }));
await offCamera(page, () => page.locator('.extracted').waitFor({ timeout: 45_000 }));
await scrollTo(page, page.locator('.extracted'), 'center');
await pause(page, 2.5);
await caption(page, VO[3][1]);
await highlight(page, page.locator('.extracted .kv', { hasText: 'Base price' }), 'rate card (code)', 3);
await highlight(page, page.locator('.extracted .kv', { hasText: 'Extracted by' }), 'Claude Haiku 5.5 · recorded', 2);
await holdTo(page, LEN[3]);

// Shot 4: make room.
await beginShot(page, 4);
await caption(page, VO[4][0]);
await clickOn(page, page.getByRole('button', { name: 'Make room' }));
await offCamera(page, () => page.waitForSelector('.step-card[data-step="make-room"][data-feasible="true"]', { timeout: 45_000 }));
await scrollTop(page);
await pause(page, 1);
await highlight(page, board.locator('.takt-ev.ghost').first(), 'proposed slot', 2.5);
await caption(page, VO[4][1]);
await highlight(page, page.locator('.why').first(), 'Why these customers (Claude)', 4.5);
await caption(page, VO[4][2]);
const total = page.locator('.flow .stats').first(); // rush price · compensation · net uplift tiles
await scrollTo(page, total, 'center');
await highlight(page, total, '', 2.5);
await holdTo(page, LEN[4]);

// Shot 5: offers + free-text answers (phones are embedded in the owner console).
async function answer(who: RegExp, chip: string, pg = page) {
  const phone = pg.locator('.phone', { hasText: who });
  await scrollTo(pg, phone, 'start');
  await clickOn(pg, phone.locator('.demo-helper summary'));
  await clickOn(pg, phone.getByRole('button', { name: chip }));
  await scrollTo(pg, phone.locator('.reply textarea'), 'center');
  await pause(pg, 0.8);
  await clickOn(pg, phone.locator('.send-reply'));
  return phone;
}
await beginShot(page, 5);
await caption(page, VO[5][0]);
await clickOn(page, page.getByRole('button', { name: /^Send \d offers?$/ }));
await page.locator('.phone').first().waitFor();
await pause(page, 0.5);
await caption(page, VO[5][1]);
const rochat = await answer(/Rochat/, 'Counter (FR)');
await offCamera(page, () => rochat.locator('.offer-done').waitFor({ timeout: 45_000 }));
await scrollTo(page, rochat.locator('.offer-done'), 'end');
await caption(page, VO[5][2]);
await pause(page, 1.2);
const showEn = rochat.getByRole('button', { name: 'Show English' }).last();
if (await showEn.count()) {
  await clickOn(page, showEn); await pause(page, 1.3);
  const orig = rochat.getByRole('button', { name: 'Original' }).last();
  if (await orig.count()) await clickOn(page, orig);
}
await caption(page, VO[5][3]);
const meier = await answer(/Meier/, 'Yes (DE)');
await offCamera(page, () => page.locator('#approve-moves').waitFor({ timeout: 45_000 }));
await scrollTo(page, meier.locator('.offer-done'), 'end');
await pause(page, 0.8);
await holdTo(page, LEN[5]);
endSeg();
const injectionAt = segs.length; // the injection insert (recorded later, in its own session) is spliced in here
await caption(page, '');

// Shot 6: owner approval.
await beginShot(page, 6);
await caption(page, VO[6][0]);
const approve = page.locator('#approve-moves');
await scrollTo(page, approve, 'end');
await highlight(page, page.getByRole('heading', { name: 'Everyone agreed. Your approval moves the money.' }), '', 2);
await caption(page, VO[6][1]);
await highlight(page, page.locator('.flow .checks').first(), '5 checks enforced by code', 5);
await moveTo(page, approve);
await holdTo(page, LEN[6] - 0.6);
await clickOn(page, approve);

// Shot 7: payout + rush checkout through the JS SDK v6 popup.
await beginShot(page, 7);
await caption(page, VO[7][0]);
const payoutLine = page.getByText(/Payout to Studio Meier/).first();
await offCamera(page, () => payoutLine.waitFor({ timeout: 60_000 }));
await scrollTo(page, payoutLine, 'center');
await caption(page, VO[7][1]);
await highlight(page, payoutLine.locator('xpath=ancestor::li[1]'), 'PayPal Payout · CHF 45', 3);
const sdkButton = page.locator('#paypal-sdk-button');
await offCamera(page, async () => {
  await sdkButton.waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('.phone.checkout').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
});
await caption(page, VO[7][2]);
await scrollTo(page, page.locator('.phone.checkout'), 'center');
await highlight(page, page.locator('.sdk-pay').first(), 'PayPal JS SDK v6', 2);
await holdTo(page, LEN[7] - 9);
await moveTo(page, sdkButton);
const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 30_000 }), page.mouse.click(mouse.x, mouse.y)]);
t0.set(popup, Date.now());
endSeg();
await popup.waitForLoadState('domcontentloaded');
const ps = await popup.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
if (ps.w < W || ps.h < H) popupSize.set(popup, { w: Math.min(ps.w, W), h: Math.min(ps.h, H) });
await popup.locator('#email').waitFor({ timeout: 60_000 });
await popup.waitForTimeout(3000); // the login page hydrates late
await caption(popup, 'PayPal sandbox popup · the farmer logs in');
startSeg(popup);
await popup.locator('#email').pressSequentially(email, { delay: 25 });
endSeg();
const next = popup.locator('#btnNext');
if (await next.isVisible()) await next.click();
await popup.locator('#password').fill(password);
await popup.locator('#btnLogin').click();
const submit = popup.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button[data-id="payment-submit-btn"]').first();
await submit.waitFor({ timeout: 60_000 });
const card = popup.locator('[data-testid^="CC-"][data-testid$="-fundingInstrument-container"]').first();
if (await card.count()) { await card.click(); await popup.waitForTimeout(800); }
await popup.waitForTimeout(1500);
await caption(popup, VO[7][3]);
startSeg(popup);
await popup.waitForTimeout(3500);
await submit.click();
await popup.waitForTimeout(600);
endSeg();
await popup.waitForEvent('close', { timeout: 90_000 });
await page.waitForSelector('.step-card[data-step="committed"]', { timeout: 90_000 });
// Payout status (cut the wait): the batch settles a few seconds after approval (webhook / poll).
const delivered = page.getByText(/Compensation delivered|PAYOUTS-ITEM\.SUCCEEDED/).first();
if (await delivered.waitFor({ timeout: 60_000 }).then(() => true, () => false)) {
  await caption(page, VO[7][1]);
  await note(page, 'cut: payout settled later');
  startSeg(page);
  await scrollTo(page, delivered, 'center');
  await highlight(page, delivered.locator('xpath=ancestor::li[1]'), 'Payout to Studio Meier · SUCCESS', 2.5);
  endSeg();
} else skipped.push('shot 7: payout SUCCESS line did not appear within 60 s');

// Shot 8: committed.
await scrollTop(page);
await page.mouse.move(5, 5);
await note(page, '');
await beginShot(page, 8);
await caption(page, VO[8][0]);
await highlight(page, page.getByRole('heading', { name: 'PayPal confirmed. The rush is on the board.' }), '', 2.2);
await highlight(page, board, 'rush job placed, bumped jobs moved', 3.5);
await caption(page, VO[8][1]);
await highlight(page, page.locator('.net').first().locator('xpath=..'), 'net uplift', 4);
await holdTo(page, LEN[8]);

// Shot 9: settle (capture less), timeline, live check, void.
await beginShot(page, 9);
await caption(page, VO[9][0]);
const row = page.locator('.settle .offer-row', { hasText: 'J-2044' });
await scrollTo(page, page.locator('.step-head[data-step="settle"]'), 'center');
await highlight(page, page.locator('.step-head[data-step="settle"]'), '', 1.5);
await clickOn(page, row.getByRole('button', { name: 'Ship' })); // the only amber Ship button (next job to ship)
await offCamera(page, () => row.locator('.good').waitFor({ timeout: 30_000 }).catch(() => {}));
await caption(page, VO[9][1]);
await highlight(page, row, 'captured CHF 70 less', 3);
await caption(page, VO[9][2]);
await clickOn(page, row.locator('xpath=..').locator('details.pp-box summary'));
const job = page.locator('.settle-job[data-job="J-2044"]');
await clickOn(page, job.getByRole('button', { name: 'Check in PayPal' }));
await offCamera(page, () => job.locator('.src-live-check').first().waitFor({ timeout: 30_000 }));
await scrollTo(page, job.locator('.pp-trail'), 'center');
await highlight(page, job.locator('.pp-trail'), 'PayPal timeline · live status', 2.5);
const rushJob = page.locator('.settle-job', { hasText: '(rush)' });
await clickOn(page, rushJob.getByRole('button', { name: 'Cancel rush (void)' }));
await offCamera(page, () => rushJob.locator('.bad-text').waitFor({ timeout: 30_000 }));
await scrollTo(page, rushJob, 'center');
await highlight(page, rushJob, 'rush cancelled · authorization voided', 2);
await holdTo(page, LEN[9]);

// Shot 10: the in-app strip (who did the last three beats), then the recap card.
const strip = page.locator('.cc-strip');
await scrollTo(page, strip, 'center');
await page.mouse.move(5, 5);
await beginShot(page, 10);
await caption(page, VO[10][0]);
await highlight(page, strip, 'Claude reads & writes · Code does the numbers · Owner decides · PayPal moves money', 5.5);
endSeg();
// Shot 10 (card) + 11: own cards (rendered here, recording only).
const CARD = (body: string) => `<!doctype html><html><head><style>
  body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#16233f;color:#fff;font-family:system-ui,Segoe UI,Roboto,sans-serif}
  .row{display:flex;align-items:center;gap:12px}.box{background:#24365e;border:2px solid #4a6aa8;border-radius:16px;padding:28px 22px;width:232px;text-align:center}
  .box b{display:block;font-size:34px;margin-bottom:8px;color:#ffd75e}.box span{font-size:22px;line-height:1.4;color:#d9e2f5}.arrow{font-size:34px;color:#7f9bd6}
  .small{margin-top:44px;font-size:22px;max-width:1200px;text-align:center;color:#b6c4e3}.big{font-size:120px;font-weight:800;letter-spacing:1px}.sub{font-size:40px;color:#ffd75e;margin-top:8px}
  .by{margin-top:48px;font-size:30px}.url{margin-top:14px;font-size:28px;color:#9fb7ea}</style></head><body>${body}</body></html>`;
await page.setContent(CARD(`<div class="row">
  <div class="box"><b>Claude</b><span>reads &amp; writes: requests, whom to ask, offers, replies</span></div><div class="arrow">→</div>
  <div class="box"><b>Code</b><span>does the numbers: prices, plans, every limit</span></div><div class="arrow">→</div>
  <div class="box"><b>Owner</b><span>decides: approves every money move</span></div><div class="arrow">→</div>
  <div class="box"><b>PayPal</b><span>moves money: holds, captures less, pays out, voids</span></div></div>
  <div class="small">20/20 agent eval · 49 tests · PayPal sandbox, CHF · Bryntum Scheduler Pro: drag a job and the agent prices the move</div>`));
await page.mouse.move(-10, -10);
await caption(page, VO[10][1]);
startSeg(page);
await holdTo(page, LEN[10]);
await page.setContent(CARD(`<div class="big">Takt</div><div class="sub">Airline bumping for factory schedules</div>
  <div class="by">Built by Francisco Del Barrio</div><div class="url">github.com/Frankkkyy/takt</div>`));
await beginShot(page, 11);
await caption(page, VO[11][0]); await holdTo(page, LEN[11]);
endSeg();
await ctx.close();

// Injection insert (shot 5): its own fresh session. The recorded injection reply was made on the EN intake, so this
// take uses the EN sample; replying on Meier first would otherwise spoil the main take's recorded "Yes (DE)".
const ctx2 = await browser.newContext(ctxOpts);
const p2 = await newPage(ctx2);
await p2.goto(base);
await p2.locator('.bryntum-board .b-sch-event').first().waitFor({ timeout: 30_000 });
await p2.getByRole('button', { name: 'Open request' }).click();
await p2.getByRole('button', { name: 'EN web form', exact: true }).click();
await p2.getByRole('button', { name: 'Let Takt read it' }).click();
await p2.locator('.extracted').waitFor({ timeout: 45_000 });
await p2.getByRole('button', { name: 'Make room' }).click();
await p2.waitForSelector('.step-card[data-step="make-room"][data-feasible="true"]', { timeout: 45_000 });
await p2.getByRole('button', { name: /^Send \d offers?$/ }).click();
await p2.locator('.phone').first().waitFor();
const mphone = p2.locator('.phone', { hasText: /Meier/ });
await mphone.locator('.demo-helper summary').click();
await mphone.getByRole('button', { name: 'Injection' }).click();
await mphone.locator('.reply textarea').scrollIntoViewIfNeeded();
await p2.evaluate(() => window.scrollBy(0, 200));
shotNo = 5;
await tag(p2, 'DRAFT · shot 5 (insert)');
await caption(p2, VO[5][4]);
await note(p2, 'Insert: prompt injection (another take)');
const insStart = segs.length;
startSeg(p2);
await pause(p2, 1);
await clickOn(p2, mphone.locator('.send-reply'));
await offCamera(p2, () => mphone.locator('.callout.warn').or(p2.getByText('Agent escalated to the owner')).first().waitFor({ timeout: 45_000 }));
await scrollTo(p2, mphone.locator('.callout.warn').first(), 'center');
await highlight(p2, mphone.locator('.callout.warn').first(), 'escalated to the owner · nothing paid', 2);
endSeg();
const insertion = segs.splice(insStart);
segs.splice(injectionAt, 0, ...insertion);
await ctx2.close();
await browser.close();

// ---------- cut + stitch ----------
const ff = ffmpegPath as unknown as string;
const parts: string[] = [];
for (const [i, s] of segs.entries()) {
  const src = await s.page.video()!.path();
  const dst = path.join(work, `seg-${String(i).padStart(3, '0')}.mp4`);
  const crop = s.crop ? `crop=${s.crop.w}:${s.crop.h}:0:0,` : '';
  execFileSync(ff, ['-y', '-loglevel', 'error', '-i', src, '-ss', s.start.toFixed(3), '-to', s.end.toFixed(3),
    '-vf', `${crop}scale=${OW}:${OH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${OW}:${OH}:(ow-iw)/2:(oh-ih)/2:color=0x16233f,fps=30,format=yuv420p`,
    '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', dst]);
  parts.push(dst);
}
const list = path.join(work, 'list.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
execFileSync(ff, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
const probe = (() => { try { execFileSync(ff, ['-i', out], { stdio: 'pipe' }); return ''; } catch (e) { return String((e as { stderr?: Buffer }).stderr ?? ''); } })();
const dur = /Duration: ([\d:.]+)/.exec(probe)?.[1];

console.log(`\nShot lengths (visible seconds, target in brackets):`);
let cum = 0;
for (let n = 1; n <= 11; n++) {
  const v = segs.filter((s) => s.shot === n).reduce((a, s) => a + s.end - s.start, 0);
  console.log(`  ${String(n).padStart(2)}  ${fmt(cum)}  ${v.toFixed(1)} s  [${n === 5 ? LEN[n] + 3 : LEN[n]} s]`);
  cum += v;
}
function fmt(s: number) { return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
if (skipped.length) console.log(`Skipped: ${skipped.join('; ')}`);
console.log(`\n${out}\nduration ${dur} (${segs.length} segments)`);
if (process.env.KEEP_CLIPS === '1') cpSync(work, path.join(path.dirname(out), 'clips'), { recursive: true });
rmSync(work, { recursive: true, force: true });
