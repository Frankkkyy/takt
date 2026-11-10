// Demo video: drives the real app (PayPal sandbox, recorded Claude replays) through the shot list in
// contests/paypal-ai/submission/VIDEO_SCRIPT.md, burns the voice-over lines in as on-screen captions, cuts the dead
// waits (agent replies, PayPal popup, payout) and stitches everything into one MP4 with ffmpeg-static.
//
//   ANTHROPIC_API_KEY= PAYPAL_MODE=sandbox npm run dev     (empty key = replay/fallback only: zero Claude spend)
//   npm run record [baseUrl]
//
// Env: VIDEO_OUT (default ../../contests/paypal-ai/submission/video/takt-roughcut-v3.mp4)
//      VIDEO_WIDTH (default 1920: the 1440×810 capture is upscaled (lanczos) to 1920×1080, 16:9)
//      STOP_AFTER=n (stop the main take after shot n: quick framing checks without the PayPal login)
//      PARTS=main,inject,drag (which takes to record; default all three)
//      KEEP_CLIPS=1 (keep the raw Playwright .webm files and the cut segments next to the output)
//      VO_JSON (default ../video/audio/vo.json from audio/vo_gen.py): voice-over line lengths; each caption waits until the
//        previous line has been spoken, and <out>.cues.json records when each line, click and shot lands in the cut (audio/mix.py)
//      FINAL=1 hides the DRAFT tag
// Captions, the cursor dot, the highlight boxes and the camera (a zoom on #root that follows the narration) are injected
// into the recorded page only; the app itself is unchanged. The cold open's CSS beats are released on the narration.
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true }); // sandbox buyer login
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = path.resolve(process.env.VIDEO_OUT ?? new URL('../../../contests/paypal-ai/submission/video/takt-roughcut-v3.mp4', import.meta.url).pathname);
const W = 1440, H = 810;
const STOP = Number(process.env.STOP_AFTER ?? 99);
const PARTS = new Set((process.env.PARTS ?? 'main,inject,drag').split(','));
const OW = Number(process.env.VIDEO_WIDTH ?? 1920), OH = Math.round((OW * H) / W / 2) * 2; // output size (even)
const work = mkdtempSync(path.join(tmpdir(), 'takt-video-'));
mkdirSync(path.dirname(out), { recursive: true });

// ---------- timeline bookkeeping: which seconds of which page video end up in the cut ----------
type Seg = { id: number; page: Page; start: number; end: number; shot: number; crop?: { w: number; h: number } };
const segs: Seg[] = [];
const t0 = new Map<Page, number>();
const popupSize = new Map<Page, { w: number; h: number }>(); // a popup window is smaller than the video frame: crop it
const now = (p: Page) => (Date.now() - t0.get(p)!) / 1000;
let open: { id: number; page: Page; start: number; shot: number } | null = null;
let segId = 0;
let shotNo = 0;
const shotVisible = new Map<number, number>();

function startSeg(page: Page) {
  open = { id: ++segId, page, start: now(page), shot: shotNo };
  for (const c of cues) if (c.segId === -1) c.segId = open.id; // cues set off camera land at the start of the next segment
}
function endSeg() {
  if (!open) return;
  const end = now(open.page);
  if (end - open.start > 0.15) {
    segs.push({ ...open, end, crop: popupSize.get(open.page) });
    shotVisible.set(open.shot, (shotVisible.get(open.shot) ?? 0) + end - open.start);
  }
  open = null;
}
// ---------- voice-over pacing + cue sheet ----------
const voPath = process.env.VO_JSON ?? new URL('../../../contests/paypal-ai/submission/video/audio/vo.json', import.meta.url).pathname;
const voDur = new Map<string, number>(existsSync(voPath) ? (JSON.parse(readFileSync(voPath, 'utf8')) as { text: string; dur: number }[]).map((v) => [v.text, v.dur]) : []);
const VO_GAP = 0.3;
let voEnd = 0; // when the line being spoken ends (seconds of recorded footage)
const voiced = new Set<string>();
type Cue = { kind: 'vo' | 'click' | 'shot'; text?: string; shot?: number; segId: number; offset: number };
const cues: Cue[] = [];
function cue(kind: Cue['kind'], extra: { text?: string; shot?: number } = {}) {
  cues.push({ kind, ...extra, segId: open ? open.id : -1, offset: open ? now(open.page) - open.start : 0 });
}
/** Seconds of footage recorded so far (recording order: the inserts are recorded last and spliced in afterwards). */
const cutNow = () => segs.reduce((a, s) => a + s.end - s.start, 0) + (open ? now(open.page) - open.start : 0);
/** Holds the frame until the current voice-over line has been spoken. */
async function waitVoice() {
  if (!open) return;
  const left = voEnd + VO_GAP - cutNow();
  if (left > 0) await open.page.waitForTimeout(left * 1000);
}
/** Runs `fn` off camera (the wait is cut out of the video). */
async function offCamera<T>(page: Page, fn: () => Promise<T>, laterNote?: string): Promise<T> {
  endSeg();
  const t = Date.now();
  const r = await fn();
  if (laterNote !== undefined) await note(page, `~${Math.max(1, Math.round((Date.now() - t) / 1000))} s later${laterNote ? ` · ${laterNote}` : ''}`);
  startSeg(page);
  return r;
}
const pause = (page: Page, s: number) => page.waitForTimeout(s * 1000);

// ---------- overlays (recording only) ----------
// Plain JS string (tsx's keepNames helpers do not exist inside the page).
const OVERLAY = `(() => {
  if (window.__camFrame) return;
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
  #rec-tag:empty{display:none}
  .rec-hl.below .rec-hl-label{top:auto;bottom:-34px}
  #rec-cap.side{left:calc((100vw - 426px) / 2);max-width:900px}
  html.rec-zoom #rec-cap.side{left:50%;max-width:min(1180px,calc(100vw - 40px))}
  #rec-note.side{right:auto;left:12px;top:110px}
  html.rec-zoom #rec-note.side{left:auto;right:18px;top:18px}
  html.rec-stick .main > .left{position:sticky;top:var(--rec-stick-top,0px)}
  html.rec-stick .main > .left .ledger{max-height:var(--rec-ledger-max,none);overflow:clip}
  html.rec-stick .main::after{content:'';grid-column:1/-1;height:100vh}
  #rec-cursor{position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;z-index:2147483647;pointer-events:none;
    background:rgba(255,200,0,.45);border:2px solid rgba(220,120,0,.9);transition:transform .12s}
  #rec-cursor.down{transform:scale(.7);background:rgba(255,120,0,.7)}
  .rec-hl{position:fixed;z-index:2147483646;border:4px solid #ff3b5c;border-radius:10px;pointer-events:none;box-shadow:0 0 0 4000px rgba(0,0,0,.18)}
  .rec-hl-label{position:absolute;left:-4px;top:-34px;background:#ff3b5c;color:#fff;font:700 15px system-ui,sans-serif;padding:3px 9px;border-radius:5px;white-space:nowrap}
  /* camera: a zoom on the app root; the overlays above live in <body>, outside it, and keep their size */
  #root{transform-origin:0 0}
  html.rec-zoom .step-cue{display:none}
  /* side panel beside a zoomed phone: covers the cut-off left column and carries the caption */
  #rec-side{position:fixed;left:0;top:0;bottom:0;width:var(--rec-side-w,0px);z-index:2147483645;pointer-events:none;opacity:0;transition:opacity .3s;
    background:radial-gradient(120% 140% at 0% 0%,#233041 0%,#121923 60%);color:#aeb8c6;font:700 15px system-ui,sans-serif;letter-spacing:1.6px;
    text-transform:uppercase;padding:54px 0 0 64px;box-sizing:border-box}
  html.rec-panel #rec-side{opacity:1}
  html.rec-panel #rec-cap,html.rec-panel #rec-cap.side{left:64px;bottom:auto;top:50%;transform:translateY(-50%);width:auto;max-width:calc(var(--rec-side-w) - 128px);
    background:none;box-shadow:none;padding:0;text-align:left;font-size:42px;line-height:1.26}
  html.rec-panel #rec-note,html.rec-panel #rec-note.side{left:64px;right:auto;top:auto;bottom:54px}
  /* cold open: each CSS beat (bars fill, email slides in, hook line) waits until the narration reaches it */
  .story .mail-toast,.story .hook{animation-delay:0s}
  html.rec-hold-meter .story .meter i,html.rec-hold-mail .story .mail-toast,html.rec-hold-hook .story .hook{animation-play-state:paused}
  html.rec-nostory .story{display:none}
  html:not(.rec-tips) .b-tooltip{display:none !important}
  html.rec-onecol .main{grid-template-columns:minmax(0,1fr)}\`;
  const CAM = window.__cam = { s: 1, fx: 0, fy: 0 };
  let anim = 0;
  const root = () => document.getElementById('root');
  // The frame is a sub-rectangle (fx, fy, 1/s) of the layout viewport, so sticky parts and scrolling behave as in a zoomed window.
  function apply() {
    const r = root(); if (!r) return;
    if (CAM.s === 1 && !CAM.fx && !CAM.fy) { r.style.transform = 'none'; return; }
    const rx = r.offsetLeft - window.scrollX, ry = r.offsetTop - window.scrollY, s = CAM.s;
    r.style.transform = 'translate(' + (-CAM.fx * s + rx * (s - 1)) + 'px,' + (-CAM.fy * s + ry * (s - 1)) + 'px) scale(' + s + ')';
  }
  window.addEventListener('scroll', function () { if (CAM.s !== 1) apply(); }, true);
  // rects: boxes as seen on screen now (or null = whole console). o: { pad, max, cap, ms, block, keep, top }
  window.__camFrame = function (rects, o) {
    return new Promise(function (done) {
      const r = root(), W = window.innerWidth, H = window.innerHeight, sy = window.scrollY;
      if (!r) return done(null);
      const from = { s: CAM.s, fx: CAM.fx, fy: CAM.fy, y: sy };
      let to;
      if (!rects) to = { s: 1, fx: 0, fy: 0, y: o.top ? 0 : sy };
      else {
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        rects.forEach(function (b) {
          const dx = CAM.fx + b.x / CAM.s, dy = sy + CAM.fy + b.y / CAM.s;
          x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx + b.width / CAM.s); y1 = Math.max(y1, dy + b.height / CAM.s);
        });
        x0 -= o.pad; x1 += o.pad; y0 -= o.pad; y1 += o.pad;
        const s = o.keep ? CAM.s : Math.max(1, Math.min(o.max, W / (x1 - x0), (H - o.cap) / (y1 - y0)));
        const vh = (H - (s > 1 ? o.cap : 0)) / s;
        const fx = Math.max(0, Math.min(W - W / s, (x0 + x1) / 2 - W / (2 * s)));
        const top = o.block === 'start' ? y0 : o.block === 'end' ? y1 - vh : (y0 + y1) / 2 - vh / 2;
        const maxY = Math.max(0, r.offsetTop + r.offsetHeight - H), fyMax = H - H / s;
        let y = sy, fy = top - y;
        if (fy < 0 || fy > fyMax) { y = Math.max(0, Math.min(maxY, top - Math.max(0, Math.min(fyMax, fy)))); fy = Math.max(0, Math.min(fyMax, top - y)); }
        to = { s: s, fx: fx, fy: fy, y: y };
      }
      const id = ++anim, t0 = performance.now(), cls = document.documentElement.classList;
      let finished = false;
      function set(k) {
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        CAM.s = from.s + (to.s - from.s) * e; CAM.fx = from.fx + (to.fx - from.fx) * e; CAM.fy = from.fy + (to.fy - from.fy) * e;
        if (to.y !== from.y) window.scrollTo({ top: from.y + (to.y - from.y) * e, behavior: 'instant' });
        apply();
      }
      function end() {
        if (finished) return; finished = true;
        if (id === anim) { set(1); r.style.willChange = ''; cls.toggle('rec-zoom', to.s > 1); }
        done(to);
      }
      if (to.s > 1 || from.s > 1) cls.add('rec-zoom');
      if (!o.ms) return end();
      if (to.s > 1 || from.s > 1) r.style.willChange = 'transform';
      (function step() {
        if (finished || id !== anim) return;
        const k = Math.min(1, (performance.now() - t0) / o.ms);
        if (k >= 1) return end();
        set(k); requestAnimationFrame(step);
      })();
      setTimeout(end, o.ms + 500);
    });
  };
  function add() {
    if (document.getElementById('rec-cap')) return;
    document.head.appendChild(css);
    for (const id of ['rec-side', 'rec-cap', 'rec-tag', 'rec-note', 'rec-cursor']) {
      const d = document.createElement('div'); d.id = id; document.body.appendChild(d);
    }
    const c = document.getElementById('rec-cursor');
    document.addEventListener('mousemove', function (e) { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; c.style.opacity = e.clientX > window.innerWidth - 8 ? '0' : '1'; }, true); // parked on the margin = hidden
    document.addEventListener('mousedown', function () { c.classList.add('down'); }, true);
    document.addEventListener('mouseup', function () { c.classList.remove('down'); }, true);
  }
  window.__recAdd = add;
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})()`;
async function ensureOverlay(page: Page) {
  await page.evaluate(OVERLAY);
  await page.evaluate(() => (window as unknown as { __recAdd: () => void }).__recAdd()); // page.setContent() drops the nodes, not the script
}
async function caption(page: Page, text: string) {
  await ensureOverlay(page);
  const d = voDur.get(text);
  if (d !== undefined && !voiced.has(text)) {
    await waitVoice();
    voiced.add(text);
    cue('vo', { text });
    voEnd = cutNow() + d;
  }
  await page.evaluate((t) => { document.getElementById('rec-cap')!.textContent = t; }, text);
}
async function note(page: Page, text: string) {
  await ensureOverlay(page);
  await page.evaluate((t) => { document.getElementById('rec-note')!.textContent = t; }, text);
}
async function tag(page: Page, text: string) {
  await ensureOverlay(page);
  await page.evaluate((t) => { document.getElementById('rec-tag')!.textContent = t; }, process.env.FINAL === '1' ? '' : text);
}
/** Caption + note centred under the left column (off the phones / right panel), or back to the frame centre. */
async function side(page: Page, on: boolean) {
  await ensureOverlay(page);
  await page.evaluate((on) => ['rec-cap', 'rec-note'].forEach((id) => document.getElementById(id)!.classList.toggle('side', on)), on);
}
/** Recording-only: pin the left column while the right panel scrolls, so the frame is never half empty.
 *  'board' pins it at the top (board + strip + newest log rows); 'log' scrolls it up to start at the Claude/Code strip.
 *  Call it with the camera wide (it measures on-screen boxes). */
async function stickLeft(page: Page, mode: 'board' | 'log' | null) {
  await page.evaluate((mode) => {
    const root = document.documentElement;
    root.classList.toggle('rec-stick', !!mode);
    const left = document.querySelector<HTMLElement>('.main > .left'), strip = document.querySelector<HTMLElement>('.cc-strip');
    const top = mode === 'log' && left && strip ? -(strip.getBoundingClientRect().top - left.getBoundingClientRect().top) + 12 : 0;
    root.style.setProperty('--rec-stick-top', `${top}px`);
    // The log is cut at the bottom of the viewport (overflow:clip: not scrollable, so scrollIntoView cannot shift it).
    const ledger = document.querySelector<HTMLElement>('.main > .left .ledger');
    const ledgerTop = left && ledger ? ledger.getBoundingClientRect().top - left.getBoundingClientRect().top + top : 0;
    // 'log' mode: keep the log above the side caption (bottom 28 px + ~2 lines) so no row sits under it
    root.style.setProperty('--rec-ledger-max', `${Math.max(200, window.innerHeight - ledgerTop - (mode === 'log' ? 130 : 16))}px`);
  }, mode);
}
async function highlight(page: Page, loc: Locator | { x: number; y: number; width: number; height: number }, label = '', seconds = 2.5, below = false) {
  const b = 'boundingBox' in loc ? await loc.boundingBox() : loc;
  if (!b) return;
  await page.evaluate(({ b, label, below }) => {
    const d = document.createElement('div'); d.className = below ? 'rec-hl below' : 'rec-hl';
    Object.assign(d.style, { left: b.x - 6 + 'px', top: b.y - 6 + 'px', width: b.width + 12 + 'px', height: b.height + 12 + 'px' });
    if (label) { const l = document.createElement('div'); l.className = 'rec-hl-label'; l.textContent = label; d.appendChild(l); }
    document.body.appendChild(d);
  }, { b, label, below });
  await pause(page, seconds);
  await page.evaluate(() => document.querySelectorAll('.rec-hl').forEach((e) => e.remove()));
}

// ---------- camera ----------
const CAP = 118; // bottom strip kept clear for the caption while zoomed
type Box = { x: number; y: number; width: number; height: number };
type Target = Locator | Box;
type CamOpts = { max?: number; pad?: number; ms?: number; hold?: number; block?: 'start' | 'center' | 'end'; keep?: boolean; cap?: number; top?: boolean };
const camState = (page: Page) => page.evaluate(() => (window as unknown as { __cam?: { s: number } }).__cam?.s ?? 1);
/** Frames the target(s): zooms in (up to `max`) and pans, scrolling only when the target is outside the window.
 *  `null` = back to the whole console. `keep` keeps the current zoom (a pan / scroll). */
async function cam(page: Page, target: Target | Target[] | null, o: CamOpts = {}) {
  const rects: Box[] = [];
  for (const t of target === null ? [] : Array.isArray(target) ? target : [target]) {
    const b = 'boundingBox' in t ? await t.first().boundingBox() : t;
    if (b) rects.push(b);
  }
  if (target !== null && !rects.length) return;
  await page.evaluate(({ rects, o }) => (window as unknown as { __camFrame: (r: unknown, o: unknown) => Promise<unknown> }).__camFrame(rects, o),
    { rects: target === null ? null : rects, o: { pad: o.pad ?? 28, max: o.max ?? 1.8, cap: o.cap ?? CAP, ms: o.ms ?? 900, block: o.block ?? 'center', keep: !!o.keep, top: !!o.top } });
  if (o.hold) await pause(page, o.hold);
}
/** The box around every match of a locator (e.g. all bars on the board). */
async function union(loc: Locator): Promise<Box> {
  return loc.evaluateAll((els) => {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const e of els) { const b = e.getBoundingClientRect(); x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom); }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  });
}
/** The whole width of the board, from the day header down to the last job bar. */
async function boardBox(board: Locator): Promise<Box> {
  const bb = (await board.boundingBox())!, ev = await union(board.locator('.b-sch-event'));
  return { x: bb.x, width: bb.width, y: ev.y - 66, height: ev.height + 76 };
}
/** Zoomed phone framing: the right column fills the right of the frame; a dark panel with the caption covers the rest. */
async function panel(page: Page, on: boolean, label = '') {
  await ensureOverlay(page);
  await page.evaluate(({ on, label }) => {
    const left = document.querySelector<HTMLElement>('.main > .left');
    const w = left ? left.getBoundingClientRect().right + 6 : 0;
    document.documentElement.style.setProperty('--rec-side-w', `${Math.max(0, w)}px`);
    document.getElementById('rec-side')!.textContent = label;
    document.documentElement.classList.toggle('rec-panel', on && w > 200);
  }, { on, label });
  await pause(page, 0.3);
}
const hold = (page: Page, what: string[], on: boolean) =>
  page.evaluate(({ what, on }) => what.forEach((w) => document.documentElement.classList.toggle(`rec-hold-${w}`, on)), { what, on });
/** Rewinds the cold open's CSS beats (they ran while the page loaded); with the holds on they wait at their first frame. */
const rewindStory = (page: Page) => page.evaluate(() => document.querySelectorAll<HTMLElement>('.story .meter i, .story .mail-toast, .story .hook')
  .forEach((el) => { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }));

let mouse = { x: W / 2, y: H / 2 };
async function moveTo(page: Page, loc: Locator) {
  let b = (await loc.boundingBox())!;
  const s = await camState(page), bottom = s > 1 && !(await page.evaluate(() => document.documentElement.classList.contains('rec-panel'))) ? H - CAP : H;
  if (b.y < 6 || b.y + b.height > bottom - 6 || b.x < 6 || b.x + b.width > W - 6) { // the camera follows the cursor
    await cam(page, loc, { keep: true, ms: 700, cap: H - bottom });
    await pause(page, 0.15);
    b = (await loc.boundingBox())!;
  }
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y, { steps: 18 });
  mouse = { x, y };
  await pause(page, 0.35);
}
async function clickOn(page: Page, loc: Locator) {
  await moveTo(page, loc);
  cue('click');
  await page.mouse.down(); await pause(page, 0.08); await page.mouse.up();
}
/** Smooth scroll (at the current zoom) so the element sits at the top / centre / bottom of the frame. */
async function scrollTo(page: Page, loc: Locator, block: 'start' | 'center' | 'end' = 'start', wait = 0.9, cap?: number) {
  const ms = Math.min(700, Math.max(300, wait * 1000 - 150));
  await cam(page, loc, { keep: true, block, ms, pad: block === 'center' ? 0 : 12, cap });
  await pause(page, Math.max(0, wait - ms / 1000));
}
async function scrollTop(page: Page) { await cam(page, null, { top: true, ms: 750 }); await pause(page, 0.15); }

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
  12: ['The owner can also drag any job on the board.', 'Code prices the move, Claude drafts the offer, and the customer still has to agree.'], // board-drag insert, shown after shot 9 (kept last: clip numbers stay stable)
} as const;
const skipped: string[] = [];

async function beginShot(page: Page, n: number) {
  await waitVoice();
  endSeg();
  shotNo = n;
  await tag(page, `DRAFT · shot ${n}`);
  startSeg(page);
  cue('shot', { shot: n });
}
/** A visible mouse glide (page.mouse.move with steps is too fast to follow on video). */
async function glide(page: Page, x1: number, y1: number, ms: number) {
  const n = Math.max(2, Math.round(ms / 20)), { x: x0, y: y0 } = mouse;
  for (let i = 1; i <= n; i++) {
    const k = i / n, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    await page.mouse.move(x0 + (x1 - x0) * e, y0 + (y1 - y0) * e);
    await page.waitForTimeout(20);
  }
  mouse = { x: x1, y: y1 };
}
/** The box of the text itself (a full-width paragraph would not zoom). */
const textBox = (loc: Locator): Promise<Box> => loc.evaluate((el) => {
  const r = document.createRange(); r.selectNodeContents(el);
  const b = r.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height };
});

const email = process.env.PAYPAL_SANDBOX_BUYER_EMAIL, password = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
if (PARTS.has('main') && STOP >= 7 && (!email || !password)) throw new Error('Needs PAYPAL_SANDBOX_BUYER_EMAIL / PAYPAL_SANDBOX_BUYER_PASSWORD (workspace .env)');

const browser = await chromium.launch();
const ctxOpts = { viewport: { width: W, height: H }, locale: 'en-GB', recordVideo: { dir: work, size: { width: W, height: H } } };
const PHONE = 1.8; // zoom on the customer phones (the dark side panel carries the caption)
let injectionAt = 0, dragAt = 0; // where the two inserts (recorded later, each in its own session) are spliced in

/** Replies on a customer's phone with one of the sample answers (the camera is already on the phones). */
async function answer(pg: Page, who: RegExp, chip: string, label: string) {
  const phone = pg.locator('.phone', { hasText: who });
  await cam(pg, phone.locator('.reply'), { max: PHONE, cap: 0, pad: 60, ms: 900 });
  await panel(pg, true, label);
  await clickOn(pg, phone.locator('.demo-helper summary'));
  await clickOn(pg, phone.getByRole('button', { name: chip }));
  await cam(pg, phone.locator('.reply'), { keep: true, cap: 0, ms: 500 });
  await pause(pg, 0.6);
  await clickOn(pg, phone.locator('.send-reply'));
  return phone;
}

async function mainTake() {
  const ctx = await browser.newContext(ctxOpts);
  const page = await newPage(ctx);
  const cfg = await (await page.request.get(`${base}/api/config`)).json();
  if (cfg.paypalMode !== 'sandbox') throw new Error(`PayPal mode is ${cfg.paypalMode}; start the app with PAYPAL_MODE=sandbox`);
  await page.goto(base);
  const board = page.locator('.bryntum-board');
  await board.locator('.b-sch-event').first().waitFor({ timeout: 30_000 });
  await page.mouse.move(W / 2, H / 2);
  const finish = async () => { await waitVoice(); await pause(page, 0.4); endSeg(); await ctx.close(); };

  // Shot 1 + 2: cold open. The story's own beats (bars fill, email slides in, hook) are held and released on the narration.
  await ensureOverlay(page);
  await hold(page, ['meter', 'mail', 'hook'], true);
  await page.getByRole('button', { name: 'Reset demo' }).click();
  await page.mouse.move(W - 3, 420, { steps: 5 }); // parked on the page margin: nothing to hover while the camera moves
  mouse = { x: W - 3, y: 420 };
  await pause(page, 0.6);
  await rewindStory(page);
  await pause(page, 0.4);
  const story = page.locator('.story');
  await beginShot(page, 1);
  await caption(page, VO[1][0]);
  await pause(page, 1.0);
  await cam(page, [story.locator('h1'), story.locator('.util')], { max: 1.75, pad: 34, ms: 1500 });
  await caption(page, VO[1][1]);
  await hold(page, ['meter'], false);
  await pause(page, 1.4);
  await caption(page, VO[1][2]);
  await cam(page, story.locator('.mail-toast'), { max: 1.85, pad: 44, ms: 1000 });
  await hold(page, ['mail'], false);
  await beginShot(page, 2);
  await caption(page, VO[2][0]);
  await pause(page, 1.2);
  await caption(page, VO[2][1]);
  await cam(page, await boardBox(board), { max: 1.42, pad: 18, ms: 1100 });
  await caption(page, VO[2][2]);
  await cam(page, await textBox(story.locator('.hook')), { max: 1.6, pad: 70, ms: 1100 });
  await hold(page, ['hook'], false);
  await caption(page, VO[2][3]);
  await pause(page, 0.5);
  await cam(page, null, { top: true, ms: 1300 });
  if (STOP < 3) return finish();

  // Shot 3: intake.
  await beginShot(page, 3);
  await caption(page, VO[3][0]);
  await clickOn(page, page.getByRole('button', { name: 'Open request' }));
  await pause(page, 1.0);
  await cam(page, page.locator('.intake-card'), { max: 1.55, pad: 22, ms: 900 });
  await clickOn(page, page.getByRole('button', { name: 'DE email', exact: true }));
  await pause(page, 1.3);
  await clickOn(page, page.getByRole('button', { name: 'Let Takt read it' }));
  await offCamera(page, () => page.locator('.extracted').waitFor({ timeout: 45_000 }));
  await pause(page, 0.3);
  await cam(page, page.locator('.extracted'), { max: 1.7, pad: 26, ms: 900 });
  await caption(page, VO[3][1]);
  await pause(page, 0.5);
  await highlight(page, page.locator('.extracted .kv', { hasText: 'Base price' }), 'rate card (code)', 3);
  await highlight(page, page.locator('.extracted .kv', { hasText: 'Extracted by' }), 'Claude Haiku 5.5 · recorded', 2);
  if (STOP < 4) return finish();

  // Shot 4: make room.
  await beginShot(page, 4);
  await caption(page, VO[4][0]);
  await clickOn(page, page.getByRole('button', { name: 'Make room' }));
  await offCamera(page, async () => {
    await page.waitForSelector('.step-card[data-step="make-room"][data-feasible="true"]', { timeout: 45_000 });
    await cam(page, null, { top: true, ms: 0 });
    await page.waitForTimeout(600);
  });
  await pause(page, 0.6);
  await cam(page, await boardBox(board), { max: 1.42, pad: 18, ms: 1000 });
  await highlight(page, board.locator('.takt-ev.ghost').first(), 'proposed slot', 2.2);
  await caption(page, VO[4][1]);
  await cam(page, page.locator('.why').first(), { max: 1.7, pad: 30, ms: 1000 });
  await highlight(page, page.locator('.why').first(), 'Why these customers (Claude)', 3.6);
  await caption(page, VO[4][2]);
  const total = page.locator('.flow .stats').first(); // rush price · compensation · net uplift tiles
  await cam(page, total, { max: 1.7, pad: 40, ms: 900 });
  await highlight(page, total, '', 2.2);
  if (STOP < 5) return finish();

  // Shot 5: offers + free-text answers (phones are embedded in the owner console).
  await cam(page, null, { ms: 800 });
  await stickLeft(page, 'log'); // the Claude/Code strip + agent log stay beside the phones
  await side(page, true);       // captions over the log, not over the right panel
  await beginShot(page, 5);
  await caption(page, VO[5][0]);
  await clickOn(page, page.getByRole('button', { name: /^Send \d offers?$/ }));
  await page.locator('.phone').first().waitFor();
  await pause(page, 0.7);
  await caption(page, VO[5][1]);
  const rochat = await answer(page, /Rochat/, 'Counter (FR)', 'Customer phone · Atelier Rochat');
  await offCamera(page, () => rochat.locator('.offer-done').waitFor({ timeout: 45_000 }));
  await cam(page, rochat.locator('.offer-done'), { keep: true, cap: 0, ms: 600, block: 'end', pad: 30 });
  await caption(page, VO[5][2]);
  await pause(page, 0.8);
  const showEn = rochat.getByRole('button', { name: 'Show English' }).last();
  if (await showEn.count()) { await clickOn(page, showEn); await pause(page, 1.4); }
  await caption(page, VO[5][3]);
  const meier = await answer(page, /Meier/, 'Yes (DE)', 'Customer phone · Studio Meier');
  await offCamera(page, () => page.locator('#approve-moves').waitFor({ timeout: 45_000 }));
  await cam(page, meier.locator('.offer-done'), { keep: true, cap: 0, ms: 600, block: 'end', pad: 30 });
  await pause(page, 0.8);
  await waitVoice();
  endSeg();
  injectionAt = segs.length; // the prompt-injection insert goes here; the cut hides the reset to the whole console
  voEnd = cutNow();
  await caption(page, '');
  await panel(page, false);
  await cam(page, null, { ms: 0 });
  if (STOP < 6) return finish();

  // Shot 6: owner approval.
  const approve = page.locator('#approve-moves');
  const agreed = page.getByRole('heading', { name: 'Everyone agreed. Your approval moves the money.' });
  await cam(page, agreed, { max: 1.5, block: 'start', ms: 0, pad: 36 });
  await page.waitForTimeout(400);
  await beginShot(page, 6);
  await caption(page, VO[6][0]);
  await highlight(page, agreed, '', 1.8);
  await caption(page, VO[6][1]);
  const checks = page.locator('.flow .checks').first();
  await cam(page, checks, { max: 1.6, pad: 34, ms: 1000 });
  await highlight(page, checks, '5 checks enforced by code', 3.4);
  await clickOn(page, approve);
  if (STOP < 7) return finish();

  // Shot 7: payout + rush checkout through the JS SDK v6 popup.
  await beginShot(page, 7);
  await caption(page, VO[7][0]);
  const payoutLine = page.getByText(/Payout to Studio Meier/).first();
  const payoutRow = payoutLine.locator('xpath=ancestor::li[1]');
  await offCamera(page, async () => {
    await payoutLine.waitFor({ timeout: 60_000 });
    await cam(page, payoutRow, { max: 1.5, pad: 60, ms: 0 });
    await page.waitForTimeout(500);
  });
  await caption(page, VO[7][1]);
  await highlight(page, payoutRow, 'PayPal Payout · CHF 45', 2.8);
  const sdkButton = page.locator('#paypal-sdk-button');
  const checkout = page.locator('.phone.checkout');
  await offCamera(page, async () => {
    await sdkButton.waitFor({ state: 'visible', timeout: 30_000 });
    await cam(page, [checkout.locator('.offer-card'), page.locator('.sdk-pay').first()], { max: PHONE, cap: 0, pad: 40, ms: 0 });
    await panel(page, true, 'Customer phone · the farmer pays');
    await page.waitForTimeout(1500);
  });
  await caption(page, VO[7][2]);
  await highlight(page, page.locator('.sdk-pay').first(), 'PayPal JS SDK v6', 2);
  await pause(page, 0.6);
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
  await popup.locator('#email').pressSequentially(email!, { delay: 25 });
  endSeg();
  const next = popup.locator('#btnNext');
  if (await next.isVisible()) await next.click();
  await popup.locator('#password').fill(password!);
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
  await panel(page, false);
  await cam(page, null, { ms: 0 });
  // Payout status (cut the wait): the batch settles a few seconds after approval (webhook / poll).
  const delivered = page.getByText(/Compensation delivered|PAYOUTS-ITEM\.SUCCEEDED/).first();
  if (await delivered.waitFor({ timeout: 60_000 }).then(() => true, () => false)) {
    const row = delivered.locator('xpath=ancestor::li[1]');
    await caption(page, VO[7][1]);
    await note(page, 'cut: payout settled later');
    await cam(page, row, { max: 1.5, pad: 60, ms: 0 });
    await page.waitForTimeout(400);
    startSeg(page);
    await highlight(page, row, 'Payout to Studio Meier · SUCCESS', 2.4);
    endSeg();
  } else skipped.push('shot 7: payout SUCCESS line did not appear within 60 s');

  // Shot 8: committed. (Shots 5-7 keep the log pinned on the left and the captions under it.)
  await side(page, false);
  await cam(page, null, { top: true, ms: 0 });
  await stickLeft(page, null);
  await page.mouse.move(5, 5); mouse = { x: 5, y: 5 };
  await note(page, '');
  await page.waitForTimeout(500);
  await beginShot(page, 8);
  await caption(page, VO[8][0]);
  await highlight(page, page.getByRole('heading', { name: 'PayPal confirmed. The rush is on the board.' }), '', 2);
  await cam(page, await boardBox(board), { max: 1.42, pad: 18, ms: 1000 });
  await highlight(page, await union(board.locator('.b-sch-event')), 'rush job placed, bumped jobs moved', 2.4);
  await caption(page, VO[8][1]);
  const tiles = page.locator('.net').first().locator('xpath=..');
  await cam(page, tiles, { max: 2.2, pad: 70, ms: 1100 });
  await highlight(page, tiles, 'net uplift', 3.2);
  await waitVoice();
  await cam(page, null, { top: true, ms: 900 });
  if (STOP < 9) return finish();

  // Shot 9: settle (capture less), timeline, live check, void.
  await stickLeft(page, 'board'); // board pinned beside the Settle panel: the shipped job turns striped and stays
  await beginShot(page, 9);
  await caption(page, VO[9][0]);
  const row = page.locator('.settle .offer-row', { hasText: 'J-2044' });
  const job = page.locator('.settle-job[data-job="J-2044"]');
  await scrollTo(page, page.locator('.step-head[data-step="settle"]'), 'center');
  await highlight(page, page.locator('.step-head[data-step="settle"]'), '', 1.4);
  await cam(page, row, { max: 1.6, pad: 50, ms: 900 });
  await clickOn(page, row.getByRole('button', { name: 'Ship' })); // the only amber Ship button (next job to ship)
  await offCamera(page, () => row.locator('.good').waitFor({ timeout: 30_000 }).catch(() => {}));
  await caption(page, VO[9][1]);
  await highlight(page, row, 'captured CHF 70 less', 2.4);
  await cam(page, null, { ms: 900 });
  await highlight(page, board.locator('.takt-ev.shipped').first(), '✓ shipped · stays on the board', 1.6, true);
  await caption(page, VO[9][2]);
  await clickOn(page, row.locator('xpath=..').locator('details.pp-box summary'));
  await clickOn(page, job.getByRole('button', { name: 'Check in PayPal' }));
  await offCamera(page, () => job.locator('.src-live-check').first().waitFor({ timeout: 30_000 }));
  await cam(page, job.locator('.pp-trail'), { max: 1.6, pad: 36, ms: 900 });
  await highlight(page, job.locator('.pp-trail'), 'PayPal timeline · live status', 2.4);
  const rushJob = page.locator('.settle-job', { hasText: '(rush)' });
  await clickOn(page, rushJob.getByRole('button', { name: 'Cancel rush (void)' }));
  await offCamera(page, () => rushJob.locator('.bad-text').waitFor({ timeout: 30_000 }));
  await cam(page, rushJob, { keep: true, ms: 600 });
  await highlight(page, rushJob, 'rush cancelled · authorization voided', 2);
  await waitVoice();
  endSeg();
  dragAt = segs.length; // the board-drag insert goes here
  voEnd = cutNow();
  await caption(page, '');
  if (STOP < 10) return finish();

  // Shot 10: the in-app strip (who did the last three beats), then the recap card.
  const strip = page.locator('.cc-strip');
  await cam(page, null, { ms: 0 });
  await stickLeft(page, null);
  await scrollTo(page, strip, 'center', 0.5);
  await page.mouse.move(5, 5);
  await cam(page, strip, { max: 1.38, pad: 40, ms: 0 });
  await page.waitForTimeout(400);
  await beginShot(page, 10);
  await caption(page, VO[10][0]);
  await highlight(page, strip, 'Claude reads & writes · Code does the numbers · Owner decides · PayPal moves money', 4.6);
  endSeg();
  // Shot 10 (card) + 11: own cards (rendered here, recording only).
  const CARD = (body: string) => `<!doctype html><html><head><style>
    body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#16233f;color:#fff;font-family:system-ui,Segoe UI,Roboto,sans-serif}
    .row{display:flex;align-items:stretch;gap:14px;margin-top:-40px}.box{background:#24365e;border:2px solid #4a6aa8;border-radius:18px;padding:30px 22px;width:244px;text-align:center}
    .box b{display:block;font-size:44px;margin-bottom:12px;color:#ffd75e}.box span{font-size:25px;line-height:1.36;color:#d9e2f5}.arrow{font-size:38px;color:#7f9bd6;align-self:center}
    .small{margin-top:46px;font-size:27px;max-width:1300px;text-align:center;color:#b6c4e3}.big{font-size:132px;font-weight:800;letter-spacing:1px;margin-top:-50px}.sub{font-size:44px;color:#ffd75e;margin-top:8px}
    .by{margin-top:48px;font-size:32px}.url{margin-top:14px;font-size:30px;color:#9fb7ea}</style></head><body>${body}</body></html>`;
  await page.setContent(CARD(`<div class="row">
    <div class="box"><b>Claude</b><span>reads &amp; writes: requests, whom to ask, offers, replies</span></div><div class="arrow">→</div>
    <div class="box"><b>Code</b><span>does the numbers: prices, plans, every limit</span></div><div class="arrow">→</div>
    <div class="box"><b>Owner</b><span>decides: approves every money move</span></div><div class="arrow">→</div>
    <div class="box"><b>PayPal</b><span>moves money: holds, captures less, pays out, voids</span></div></div>
    <div class="small">20/20 agent eval · 51 tests · PayPal sandbox, CHF · Bryntum Scheduler Pro</div>`));
  await page.mouse.move(-10, -10);
  await caption(page, VO[10][1]);
  startSeg(page);
  await pause(page, 1.0);
  await waitVoice();
  await page.setContent(CARD(`<div class="big">Takt</div><div class="sub">Airline bumping for factory schedules</div>
    <div class="by">Built by Francisco Del Barrio</div><div class="url">github.com/Frankkkyy/takt</div>`));
  await beginShot(page, 11);
  await caption(page, VO[11][0]);
  await waitVoice(); await pause(page, 1.6); // let the closing line breathe before the cut ends
  endSeg();
  await ctx.close();
}

// Injection insert (shot 5): its own fresh session. The recorded injection reply was made on the EN intake, so this
// take uses the EN sample; replying on Meier first would otherwise spoil the main take's recorded "Yes (DE)".
async function injectionTake() {
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
  await p2.waitForTimeout(800);
  const mphone = p2.locator('.phone', { hasText: /Meier/ });
  await stickLeft(p2, 'log');
  await side(p2, true);
  await cam(p2, mphone.locator('.reply'), { max: PHONE, cap: 0, pad: 60, ms: 0 });
  await mphone.locator('.demo-helper summary').click();
  await mphone.getByRole('button', { name: 'Injection' }).click();
  await cam(p2, mphone.locator('.reply'), { keep: true, cap: 0, ms: 0 });
  await panel(p2, true, 'Customer phone · Studio Meier');
  shotNo = 5;
  await tag(p2, 'DRAFT · shot 5 (insert)');
  await note(p2, 'Insert: prompt injection (another take)');
  const b = (await mphone.locator('.reply textarea').boundingBox())!;
  await p2.mouse.move(b.x + b.width / 2, b.y + b.height / 2); mouse = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const insStart = segs.length;
  startSeg(p2);
  await caption(p2, VO[5][4]);
  await pause(p2, 1.6);
  await clickOn(p2, mphone.locator('.send-reply'));
  const warn = mphone.locator('.callout.warn').or(p2.getByText('Agent escalated to the owner')).first();
  await offCamera(p2, () => warn.waitFor({ timeout: 45_000 }));
  await cam(p2, mphone.locator('.callout.warn').first(), { keep: true, cap: 0, ms: 600 });
  await highlight(p2, mphone.locator('.callout.warn').first(), 'escalated to the owner · nothing paid', 2.4);
  await waitVoice(); await pause(p2, 0.3);
  endSeg();
  await ctx2.close();
  return segs.splice(insStart);
}

// Board-drag insert (after shot 9): a fresh session again, so the week is the untouched Friday board.
async function dragTake() {
  const ctx3 = await browser.newContext(ctxOpts);
  const p3 = await newPage(ctx3);
  await p3.goto(base);
  const board = p3.locator('.bryntum-board');
  await board.locator('.b-sch-event').first().waitFor({ timeout: 30_000 });
  await p3.getByRole('button', { name: 'Reset demo' }).click();
  await ensureOverlay(p3);
  // The cold-open banner is not part of this beat. One column = the board fills the frame, so the dragged bar is big
  // without a camera zoom (a CSS transform or zoom on an ancestor breaks Bryntum's drag maths).
  await p3.evaluate(() => document.documentElement.classList.add('rec-nostory', 'rec-tips', 'rec-onecol'));
  await p3.waitForTimeout(2000);
  const ev = board.locator('.b-sch-event', { hasText: 'J-2044 · bend' });
  await ev.scrollIntoViewIfNeeded();
  const b = (await ev.boundingBox())!, bb = (await board.boundingBox())!, fe = (await board.locator('.b-sch-event').first().boundingBox())!;
  const day = (bb.x + bb.width - fe.x) / 5; // five working days across the board
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await p3.mouse.move(x + 260, y - 150); mouse = { x: x + 260, y: y - 150 };
  shotNo = 9;
  await tag(p3, 'DRAFT · shot 9 (insert)');
  await note(p3, 'Insert: board drag (another take)');
  const insStart = segs.length;
  voEnd = cutNow(); // the injection insert was spliced out of `segs`, so the clock stepped back
  startSeg(p3);
  cue('shot', { shot: 9 });
  await caption(p3, VO[12][0]);
  await highlight(p3, ev, 'booked job · promised Tuesday', 1.1);
  await glide(p3, x, y, 700);
  await pause(p3, 0.3);
  cue('click');
  await p3.mouse.down(); await pause(p3, 0.2);
  await glide(p3, x + day * 2, y, 1300);
  await pause(p3, 0.5);
  await p3.mouse.up();
  await pause(p3, 0.3);
  await waitVoice();
  const review = p3.locator('.move-review');
  await offCamera(p3, async () => {
    await p3.locator('.move-card .why').waitFor({ timeout: 45_000 });
    // Back to the normal two columns, already framed on Takt's review: at this zoom the board is the size it had during the drag.
    await p3.evaluate(() => document.documentElement.classList.remove('rec-onecol', 'rec-tips'));
    await p3.mouse.move(W - 3, 420); mouse = { x: W - 3, y: 420 };
    await p3.waitForTimeout(1500);
    await cam(p3, review, { max: 1.42, pad: 24, ms: 0, block: 'start' });
    await side(p3, true);
  });
  await caption(p3, VO[12][1]);
  await pause(p3, 0.4);
  await highlight(p3, review, 'code: dates, other promises, caps', 2.2);
  await cam(p3, p3.locator('.move-card .why'), { max: 1.6, pad: 50, ms: 1100, block: 'start' });
  await pause(p3, 0.9);
  await waitVoice(); await pause(p3, 0.5);
  endSeg();
  await ctx3.close();
  return segs.splice(insStart);
}

if (PARTS.has('main')) await mainTake();
const ins5 = PARTS.has('inject') && STOP >= 5 ? await injectionTake() : [];
const ins9 = PARTS.has('drag') && STOP >= 9 ? await dragTake() : [];
segs.splice(dragAt, 0, ...ins9); // later index first: the earlier splice would shift it
segs.splice(injectionAt, 0, ...ins5);
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
// Cue sheet for audio/mix.py: absolute times in the final cut (after the insert splice).
{
  const startById = new Map<number, number>(); let acc = 0;
  for (const s of segs) { startById.set(s.id, acc); acc += s.end - s.start; }
  const ids = [...startById.keys()].sort((a, b) => a - b);
  const at = (c: Cue) => startById.has(c.segId) ? startById.get(c.segId)! + c.offset : startById.get(ids.find((i) => i > c.segId) ?? ids[ids.length - 1])!;
  const sheet = cues.map((c) => ({ kind: c.kind, text: c.text, shot: c.shot, at: +at(c).toFixed(3) })).sort((a, b) => a.at - b.at);
  writeFileSync(out.replace(/\.mp4$/, '') + '.cues.json', JSON.stringify({ duration: +acc.toFixed(3), cues: sheet }, null, 1));
}
const probe = (() => { try { execFileSync(ff, ['-i', out], { stdio: 'pipe' }); return ''; } catch (e) { return String((e as { stderr?: Buffer }).stderr ?? ''); } })();
const dur = /Duration: ([\d:.]+)/.exec(probe)?.[1];

console.log(`\nShot lengths (visible seconds):`);
let cum = 0;
for (let n = 1; n <= 11; n++) {
  const v = segs.filter((s) => s.shot === n).reduce((a, s) => a + s.end - s.start, 0);
  console.log(`  ${String(n).padStart(2)}  ${fmt(cum)}  ${v.toFixed(1)} s`);
  cum += v;
}
function fmt(s: number) { return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
if (skipped.length) console.log(`Skipped: ${skipped.join('; ')}`);
console.log(`\n${out}\nduration ${dur} (${segs.length} segments)`);
if (process.env.KEEP_CLIPS === '1') cpSync(work, path.join(path.dirname(out), 'clips'), { recursive: true });
rmSync(work, { recursive: true, force: true });
