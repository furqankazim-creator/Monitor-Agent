import { assertTargetAllowed } from './ssrf.js';
import { renderAvailable } from './render.js';

let pw = undefined;
async function loadPlaywright() {
  if (pw !== undefined) return pw;
  try { pw = await import('playwright'); } catch { pw = null; }
  return pw;
}
// True only when the Playwright package AND its browser are really installed.
export const playwrightAvailable = async () => renderAvailable();

const fill = (s, secret) => String(s ?? '').replace(/\{\{(\w+)\}\}/g, (_, k) => (secret && secret[k] != null ? secret[k] : ''));

/**
 * Runs a declarative workflow: [{action:'goto'|'fill'|'click'|'expectText'|'expectUrl'|'waitFor', selector, value, url, text}]
 * Credentials come from the encrypted secret (e.g. {{username}} / {{password}}). Use dedicated test accounts only.
 */
export async function runWorkflow(asset, secret) {
  const lib = await loadPlaywright();
  if (!lib) return { state: 'unavailable', error: 'Playwright is not installed (npm i playwright && npx playwright install chromium)' };
  const steps = asset.config.steps || []; if (!steps.length) return { state: 'unavailable', error: 'No workflow steps configured' };
  const t0 = performance.now(); const browser = await lib.chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: 'TimeGlobalTechMonitor-Synthetic/1.0' });
    const page = await ctx.newPage(); page.setDefaultTimeout(Math.min(asset.timeout_ms, 30000));
    await page.route('**/*', async (route) => { // SSRF guard for every browser request
      try { await assertTargetAllowed(route.request().url()); await route.continue(); } catch { await route.abort('blockedbyclient'); }
    });
    let i = 0;
    for (const s of steps) {
      i++;
      try {
        if (s.action === 'goto') { const u = new URL(fill(s.url, secret), asset.target).href; await assertTargetAllowed(u); await page.goto(u, { waitUntil: 'load' }); }
        else if (s.action === 'fill') await page.fill(s.selector, fill(s.value, secret));
        else if (s.action === 'click') await page.click(s.selector);
        else if (s.action === 'waitFor') await page.waitForSelector(s.selector);
        else if (s.action === 'expectText') { const t = fill(s.text, secret); await page.waitForFunction((x) => document.body.innerText.includes(x), t); }
        else if (s.action === 'expectUrl') { if (!page.url().includes(s.value)) throw new Error(`URL ${page.url()} does not contain ${s.value}`); }
        else throw new Error(`unknown action ${s.action}`);
      } catch (e) { return { state: 'fail', responseMs: Math.round(performance.now() - t0), error: `Workflow failed at step ${i} (${s.action}${s.selector ? ' ' + s.selector : ''}): ${String(e.message).split('\n')[0].slice(0, 160)}`, detail: { failed_step: i } }; }
    }
    return { state: 'ok', responseMs: Math.round(performance.now() - t0), detail: { steps: steps.length } };
  } finally { await browser.close().catch(() => {}); }
}
