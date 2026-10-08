import { chromium } from 'playwright';
import { CaptureError } from './errors.mjs';

export async function openBrowser(config) {
  if (config.browser.mode === 'attach') {
    const browser = await chromium.connectOverCDP(config.browser.endpoint, { timeout: config.timeoutMs });
    const context = browser.contexts()[0];
    if (!context) { await browser.close(); throw new CaptureError('NO_BROWSER_CONTEXT', 'Attached browser has no usable context.'); }
    return { context, close: () => browser.close() }; // Disconnects this attachment; does not launch or own the browser.
  }
  const browser = await chromium.launch({ headless: config.browser.headless, channel: config.browser.channel });
  try {
    const context = await browser.newContext({ viewport: config.viewport, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light' });
    return { context, close: () => browser.close() };
  } catch (error) { await browser.close(); throw error; }
}
