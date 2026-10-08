import { checkContent, checkResponse } from './readiness.mjs';
import { CaptureError } from './errors.mjs';
import { captureSnapshot } from './scroll.mjs';

export async function navigatePage(page, target, config, runtime = {}) {
  const previousUrl = page.url();
  let response;
  try { response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs }); }
  catch { throw new CaptureError('NAVIGATION_FAILED', 'Navigation failed or exceeded its timeout.'); }
  // Hash-router navigation can succeed without a new document/network response.
  const before = new URL(previousUrl);
  const expected = new URL(target);
  const sameDocument = before.origin === expected.origin && before.pathname === expected.pathname && before.search === expected.search;
  if (response || !sameDocument || page.url() !== expected.href) checkResponse(response);
  await checkContent(page, config, runtime);
}

export async function capturePage(page, target, screenshotPath, config, runtime = {}) {
  await navigatePage(page, target, config, runtime);
  return captureSnapshot(page, screenshotPath, config, runtime.deadline, runtime);
}
