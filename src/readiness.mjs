import { CaptureError } from './errors.mjs';
import { inScope } from './url.mjs';

export function checkResponse(response) {
  if (!response) throw new CaptureError('NO_RESPONSE', 'Navigation did not return a document response.');
  const status = response.status();
  if (status === 401 || status === 403) throw new CaptureError(`HTTP_${status}`, 'Access is required or denied.', 'blocked');
  if (status === 429) {
    const headers = typeof response.headers === 'function' ? response.headers() : {};
    const raw = headers['retry-after'];
    const seconds = Number(raw);
    const parsedDate = raw && !Number.isFinite(seconds) ? Date.parse(raw) : NaN;
    const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) :
      Number.isFinite(parsedDate) ? Math.max(0, parsedDate - Date.now()) : undefined;
    throw new CaptureError('HTTP_429', 'The server requested a slower request rate.', 'limited', { retryAfterMs });
  }
  if (status >= 400) throw new CaptureError(`HTTP_${status}`, `Server returned HTTP ${status}.`);
}

async function visibleSelector(page, selectors) {
  for (const selector of selectors) {
    if (await page.locator(`:is(${selector}):visible`).count()) return true;
  }
  return false;
}

export async function accessState(page, config) {
  if (await visibleSelector(page, config.access.challengeSelectors)) return 'challenge';
  if (await visibleSelector(page, config.access.loginSelectors)) return 'login';
  if (await visibleSelector(page, config.access.deniedSelectors)) return 'denied';
  const marker = page.locator('h1:visible, [role="alert"]:visible').filter({
    hasText: /(?:access denied|unauthorized|authentication failed|authentication required|sign in|log in|verify you are human|complete the security check|captcha)/i
  });
  if (await marker.count()) {
    const text = marker.first ? (await marker.first().innerText().catch(() => '')).toLowerCase() : '';
    return /verify you are human|security check|captcha/.test(text) ? 'challenge' : 'denied';
  }
  return null;
}

async function executionBoundary(runtime) {
  if (runtime.controller && !await runtime.controller.boundary(runtime.checkpoint)) {
    throw new CaptureError('CAPTURE_CANCELLED', 'Capture was cancelled at a safe readiness boundary.', 'cancelled');
  }
  if (runtime.deadline && Date.now() >= runtime.deadline) {
    throw new CaptureError('EXPLORATION_TIME_LIMIT', 'Capture readiness reached its configured time limit.', 'limited');
  }
}

export async function checkContent(page, config, runtime = {}) {
  if (!inScope(page.url(), config.startUrl, config.scopePath)) throw new CaptureError('OUT_OF_SCOPE', 'Navigation left the configured scope.', 'blocked');
  const access = await accessState(page, config);
  if (access === 'login') throw new CaptureError('LOGIN_REQUIRED', 'A visible login form needs manual resolution.', 'blocked');
  if (access === 'challenge') throw new CaptureError('ACCESS_CHALLENGE', 'A supported security challenge needs manual resolution.', 'blocked');
  if (access === 'denied') throw new CaptureError('ACCESS_SCREEN', 'An access-denied or authentication screen was detected.', 'blocked');
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    await executionBoundary(runtime);
    const slice = Math.min(150, deadline - Date.now(), runtime.deadline ? runtime.deadline - Date.now() : Infinity);
    if (slice <= 0) await executionBoundary(runtime);
    try {
      await page.locator(config.readinessSelector).first().waitFor({ state: 'visible', timeout: slice });
      await page.waitForFunction(selector => {
        const el = document.querySelector(selector);
        return !!el && ((el.textContent ?? '').trim().length > 0 || !!el.querySelector('img,svg,canvas,video'));
      }, config.readinessSelector, { timeout: slice });
      return;
    } catch (error) {
      if (error?.name !== 'TimeoutError' && error?.message !== 'timeout') {
        throw new CaptureError('CONTENT_NOT_READY', 'Expected visible content did not become ready within the timeout.');
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
  await executionBoundary(runtime);
  throw new CaptureError('CONTENT_NOT_READY', 'Expected visible content did not become ready within the timeout.');
}

export async function resourceWarnings(page, timeoutMs) {
  return page.evaluate(async timeout => {
    const images = [...document.images];
    for (const img of images) img.loading = 'eager';
    let timedOut = false;
    let timer;
    const cleanup = [];
    const imageWaits = images.map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
      const done = () => { img.removeEventListener('load', done); img.removeEventListener('error', done); resolve(); };
      cleanup.push(done);
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }));
    await Promise.race([
      Promise.all([...imageWaits, document.fonts?.ready ?? Promise.resolve()]),
      new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeout); })
    ]);
    clearTimeout(timer);
    cleanup.forEach(done => done());
    const broken = images.filter(img => img.complete && img.naturalWidth === 0).length;
    const pending = images.filter(img => !img.complete).length;
    return [
      ...(timedOut ? [{ code: 'RESOURCE_TIMEOUT', message: 'Images or fonts did not settle before the deadline.' }] : []),
      ...(broken ? [{ code: 'BROKEN_IMAGES', message: `${broken} image(s) failed to load.` }] : []),
      ...(pending ? [{ code: 'PENDING_IMAGES', message: `${pending} image(s) remain pending.` }] : [])
    ];
  }, timeoutMs);
}
