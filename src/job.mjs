import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { CaptureError, isRetryableFailure, normalizeOperationError, publicError } from './errors.mjs';
import { displayUrl, inScope } from './url.mjs';
import { DiscoveryQueue, inspectPage as defaultInspectPage, fingerprint } from './discovery.mjs';
import { combineInspections, exploreContent as defaultExploreContent } from './exploration.mjs';
import { accessState, checkContent } from './readiness.mjs';
import { atomicWrite, configFingerprint, readCheckpoint, writeCheckpoint } from './checkpoint.mjs';

export function summarize(results, exportError = null) {
  const counts = { captured: 0, partial: 0, failed: 0, blocked: 0, skipped: 0, limited: 0 };
  for (const item of results) if (item.status in counts) counts[item.status]++;
  const complete = results.length > 0 && counts.captured + counts.skipped === results.length && !exportError;
  return { status: complete ? 'complete' : 'incomplete', counts, exitCode: complete ? 0 : 1 };
}

const resumableAccessCodes = new Set(['LOGIN_REQUIRED', 'ACCESS_CHALLENGE', 'ACCESS_SCREEN', 'HTTP_401', 'HTTP_403']);
function retryDelay(config, attempt, error) {
  const exponential = Math.min(config.retry.baseDelayMs * (2 ** Math.max(0, attempt - 1)), config.retry.maxDelayMs);
  if (error.retryAfterMs !== undefined && error.retryAfterMs > config.retry.maxDelayMs) return null;
  return Math.max(exponential, error.retryAfterMs ?? 0);
}

async function waitDelay(ms, controller, onWaiting) {
  let remaining = ms;
  while (remaining > 0) {
    if (controller && !await controller.boundary(onWaiting)) return false;
    const interval = Math.min(remaining, 100);
    await new Promise(resolve => setTimeout(resolve, interval));
    remaining -= interval;
  }
  return !controller?.cancelRequested;
}

function absoluteArtifact(runDir, reference) {
  if (typeof reference !== 'string' || path.isAbsolute(reference)) return null;
  const resolved = path.resolve(runDir, reference);
  return resolved.startsWith(`${path.resolve(runDir)}${path.sep}`) ? resolved : null;
}

async function verifyPng(runDir, reference) {
  const filename = absoluteArtifact(runDir, reference);
  if (!filename) return false;
  try {
    const metadata = await sharp(filename).metadata();
    return Boolean(metadata.width && metadata.height && (await fs.stat(filename)).size);
  } catch {
    return false;
  }
}

async function verifyResultArtifacts(runDir, result) {
  if (!result.screenshot || !await verifyPng(runDir, result.screenshot)) return false;
  for (const artifact of result.artifacts ?? []) {
    const reference = artifact.file?.includes('/') || artifact.file?.includes('\\')
      ? artifact.file : path.join('screenshots', artifact.file ?? '');
    if (!await verifyPng(runDir, reference)) return false;
  }
  for (const state of result.states ?? []) {
    if (state.screenshot && !await verifyPng(runDir, state.screenshot)) return false;
    for (const artifact of state.artifacts ?? []) {
      const reference = artifact.file?.includes('/') || artifact.file?.includes('\\')
        ? artifact.file : path.join('screenshots', artifact.file ?? '');
      if (!await verifyPng(runDir, reference)) return false;
    }
  }
  return true;
}

export async function runJob(config, dependencies, options = {}) {
  const { openBrowser, capturePage, buildPdf, inspectPage = defaultInspectPage,
    exploreContent = defaultExploreContent, now = Date.now, onResult = () => {} } = dependencies;
  const { controller = null, onEvent = () => {}, resumeState = null, resumeFrom = null } = options;
  const runDir = resumeFrom ?? path.join(config.outputDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(path.join(runDir, 'screenshots'), { recursive: true });
  const queue = resumeState ? DiscoveryQueue.restore(config, resumeState.queue) : new DiscoveryQueue(config);
  const results = resumeState ? resumeState.results.map(result => ({ ...result })) : [];
  const attemptHistory = new Map(resumeState?.attemptHistory ?? []);
  const events = (resumeState?.events ?? []).slice(-1000);
  const pages = new Set();
  let inFlight = resumeState?.inFlight ?? null;
  let exportError = null;
  let fatalError = null;
  let pdf = resumeState?.pdf ?? null;
  let session;
  let page;
  let scopeBlocked = false;
  let lifecycle = 'running';
  let stoppedByLimit = false;
  const started = now();

  const emit = (type, details = {}) => {
    const event = { id: (events.at(-1)?.id ?? 0) + 1, timestamp: new Date().toISOString(), type, ...details };
    events.push(event);
    if (events.length > 1000) events.shift();
    onEvent(event);
  };
  const setLifecycle = state => {
    lifecycle = state;
    if (!controller && state !== 'running') emit('lifecycle-changed', { lifecycle: state });
  };
  const subscribe = controller?.subscribe(event => {
    const safe = { id: (events.at(-1)?.id ?? 0) + 1, timestamp: event.timestamp, type: event.type, lifecycle: event.lifecycle,
      ...(event.reason ? { reason: event.reason } : {}), ...(event.targetId ? { targetId: event.targetId } : {}) };
    events.push(safe);
    if (events.length > 1000) events.shift();
    onEvent(safe);
  });
  const save = async () => {
    const unexploredControls = results.flatMap(item => item.controls ?? [])
      .filter(control => ['deferred', 'unclassified', 'failed', 'blocked', 'partial'].includes(control.status)).length;
    const pending = queue.items.filter(item => item.status === 'pending' || item.status === 'running').length;
    const summary = summarize(results, exportError || fatalError);
    const attempts = [...attemptHistory.values()].flat().filter(entry => entry.type === 'attempt').length;
    const attemptedItems = [...attemptHistory.values()].filter(history => history.some(entry => entry.type === 'attempt')).length;
    const report = { version: 4, stage: 4, lifecycle: controller?.getState() ?? lifecycle,
      scope: { origin: new URL(config.startUrl).origin, path: config.scopePath },
      discovered: queue.items.length, planned: queue.items.length, attempted: attemptedItems, attemptCount: attempts,
      pending, limited: summary.counts.limited, limitCount: queue.limits.size, results, graph: queue.report(), unexploredControls,
      stateCounts: results.flatMap(item => item.states ?? []).reduce((counts, state) => {
        counts[state.status] = (counts[state.status] ?? 0) + 1;
        return counts;
      }, {}),
      discoveryEnabled: config.discovery.enabled, ...summary, pdf, exportError, fatalError,
      limits: [...queue.limits], events: events.slice(-1000) };
    if (pending || queue.limits.size || unexploredControls) { report.status = 'incomplete'; report.exitCode = 1; }
    if (report.lifecycle === 'paused' || report.lifecycle === 'waiting-for-user-action' || report.lifecycle === 'cancelling') {
      report.status = report.lifecycle;
      report.exitCode = 1;
    }
    if (report.lifecycle === 'cancelled') { report.status = 'cancelled'; report.exitCode = 1; }
    const checkpoint = { configFingerprint: configFingerprint(config), privateConfig: config, queue: queue.snapshot(), results, inFlight,
      attemptHistory: [...attemptHistory], events: events.slice(-1000), lifecycle: report.lifecycle, pdf, exportError, fatalError };
    await writeCheckpoint(runDir, checkpoint);
    await atomicWrite(path.join(runDir, 'manifest.json'), JSON.stringify(report, null, 2));
    return report;
  };

  if (resumeState) {
    for (const result of [...results]) {
      const item = queue.items.find(candidate => candidate.id === result.index);
      if (item?.status === 'blocked' && resumableAccessCodes.has(result.error?.code) && controller) {
        item.status = 'pending';
        results.splice(results.indexOf(result), 1);
        emit('access-resume-requested', { targetId: result.index });
        continue;
      }
      const cancelledExploration = result.status === 'partial' &&
        (result.warnings ?? []).some(warning => ['CAPTURE_CANCELLED', 'STATE_EXPLORATION_CANCELLED'].includes(warning.code));
      if (cancelledExploration) {
        if (item) item.status = 'pending';
        const history = attemptHistory.get(result.index) ?? [];
        history.push({ type: 'exploration-resume', timestamp: new Date().toISOString(),
          actionPaths: (result.states ?? []).map(state => state.actions ?? []) });
        attemptHistory.set(result.index, history);
        results.splice(results.indexOf(result), 1);
        emit('cancelled-exploration-requeued', { targetId: result.index });
        continue;
      }
      if (!['captured', 'partial'].includes(result.status)) continue;
      if (await verifyResultArtifacts(runDir, result)) continue;
      const history = attemptHistory.get(result.index) ?? [];
      history.push({ type: 'artifact-invalidated', code: 'ARTIFACT_MISSING_OR_CORRUPT', timestamp: new Date().toISOString() });
      attemptHistory.set(result.index, history);
      if (item) item.status = 'pending';
      results.splice(results.indexOf(result), 1);
      emit('artifact-invalidated', { targetId: result.index });
    }
    for (const item of queue.items) if (item.status === 'running') {
      item.status = 'pending';
      const history = attemptHistory.get(item.id) ?? [];
      history.push({ type: 'attempt-interrupted', code: 'PROCESS_INTERRUPTED', timestamp: new Date().toISOString(),
        ...(resumeState.inFlight?.targetId === item.id ? {
          actionPath: resumeState.inFlight.actionPath ?? [], evidencePaths: resumeState.inFlight.evidencePaths ?? []
        } : {}) });
      attemptHistory.set(item.id, history);
      emit('attempt-interrupted', { targetId: item.id });
    }
  }

  const registerPage = async () => {
    const captureTab = await session.context.newPage();
    pages.add(captureTab);
    await captureTab.setViewportSize(config.viewport);
    await captureTab.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === captureTab.mainFrame() && !inScope(request.url(), config.startUrl, config.scopePath)) {
        scopeBlocked = true;
        await route.abort();
      } else await route.continue();
    });
    return captureTab;
  };

  await save();
  if (controller && !await controller.boundary(save)) {
    lifecycle = 'cancelled';
    controller.finish('cancelled');
    subscribe?.();
    return { runDir, report: await save() };
  }
  try {
    session = await openBrowser(config);
    page = await registerPage();
    while (queue.hasNext()) {
      if (controller && !await controller.boundary(save)) { lifecycle = 'cancelled'; break; }
      if (controller) lifecycle = controller.getState();
      if (now() - started >= config.discovery.maxDurationMs) {
        queue.limits.add('max-duration');
        stoppedByLimit = true;
        emit('limit-reached', { code: 'max-duration' });
        break;
      }
      const item = queue.next();
      if (!item) break;
      const index = item.id;
      const target = item.key;
      let finalResult = null;
      emit('page-started', { targetId: index });
      await save();

      if (queue.aliases.has(target)) {
        item.status = 'skipped';
        finalResult = { index, url: displayUrl(target), urlId: fingerprint(target), parentId: item.parentId, depth: item.depth,
          status: 'skipped', reason: 'already-captured-redirect-target', targetId: queue.aliases.get(target), attempts: attemptHistory.get(index) ?? [] };
      } else {
        let attempt = (attemptHistory.get(index) ?? []).filter(entry => entry.type === 'attempt').length;
        if (attempt >= config.retry.maxAttempts) {
          item.status = 'failed';
          finalResult = { index, url: displayUrl(target), urlId: fingerprint(target), parentId: item.parentId, depth: item.depth,
            status: 'failed', error: { code: 'RETRY_EXHAUSTED', message: 'The interrupted item used its configured attempt budget before the process stopped.' },
            attempts: (attemptHistory.get(index) ?? []).map(entry => ({ ...entry })) };
        }
        while (attempt < config.retry.maxAttempts) {
          attempt++;
          const screenshotName = `screenshots/${String(index).padStart(4, '0')}${attempt === 1 ? '' : `-attempt-${String(attempt).padStart(2, '0')}`}.png`;
          const history = attemptHistory.get(index) ?? [];
          const attemptRecord = { type: 'attempt', number: attempt, status: 'running', timestamp: new Date().toISOString() };
          history.push(attemptRecord);
          attemptHistory.set(index, history);
          inFlight = { targetId: index, attempt, phase: 'capture', actionPath: [], statePaths: [], evidencePaths: [] };
          emit('attempt-started', { targetId: index, attempt });
          await save();
          scopeBlocked = false;
          let partialEvidence = null;
          try {
            const deadline = Date.now() + config.exploration.maxDurationMs;
            const runtime = { controller, deadline, batchPrefix: attempt, checkpoint: save,
              onActionPath: async actions => {
                inFlight = { ...inFlight, phase: 'state-replay', actionPath: actions };
                emit('state-replay-progress', { targetId: index, actionDepth: actions.length });
                await save();
              },
              onStateProgress: async state => { inFlight = { ...inFlight, statePaths: [...inFlight.statePaths, state], actionPath: [] }; await save(); },
              onCaptureProgress: async artifact => {
                inFlight = { ...inFlight, phase: 'capture-evidence', evidencePaths: [...inFlight.evidencePaths, artifact] };
                emit('capture-evidence', { targetId: index, kind: artifact.kind, order: artifact.order,
                  ...(artifact.region !== undefined ? { region: artifact.region } : {}),
                  ...(artifact.step !== undefined ? { step: artifact.step } : {}) });
                await save();
              },
              onDiscoveryObservation: async ({ links, batchKey }) => {
                queue.observe(item, links, page.url(), batchKey);
                await save();
              } };
            const { observations = [], accessRequired, ...capture } = await capturePage(page, target, path.join(runDir, screenshotName), config, runtime);
            partialEvidence = { ...capture, screenshot: screenshotName };
            if (accessRequired) throw new CaptureError(accessRequired, 'A manual access challenge interrupted scrolling.', 'blocked');
            let result = { index, url: displayUrl(target), urlId: fingerprint(target), parentId: item.parentId, depth: item.depth,
              ...capture, screenshot: screenshotName };
            if (config.discovery.enabled) {
              try {
                const actualUrl = page.url();
                if (!inScope(actualUrl, config.startUrl, config.scopePath)) throw new CaptureError('OUT_OF_SCOPE', 'Navigation left the configured scope.', 'blocked');
                if (actualUrl !== target) queue.aliases.set(actualUrl, item.id);
                result.finalUrl = displayUrl(actualUrl);
                result.finalUrlId = fingerprint(actualUrl);
                let inspection = combineInspections([...observations, await inspectPage(page, config)], config);
                if (config.exploration.enabled && !controller?.cancelRequested) {
                  const explored = await exploreContent(page, target, inspection, path.join(runDir, screenshotName), config, deadline, runtime);
                  const accessFailure = explored.states.find(state => state.status === 'blocked' && resumableAccessCodes.has(state.error?.code));
                  if (accessFailure) throw new CaptureError(accessFailure.error.code, 'Manual access resolution is required.', 'blocked');
                  inspection = explored.inspection;
                  result.states = explored.states.map(state => ({ ...state, parentPageId: item.id }));
                  result.controls = explored.controls.map((control, offset) => ({ ...control, parentId: item.id, order: offset + 1 }));
                  result.warnings = [...(result.warnings ?? []), ...explored.warnings];
                  if (explored.states.some(state => state.status !== 'captured') || explored.warnings.length) result.status = 'partial';
                  if (explored.cancelled) result.warnings = [...(result.warnings ?? []), { code: 'STATE_EXPLORATION_CANCELLED', message: 'State replay stopped at a safe boundary; resume will replay this item from its recorded action path.' }];
                }
                result.controls ??= inspection.controls.map((control, offset) => ({ ...control, id: `${item.id}-state-${offset + 1}`, parentId: item.id, order: offset + 1 }));
                result.discoveryTotals = inspection.totals;
                if (inspection.truncatedLinks) queue.limits.add('max-links-per-page');
                if (inspection.truncatedControls) queue.limits.add('max-controls-per-page');
                queue.observe(item, inspection.links, actualUrl, `final:${attempt}`);
                if (controller?.cancelRequested) {
                  result.status = 'partial';
                  result.warnings = [...(result.warnings ?? []), { code: 'STATE_EXPLORATION_CANCELLED', message: 'Further state exploration was cancelled; verified captures and observed links were preserved.' }];
                }
              } catch (error) {
                const failure = normalizeOperationError(error);
                if (resumableAccessCodes.has(failure.code)) throw failure;
                if (isRetryableFailure(failure.code)) throw failure;
                result.status = 'partial';
                result.warnings = [...(result.warnings ?? []), { code: 'DISCOVERY_FAILED', message: 'Capture evidence was saved, but discovery or state exploration could not be completed.' }];
              }
            } else if (controller?.cancelRequested) {
              result.status = 'partial';
              result.warnings = [...(result.warnings ?? []), { code: 'CAPTURE_CANCELLED', message: 'Capture completed at a safe boundary; resume can recapture this item.' }];
            }
            attemptRecord.status = result.status;
            attemptRecord.finishedAt = new Date().toISOString();
            result.attempts = history.map(entry => ({ ...entry }));
            finalResult = result;
            item.status = result.status;
            break;
          } catch (rawError) {
            const failure = publicError(scopeBlocked ? new CaptureError('OUT_OF_SCOPE', 'Navigation was blocked because it left the configured scope.', 'blocked') : normalizeOperationError(rawError));
            attemptRecord.status = failure.status;
            attemptRecord.code = failure.code;
            attemptRecord.finishedAt = new Date().toISOString();
            emit('attempt-failed', { targetId: index, attempt, code: failure.code, category: failure.status });

            if (resumableAccessCodes.has(failure.code) && controller) {
              inFlight = { ...inFlight, phase: 'waiting-for-user-action', actionPath: inFlight.actionPath ?? [],
                ...(partialEvidence ? { partialEvidence } : {}) };
              while (!controller.cancelRequested) {
                if (!await controller.waitForUserAction(failure.code, index, save)) break;
                try {
                  if (!inScope(page.url(), config.startUrl, config.scopePath)) throw new CaptureError('OUT_OF_SCOPE', 'Manual resolution left the configured scope.', 'blocked');
                  await accessState(page, config);
                  await checkContent(page, config);
                  emit('access-verified', { targetId: index });
                  inFlight = { ...inFlight, phase: 'retry-after-access-verified', partialEvidence: undefined };
                  break;
                } catch {
                  emit('access-still-required', { targetId: index, code: failure.code });
                }
              }
              if (!controller.cancelRequested && controller.getState() === 'running') continue;
              lifecycle = 'cancelled';
              break;
            }

            if (failure.code === 'CAPTURE_CANCELLED' && controller?.cancelRequested) {
              item.status = 'pending';
              lifecycle = 'cancelled';
              break;
            }

            if (failure.code === 'HTTP_429' && failure.retryAfterMs > config.retry.maxDelayMs) {
              item.status = 'limited';
              finalResult = { index, url: displayUrl(target), urlId: fingerprint(target), parentId: item.parentId, depth: item.depth,
                status: 'limited', reason: 'retry-after-exceeds-configured-backoff', error: failure, attempts: history.map(entry => ({ ...entry })) };
              queue.limits.add('rate-limited');
              break;
            }
            if (!isRetryableFailure(failure.code) || attempt >= config.retry.maxAttempts) {
              item.status = failure.status === 'limited' ? 'limited' : failure.status;
              finalResult = { index, url: displayUrl(target), urlId: fingerprint(target), parentId: item.parentId, depth: item.depth,
                ...(partialEvidence ?? {}), status: item.status,
                error: { code: failure.code, message: failure.message, ...(failure.retryAfterMs ? { retryAfterMs: failure.retryAfterMs } : {}) },
                attempts: history.map(entry => ({ ...entry })) };
              if (item.status === 'limited') queue.limits.add('rate-limited');
              break;
            }
            const delayMs = retryDelay(config, attempt, failure);
            if (delayMs === null) {
              item.status = 'limited';
              finalResult = { index, url: displayUrl(target), urlId: fingerprint(target), parentId: item.parentId, depth: item.depth,
                status: 'limited', reason: 'retry-after-exceeds-configured-backoff', error: failure, attempts: history.map(entry => ({ ...entry })) };
              queue.limits.add('rate-limited');
              break;
            }
            attemptRecord.retryDelayMs = delayMs;
            emit('retry-scheduled', { targetId: index, attempt, delayMs, code: failure.code });
            await save();
            if (!await waitDelay(delayMs, controller, save)) { lifecycle = 'cancelled'; break; }
            if (failure.code === 'BROWSER_CRASHED') {
              try { await session.close(); }
              catch { emit('browser-cleanup-warning', { code: 'BROWSER_CLOSE_AFTER_CRASH_FAILED' }); }
              session = await openBrowser(config);
              page = await registerPage();
              emit('browser-reconnected', { targetId: index });
            }
          }
        }
        if (!finalResult && lifecycle === 'cancelled') {
          item.status = 'pending';
          break;
        }
      }

      if (!finalResult) break;
      if (!finalResult.attempts) finalResult.attempts = (attemptHistory.get(index) ?? []).map(entry => ({ ...entry }));
      results.push(finalResult);
      item.status = finalResult.status;
      inFlight = null;
      await save();
      onResult(finalResult);
      emit('page-finished', { targetId: index, status: finalResult.status });
      if (controller?.cancelRequested) { lifecycle = 'cancelled'; break; }
    }

    if (queue.hasNext() && !controller?.cancelRequested && !stoppedByLimit && now() - started >= config.discovery.maxDurationMs) {
      queue.limits.add('max-duration');
      stoppedByLimit = true;
    }
    if (controller && !controller.cancelRequested && !await controller.boundary(save)) lifecycle = 'cancelled';
    else if (controller) lifecycle = controller.getState();
    if (!controller?.cancelRequested && !stoppedByLimit && config.buildPdf && (results.length || resumeState?.pdf)) {
      emit('export-started');
      try { pdf = await buildPdf(runDir, results); }
      catch { exportError = { code: 'PDF_FAILED', message: 'PDF export failed; individual captures remain available.' }; }
      if (exportError) emit('export-failed', { code: exportError.code });
      else emit('export-finished');
    }
  } catch (error) {
    fatalError = publicError(error instanceof CaptureError ? error : new CaptureError('JOB_FAILED', 'Job setup or execution failed.'));
    emit('job-failed', { code: fatalError.code });
  } finally {
    for (const captureTab of pages) {
      try { if (typeof captureTab.isClosed !== 'function' || !captureTab.isClosed()) await captureTab.close(); }
      catch { fatalError ??= { code: 'CLEANUP_FAILED', message: 'Capture tab could not be closed.' }; }
    }
    try { if (session) await session.close(); }
    catch { fatalError ??= { code: 'CLEANUP_FAILED', message: 'Browser connection could not be closed.' }; }
    subscribe?.();
  }

  const cancelled = lifecycle === 'cancelled' || controller?.cancelRequested;
  lifecycle = cancelled ? 'cancelled' : fatalError || exportError || queue.limits.size || queue.items.some(item => item.status !== 'captured' && item.status !== 'skipped') ||
    results.some(result => result.status !== 'captured' && result.status !== 'skipped') ? 'incomplete' : 'complete';
  if (controller) controller.finish(lifecycle);
  else setLifecycle(lifecycle);
  const report = await save();
  return { runDir, report };
}

export async function resumeJob(runDir, config, dependencies, options = {}) {
  const resumeState = await readCheckpoint(runDir, config);
  return runJob(config, dependencies, { ...options, resumeFrom: runDir, resumeState });
}
