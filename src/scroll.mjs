import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { CaptureError } from './errors.mjs';
import { resourceWarnings, checkContent } from './readiness.mjs';
import { inspectPage } from './discovery.mjs';

const warning = (code, message) => ({ code, message });

async function checkBoundary(runtime = {}) {
  if (runtime.controller && !await runtime.controller.boundary(runtime.checkpoint)) {
    throw new CaptureError('CAPTURE_CANCELLED', 'Capture was cancelled at a safe exploration boundary.', 'cancelled');
  }
  if (runtime.deadline && Date.now() >= runtime.deadline) {
    throw new CaptureError('EXPLORATION_TIME_LIMIT', 'Capture exploration reached its configured time limit.', 'limited');
  }
}

export async function waitForStableContent(page, config, runtime = {}) {
  const { settleTimeoutMs, settleIntervalMs } = config.exploration;
  const deadline = Math.min(Date.now() + settleTimeoutMs, runtime.deadline ?? Infinity);
  let previous = '';
  let stable = 0;
  while (Date.now() < deadline) {
    await checkBoundary(runtime);
    const current = await page.evaluate(() => `${document.documentElement.scrollHeight}:${document.body?.innerText?.slice(0, 50000)}`);
    stable = current === previous ? stable + 1 : 0;
    if (stable >= 2) return true;
    previous = current;
    await page.waitForTimeout(settleIntervalMs);
  }
  return false;
}

async function saveImage(page, filename, config, options = {}) {
  await page.screenshot({ path: filename, animations: 'disabled', timeout: config.timeoutMs, ...options });
  const metadata = await sharp(filename).metadata();
  if (!metadata.width || !metadata.height || !(await fs.stat(filename)).size) throw new CaptureError('SCREENSHOT_FAILED', 'Screenshot output could not be verified.');
  return { file: path.basename(filename), width: metadata.width, height: metadata.height };
}

// Preserve viewport frames while scrolling, including virtual rows later removed.
export async function captureSnapshot(page, screenshotPath, config, deadline = Date.now() + config.exploration.maxDurationMs, runtime = {}) {
  runtime = { ...runtime, deadline: runtime.deadline ?? deadline };
  const warnings = [];
  const observations = [];
  const artifacts = [];
  const root = screenshotPath.replace(/\.png$/i, '');
  const observe = async batchKey => {
    if (!config.discovery.enabled) return;
    const inspection = await inspectPage(page, config);
    observations.push(inspection);
    await runtime.onDiscoveryObservation?.({ links: inspection.links, batchKey: `${runtime.batchPrefix ?? 0}:${batchKey}` });
  };
  if (!config.exploration.enabled) {
    await checkBoundary(runtime);
    warnings.push(...await resourceWarnings(page, config.imageTimeoutMs));
    await checkBoundary(runtime);
    await checkContent(page, config, runtime);
    const main = await saveImage(page, screenshotPath, config, { fullPage: true });
    await runtime.onCaptureProgress?.({ ...main, kind: 'document', order: 1 });
    return { status: warnings.length ? 'partial' : 'captured', warnings, ...main, artifacts: [{ ...main, kind: 'document', order: 1 }], observations };
  }
  const limit = code => { if (!warnings.some(item => item.code === code)) warnings.push(warning(code, 'Capture exploration reached a configured limit; output is incomplete.')); };
  if (!await waitForStableContent(page, config, runtime)) warnings.push(warning('UNSTABLE_CONTENT', 'Content did not settle before the deadline.'));
  const regionArray = await page.evaluateHandle(max => [...document.querySelectorAll('body *')].filter(el => {
    const style = getComputedStyle(el);
    return el.getClientRects().length > 0 && el.clientHeight > 40 && el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(style.overflowY);
  }).slice(0, max + 1), config.exploration.maxScrollRegions);
  const handles = [...(await regionArray.getProperties()).values()];
  const regions = handles.map(handle => handle.asElement()).filter(Boolean);
  try {
    if (regions.length > config.exploration.maxScrollRegions) limit('SCROLL_REGION_LIMIT');
    for (const [regionIndex, region] of [null, ...regions.slice(0, config.exploration.maxScrollRegions)].entries()) {
      await checkBoundary(runtime);
      if (Date.now() >= deadline) { limit('EXPLORATION_TIME_LIMIT'); break; }
      if (region) {
        await region.scrollIntoViewIfNeeded({ timeout: config.timeoutMs });
        await region.evaluate(el => { el.scrollTop = 0; });
      } else await page.evaluate(() => window.scrollTo(0, 0));
      let finished = false;
      for (let step = 0; step < config.exploration.maxScrollSteps; step++) {
        await checkBoundary(runtime);
        if (Date.now() >= deadline) { limit('EXPLORATION_TIME_LIMIT'); break; }
        if (!await waitForStableContent(page, config, runtime)) warnings.push(warning('UNSTABLE_CONTENT', 'Content changed throughout the scroll settling window.'));
        warnings.push(...await resourceWarnings(page, config.imageTimeoutMs));
        await checkBoundary(runtime);
        await checkContent(page, config, runtime);
        await observe(`scroll:${regionIndex}:${step + 1}`);
        const metrics = region
          ? await region.evaluate(el => el.isConnected ? ({ top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight }) : null)
          : await page.evaluate(() => ({ top: window.scrollY, height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), viewport: window.innerHeight }));
        if (!metrics) throw new CaptureError('SCROLL_REGION_REMOVED', 'A scroll region was removed during capture.');
        if (region || metrics.height > metrics.viewport + 2) {
          await checkBoundary(runtime);
          const filename = `${root}-region-${regionIndex}-step-${String(step + 1).padStart(3, '0')}.png`;
          const image = await saveImage(page, filename, config, { fullPage: false });
          const artifact = { ...image, kind: region ? 'scroll-region' : 'scroll-step', region: regionIndex, step: step + 1, scrollTop: metrics.top, scrollHeight: metrics.height, order: artifacts.length + 1 };
          artifacts.push(artifact);
          await runtime.onCaptureProgress?.(artifact);
        }
        if (metrics.top + metrics.viewport >= metrics.height - 2) { finished = true; break; }
        const next = Math.min(metrics.top + Math.max(1, Math.floor(metrics.viewport * 0.75)), metrics.height - metrics.viewport);
        if (region) await region.evaluate((el, top) => { el.scrollTop = top; }, next);
        else await page.evaluate(top => window.scrollTo(0, top), next);
      }
      if (!finished) limit('SCROLL_STEP_LIMIT');
      if (region) await region.evaluate(el => { el.scrollTop = 0; });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await waitForStableContent(page, config, runtime);
    await checkBoundary(runtime);
    await checkContent(page, config, runtime);
    const height = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    const fullPage = height <= config.exploration.maxFullPageHeight;
    const primary = await saveImage(page, screenshotPath, config, { fullPage });
    await runtime.onCaptureProgress?.({ ...primary, kind: fullPage ? 'document' : 'overview', order: 0 });
    if (!fullPage) warnings.push(warning('SEGMENTED_CAPTURE', 'Page exceeds the full-image height threshold; ordered viewport segments accompany the overview.'));
    const incomplete = warnings.some(item => item.code !== 'SEGMENTED_CAPTURE');
    return { status: incomplete ? 'partial' : 'captured', warnings: [...new Map(warnings.map(item => [item.code, item])).values()],
      width: primary.width, height: primary.height, artifacts: [{ ...primary, kind: fullPage ? 'document' : 'overview', order: 0 }, ...artifacts], observations };
  } catch (error) {
    if (artifacts.length) {
      // Preserve already-verified evidence rather than discard the entire page.
      await fs.copyFile(path.join(path.dirname(screenshotPath), artifacts[0].file), screenshotPath);
      const meta = await sharp(screenshotPath).metadata();
      const failure = error instanceof CaptureError ? error : new CaptureError('CAPTURE_EXPLORATION_FAILED', 'Scrolling stopped unexpectedly; preceding evidence was preserved.');
      return { status: 'partial', width: meta.width, height: meta.height,
        warnings: [...warnings, warning(failure.code, failure.message)],
        ...(failure.status === 'blocked' ? { accessRequired: failure.code } : {}),
        artifacts: [{ file: path.basename(screenshotPath), width: meta.width, height: meta.height, kind: 'recovered-overview', order: 0 }, ...artifacts], observations };
    }
    if (error instanceof CaptureError) throw error;
    throw new CaptureError('CAPTURE_EXPLORATION_FAILED', 'Scrolling or screenshot capture failed.');
  } finally {
    await Promise.all(handles.map(handle => handle.dispose().catch(() => {})));
    await regionArray.dispose().catch(() => {});
  }
}
