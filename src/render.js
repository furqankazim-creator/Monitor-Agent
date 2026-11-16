import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from './config.js';
import { assertTargetAllowed } from './ssrf.js';
import { log } from './util.js';

// "Does the page actually DISPLAY?" - opens the page in a real browser like a visitor and looks at what is on screen.
// An HTTP 200 only proves the server answered; a broken JavaScript app can still show a completely blank page.
const require = createRequire(import.meta.url);
const SCREEN_DIR = path.join(config.dataDir, 'screens');
try { fs.mkdirSync(SCREEN_DIR, { recursive: true }); } catch {}
export const screenshotFile = (assetId) => path.join(SCREEN_DIR, `asset-${assetId}.jpg`);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 TimeGlobalTechMonitor/1.0';

let avail = null; let pwLib = null;
/** True only when the Playwright package AND its browser are really installed (not just the package). */
export function renderAvailable() {
  if (avail !== null) return avail;
  try { pwLib = require('playwright'); avail = fs.existsSync(pwLib.chromium.executablePath()); } catch { avail = false; }
  return avail;
}

let browser = null; let launching = null; let idleTimer = null; let active = 0; const waiters = [];
export async function closeBrowser() {
  clearTimeout(idleTimer);
  if (helper) { try { await helper.close(); } catch {} helper = null; helperBrowser = null; }
  if (browser) { try { await browser.close(); } catch {} browser = null; }
}
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (!launching) launching = pwLib.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] }).then((b) => { browser = b; b.on('disconnected', () => { browser = null; }); return b; }).finally(() => { launching = null; });
  return launching;
}
async function slot(fn) { // at most 2 browser pages at once so many sites never overload the machine
  if (active >= 2) await new Promise((r) => waiters.push(r));
  active++; clearTimeout(idleTimer);
  try { return await fn(); } finally {
    active--; waiters.shift()?.();
    if (!active) idleTimer = setTimeout(() => { browser?.close().catch(() => {}); browser = null; }, 120000).unref(); // free the memory when idle
  }
}

const ERROR_PAGE = /Application error: a client-side exception|Unhandled Runtime Error|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|Error establishing a database connection|This site can.t be reached|502 Bad Gateway|503 Service|There has been a critical error/i;
let helper = null; let helperBrowser = null;
/** How many pixels of a screenshot differ from its dominant colour? A page that paints nothing (white screen, hidden text only) has ~0. */
async function paintedPixels(buf) {
  const b = await getBrowser(); if (!helper || helperBrowser !== b || helper.isClosed()) { helper = await b.newPage(); helperBrowser = b; }
  return helper.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data; const counts = new Map();
    for (let i = 0; i < d.length; i += 16) { const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3); counts.set(k, (counts.get(k) || 0) + 1); }
    let top = 0; let topK = 0; for (const [k, v] of counts) if (v > top) { top = v; topK = k; }
    const tr = (topK >> 10) << 3; const tg = ((topK >> 5) & 31) << 3; const tb = (topK & 31) << 3; let distinct = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - tr) > 20 || Math.abs(d[i + 1] - tg) > 20 || Math.abs(d[i + 2] - tb) > 20) distinct++;
    return { distinct, total: d.length / 4 };
  }, buf.toString('base64')).catch(() => ({ distinct: 1e9, total: 1e9 })); // if analysis fails, never claim "blank"
}
const BLANK_PIXELS = 80; // fewer painted pixels than this = nothing visible on screen
const hostOk = new Map(); // host -> expiry: the SSRF policy is evaluated once per host, not once per request
async function hostAllowed(u) { const e = hostOk.get(u.host); if (e && e > Date.now()) return; await assertTargetAllowed(u.href); hostOk.set(u.host, Date.now() + 10 * 60000); }
const short = (s, n = 110) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

export async function renderCheck(asset) {
  if (!renderAvailable()) return { state: 'unavailable', error: 'Real-browser checks need the Playwright browser: run "npm install" then "npx playwright install chromium".' };
  return slot(async () => {
    const t0 = Date.now(); const jsErrors = []; const consoleErrors = []; const failed = []; const bad = [];
    const ctx = await (await getBrowser()).newContext({ viewport: { width: 1366, height: 800 }, userAgent: UA });
    try {
      const page = await ctx.newPage();
      page.on('pageerror', (e) => jsErrors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('requestfailed', (r) => { const why = r.failure()?.errorText || ''; if (r.resourceType() !== 'media' && !/ERR_ABORTED/.test(why)) failed.push(`${r.url()} (${why})`); });
      page.on('response', (r) => { if (r.status() >= 400 && r.request().resourceType() !== 'media') bad.push(`HTTP ${r.status()} ${r.url()}`); });
      await page.route('**/*', async (route) => { // same SSRF policy as every other check; skip heavy video
        const req = route.request(); if (req.resourceType() === 'media') return route.abort();
        try { const u = new URL(req.url()); if (!['http:', 'https:'].includes(u.protocol)) return route.continue(); await hostAllowed(u); await route.continue(); } catch { await route.abort('blockedbyclient'); }
      });
      let navError = null; let contentType = '';
      try { const resp = await page.goto(asset.target, { waitUntil: 'commit', timeout: 30000 }); contentType = String(resp?.headers()['content-type'] || ''); }
      catch (e) { navError = short(e.message.split('\n')[0], 140); }
      if (!navError && contentType && !/html/i.test(contentType)) return { state: 'ok', detail: { ms: Date.now() - t0, skipped: `not an HTML page (${contentType.split(';')[0]})`, shot: false } }; // JSON / plain text has nothing to render
      const measure = () => page.evaluate(() => {
        const text = (document.body?.innerText || '').trim();
        const media = [...document.querySelectorAll('img,video,canvas,svg,iframe')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 20; }).length;
        return { textLen: text.length, sample: text.replace(/\s+/g, ' ').slice(0, 160), elements: document.querySelectorAll('body *').length, scripts: document.scripts.length, media, title: document.title };
      }).catch(() => ({ textLen: 0, sample: '', elements: 0, scripts: 0, media: 0, title: '' })); // page still navigating: count as "nothing yet" and look again
      // Heavy single-page apps need seconds to draw (YouTube ~10 s). Judge only after something is really painted, or the wait budget is used up.
      let m = { textLen: 0, sample: '', elements: 0, scripts: 0, media: 0, title: '' }; let painted = { distinct: 0, total: 1 }; let shot = false; let buf = null;
      const grab = async () => { try { buf = await page.screenshot({ type: 'jpeg', quality: 55 }); painted = await paintedPixels(buf); } catch { buf = null; painted = { distinct: 1e9, total: 1e9 }; } };
      if (!navError) {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        const deadline = Date.now() + config.renderWaitMs;
        for (;;) {
          m = await measure();
          if (m.textLen >= 15 || m.media > 0) { await grab(); if (painted.distinct >= BLANK_PIXELS) break; } // content exists AND something is painted
          if (Date.now() >= deadline) break; await page.waitForTimeout(500);
        }
        if (painted.distinct >= BLANK_PIXELS) { await page.waitForTimeout(600); m = await measure(); await grab(); } // let an error overlay replace the content, if it is going to
        else if (!buf) await grab();
      } else await grab();
      if (buf) { try { fs.writeFileSync(screenshotFile(asset.id), buf); shot = true; } catch { /* disk issue: skip screenshot */ } }
      // why? plain-language clues
      const cors = consoleErrors.find((c) => /blocked by CORS policy/i.test(c)); const corsUrl = cors?.match(/Access to fetch at '([^']+)'/)?.[1] || cors?.match(/Access to XMLHttpRequest at '([^']+)'/)?.[1];
      const clues = []; if (jsErrors[0]) clues.push(`JavaScript error: ${short(jsErrors[0], 120)}`);
      if (cors) clues.push(`a data request was blocked by CORS${corsUrl ? ' (' + short(corsUrl, 90) + ')' : ''}`); else if (failed[0]) clues.push(`a request failed: ${short(failed[0], 110)}`);
      if (bad[0]) clues.push(short(bad[0], 110));
      const detail = { ms: Date.now() - t0, textLen: m.textLen, elements: m.elements, media: m.media, painted_pixels: painted.distinct, js_errors: jsErrors.length, failed_requests: failed.length + bad.length, title: m.title, shot };
      const why = clues.length ? ` Clues: ${clues.slice(0, 3).join('; ')}.` : '';
      if (navError) return { state: 'fail', error: `The page could not be opened in a browser: ${navError}.`, detail };
      // blank = nothing at all, or a near-empty page that also shows signs of failure (scripts that crashed / requests that failed). A deliberately tiny static page is fine.
      const failureSigns = jsErrors.length > 0 || failed.length > 0 || bad.length > 0 || m.scripts > 0;
      if (m.media === 0 && (m.textLen === 0 || (m.textLen < 15 && failureSigns))) return { state: 'fail', error: `The page loads (HTTP 200) but nothing is displayed: the screen is blank.${why}`, detail };
      if (painted.distinct < BLANK_PIXELS) return { state: 'fail', error: `The page loads (HTTP 200) but nothing is displayed: the screen is blank${m.textLen ? ' (the page contains only invisible text)' : ''}.${why}`, detail }; // visually uniform = a visitor sees nothing
      if (m.textLen < 600 && ERROR_PAGE.test(m.sample)) return { state: 'fail', error: `The page shows an error message instead of the site: "${short(m.sample, 90)}".${why}`, detail };
      return { state: 'ok', detail };
    } finally { await ctx.close().catch(() => {}); }
  }).catch((e) => { log('warn', 'render check crashed', { asset: asset.id, error: e.message }); return { state: 'unavailable', error: `Browser check could not run: ${short(e.message.split('\n')[0], 120)}` }; });
}
