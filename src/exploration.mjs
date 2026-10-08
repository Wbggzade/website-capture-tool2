import path from 'node:path';
import { inspectPage, fingerprint } from './discovery.mjs';
import { navigatePage } from './capture.mjs';
import { captureSnapshot, waitForStableContent } from './scroll.mjs';
import { CaptureError, isRetryableFailure, normalizeOperationError, publicError } from './errors.mjs';
import { checkContent } from './readiness.mjs';

export const controlKey = control => fingerprint(`${control.selector}|${control.kind}|${control.label}`);

export function actionFor(control, config) {
  if (control.status === 'excluded' || control.inForm || control.disabled) return { status: 'excluded', reason: 'excluded-disabled-or-form-control' };
  if (control.kind === 'disclosure') return control.open ? { status: 'observed', reason: 'already-open' } : { action: 'open-details' };
  if (['tab', 'expandable'].includes(control.kind)) {
    if (!control.panelId || !control.panelExists) return { status: 'unclassified', reason: 'missing-associated-panel' };
    if (control.selected === 'true' || control.expanded === 'true') return { status: 'observed', reason: 'already-visible' };
    return { action: control.kind === 'tab' ? 'select-tab' : 'expand' };
  }
  if (control.kind === 'pagination' && config.exploration.paginationSelectors.includes(control.selector)) return { action: 'paginate' };
  return { status: 'unclassified', reason: control.kind === 'pagination' ? 'pagination-needs-explicit-selector' : 'unknown-behavior' };
}

export function combineInspections(inspections, config) {
  const links = new Map();
  const controls = new Map();
  for (const inspection of inspections) {
    for (const link of inspection.links ?? []) links.set(`${link.href}|${!!link.download}`, link);
    for (const control of inspection.controls ?? []) controls.set(controlKey(control), control);
  }
  return { links: [...links.values()].slice(0, config.discovery.maxLinksPerPage),
    controls: [...controls.values()].slice(0, config.discovery.maxControlsPerPage),
    totals: { links: links.size, controls: controls.size },
    truncatedLinks: links.size > config.discovery.maxLinksPerPage || inspections.some(item => item.truncatedLinks),
    truncatedControls: controls.size > config.discovery.maxControlsPerPage || inspections.some(item => item.truncatedControls) };
}

async function visibleStateFingerprint(page) {
  const state = await page.evaluate(() => ({
    url: location.href,
    text: document.body?.innerText?.slice(0, 50000) ?? '',
    controls: [...document.querySelectorAll('button,[role="button"],[role="tab"],summary,[aria-expanded]')]
      .filter(el => el.getClientRects().length > 0)
      .map(el => [el.localName, el.id, el.getAttribute('aria-selected'), el.getAttribute('aria-expanded'),
        el.localName === 'summary' ? el.parentElement.open : null, el.innerText?.trim().slice(0, 160) ?? ''])
  }));
  return fingerprint(JSON.stringify(state));
}

async function ensureBoundary(runtime = {}) {
  if (runtime.controller && !await runtime.controller.boundary(runtime.checkpoint)) {
    throw new CaptureError('CAPTURE_CANCELLED', 'State exploration was cancelled at a safe boundary.', 'cancelled');
  }
  if (runtime.deadline && Date.now() >= runtime.deadline) {
    throw new CaptureError('EXPLORATION_TIME_LIMIT', 'State exploration reached its configured time limit.', 'limited');
  }
}

async function applyAction(page, planned, config, runtime = {}) {
  await ensureBoundary(runtime);
  const inspection = await inspectPage(page, config);
  const current = inspection.controls.find(control => controlKey(control) === controlKey(planned));
  if (!current) throw new CaptureError('CONTROL_CHANGED', 'The planned control no longer matches the visible page.');
  const decision = actionFor(current, config);
  if (decision.status === 'observed') return;
  if (!decision.action || decision.action !== planned.action) throw new CaptureError('CONTROL_NOT_ALLOWED', 'The control no longer satisfies the interaction rules.', 'blocked');
  const locator = page.locator(current.selector);
  if (await locator.count() !== 1) throw new CaptureError('AMBIGUOUS_CONTROL', 'The control selector is not unique.');
  const previousUrl = page.url();
  const before = await page.locator('body').innerText();
  await ensureBoundary(runtime);
  if (decision.action === 'open-details') {
    // Use the native disclosure property, avoiding arbitrary summary click handlers.
    await locator.evaluate(el => { if (el.localName !== 'summary' || el.parentElement.localName !== 'details') throw Error('changed'); el.parentElement.open = true; });
  } else await locator.click({ timeout: config.timeoutMs, noWaitAfter: true });
  const settled = await waitForStableContent(page, config, runtime);
  await ensureBoundary(runtime);
  if (page.url() !== previousUrl) throw new CaptureError('UNEXPECTED_NAVIGATION', 'A content control navigated away; state exploration stopped.', 'blocked');
  await checkContent(page, config, runtime);
  if (!settled) throw new CaptureError('STATE_NOT_STABLE', 'The revealed state did not settle.');
  if (current.panelId) {
    try { await page.locator(`[id=${JSON.stringify(current.panelId)}]`).waitFor({ state: 'visible', timeout: config.timeoutMs }); }
    catch { throw new CaptureError('PANEL_NOT_VISIBLE', 'The associated content panel was not revealed.'); }
    const attr = current.kind === 'tab' ? 'aria-selected' : 'aria-expanded';
    if (await locator.getAttribute(attr) !== 'true') throw new CaptureError('STATE_NOT_CONFIRMED', 'The control did not confirm the expected selected/expanded state.');
  }
  if (decision.action === 'paginate' && before === await page.locator('body').innerText()) throw new CaptureError('NO_NEW_CONTENT', 'Pagination revealed no new text content.');
}

export async function exploreContent(page, target, initialInspection, screenshotPath, config, deadline, runtime = {}) {
  const states = [];
  const records = new Map();
  const jobs = [];
  const inspections = [initialInspection];
  const initialFingerprint = await visibleStateFingerprint(page);
  const stateFingerprints = new Set([initialFingerprint]);
  const stateIdsByPath = new Map();
  const warnings = [];
  const register = (inspection, ancestry) => {
    for (const control of inspection.controls) {
      const key = controlKey(control);
      if (records.has(key)) continue;
      if (records.size >= config.discovery.maxControlsPerPage) { warnings.push({ code: 'CONTROL_LIMIT', message: 'New controls exceeded the per-page inventory limit.' }); break; }
      const decision = actionFor(control, config);
      const record = { ...control, id: key, status: decision.status ?? 'deferred', reason: decision.reason ?? 'pending-exploration' };
      records.set(key, record);
      if (decision.action) {
        if (ancestry.length >= config.exploration.maxStateDepth) record.reason = 'state-depth-limit';
        else jobs.push({ key, actions: [...ancestry, { ...control, action: decision.action }] });
      }
    }
  };
  register(initialInspection, []);
  let unsafeRequest = false;
  let popupOpened = false;
  let halted = false;
  let cancelled = false;
  const protect = async route => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) { unsafeRequest = true; await route.abort(); }
    else await route.fallback();
  };
  const popup = async opened => { popupOpened = true; await opened.close().catch(() => {}); };
  await page.route('**/*', protect);
  page.on('popup', popup);
  try {
    let cursor = 0;
    while (cursor < jobs.length && states.length < config.exploration.maxStates && Date.now() < deadline) {
      try { await ensureBoundary({ ...runtime, deadline }); }
      catch (error) {
        if (error instanceof CaptureError && error.code === 'CAPTURE_CANCELLED') { cancelled = true; break; }
        throw error;
      }
      const job = jobs[cursor++];
      const record = records.get(job.key);
      const pathKey = actions => actions.map(action => `${controlKey(action)}:${action.action}`).join('>');
      const actions = job.actions.map(({ selector, label, action }) => ({ selector, label, action }));
      const parentStateId = job.actions.length > 1 ? stateIdsByPath.get(pathKey(job.actions.slice(0, -1))) ?? null : null;
      const state = { index: states.length + 1, controlId: job.key, parentStateId, actions };
      try {
        unsafeRequest = false;
        popupOpened = false;
        await runtime.onActionPath?.(state.actions);
        await navigatePage(page, target, config, { ...runtime, deadline });
        if (unsafeRequest || popupOpened) throw new CaptureError('UNEXPECTED_SIDE_EFFECT', 'Page replay attempted a non-read request or opened another window.', 'blocked');
        // Replay ancestors so nested content states retain an explicit reproducible path.
        for (const action of job.actions) {
          if (Date.now() >= deadline) throw new CaptureError('EXPLORATION_TIME_LIMIT', 'State replay reached the exploration deadline.');
          await ensureBoundary({ ...runtime, deadline });
          await applyAction(page, action, config, { ...runtime, deadline });
          if (unsafeRequest || popupOpened) throw new CaptureError('UNEXPECTED_SIDE_EFFECT', 'A content interaction attempted a non-read request or opened another window.', 'blocked');
        }
        const signature = await visibleStateFingerprint(page);
        if (stateFingerprints.has(signature)) {
          state.status = 'skipped';
          state.reason = 'duplicate-visible-state';
          record.status = 'observed';
          record.reason = 'duplicate-visible-state';
          states.push(state);
          stateIdsByPath.set(pathKey(job.actions), state.index);
          await runtime.onStateProgress?.({ actions: state.actions, status: state.status });
          continue;
        }
        stateFingerprints.add(signature);
        const filename = screenshotPath.replace(/\.png$/i, `-state-${String(state.index).padStart(3, '0')}.png`);
        const { observations, ...capture } = await captureSnapshot(page, filename, config, deadline, { ...runtime, deadline });
        if (unsafeRequest || popupOpened) throw new CaptureError('UNEXPECTED_SIDE_EFFECT', 'Unexpected activity occurred during state capture.', 'blocked');
        Object.assign(state, capture, { screenshot: `screenshots/${path.basename(filename)}` });
        const inspection = combineInspections([...observations, await inspectPage(page, config)], config);
        inspections.push(inspection);
        await runtime.onDiscoveryObservation?.({ links: inspection.links, batchKey: `${runtime.batchPrefix ?? 0}:state:${fingerprint(pathKey(job.actions))}` });
        record.status = capture.status;
        record.reason = 'state-captured';
        stateIdsByPath.set(pathKey(job.actions), state.index);
        register(inspection, job.actions);
        // Explicitly authorized load-more buttons can be replayed repeatedly, bounded by maxStates.
        const last = job.actions.at(-1);
        const remaining = inspection.controls.find(control => controlKey(control) === job.key);
        if (last.action === 'paginate' && remaining && !remaining.disabled) {
          record.status = 'deferred'; record.reason = 'more-pagination-content';
          jobs.push({ key: job.key, actions: [...job.actions, last] });
        }
        await runtime.onStateProgress?.({ actions: state.actions, screenshot: state.screenshot, status: state.status });
      } catch (error) {
        const normalized = normalizeOperationError(error);
        if (isRetryableFailure(normalized.code)) throw normalized;
        const failure = publicError(normalized);
        Object.assign(state, { status: failure.status, error: { code: failure.code, message: failure.message } });
        record.status = failure.status;
        record.reason = failure.code;
        if (failure.code === 'CAPTURE_CANCELLED') {
          cancelled = true;
          record.status = 'partial';
          record.reason = 'cancelled-during-exploration';
          states.push(state);
          break;
        }
        if (failure.status === 'limited') {
          halted = true;
          states.push(state);
          break;
        }
        if (failure.status === 'blocked') { halted = true; states.push(state); break; }
      }
      states.push(state);
    }
    for (const record of records.values()) if (record.status === 'deferred' && record.reason === 'pending-exploration') record.reason = halted ? 'exploration-blocked' : cancelled ? 'cancelled-during-exploration' : Date.now() >= deadline ? 'exploration-time-limit' : 'state-count-limit';
    return { states, controls: [...records.values()], inspection: combineInspections(inspections, config), warnings, cancelled };
  } finally {
    page.off('popup', popup);
    await page.unroute('**/*', protect);
  }
}
