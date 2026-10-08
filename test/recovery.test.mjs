import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { validateConfig } from '../src/config.mjs';
import { CaptureError } from '../src/errors.mjs';
import { createJobController } from '../src/controller.mjs';
import { readCheckpoint } from '../src/checkpoint.mjs';
import { resumeJob, runJob } from '../src/job.mjs';

async function setup(t, overrides = {}) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-recovery-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const config = validateConfig({ startUrl: 'https://example.test/', urls: ['https://example.test/second'],
    outputDir, buildPdf: false, discovery: { enabled: false }, exploration: { enabled: false },
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }, ...overrides });
  const lifecycle = [];
  const page = { setViewportSize: async () => {}, route: async () => {}, close: async () => lifecycle.push('page-closed') };
  const dependencies = {
    openBrowser: async () => ({ context: { newPage: async () => page }, close: async () => lifecycle.push('session-closed') }),
    capturePage: async (_page, _url, filename) => {
      await sharp({ create: { width: 16, height: 16, channels: 3, background: '#fff' } }).png().toFile(filename);
      return { status: 'captured', width: 16, height: 16, artifacts: [{ file: path.basename(filename), width: 16, height: 16 }] };
    },
    buildPdf: async () => null
  };
  return { outputDir, config, dependencies, lifecycle };
}

test('transient navigation failure retries with fresh evidence paths and retains attempt history', async t => {
  const { config, dependencies } = await setup(t, { retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } });
  let calls = 0;
  dependencies.capturePage = async (page, url, filename) => {
    calls++;
    if (calls === 1) throw new CaptureError('NAVIGATION_FAILED', 'Navigation failed.');
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#fff' } }).png().toFile(filename);
    return { status: 'captured', artifacts: [{ file: path.basename(filename) }] };
  };
  const { report } = await runJob(config, dependencies);
  assert.equal(report.results[0].status, 'captured');
  assert.equal(report.results[0].attempts.length, 2);
  assert.notEqual(report.results[0].attempts[0].number, report.results[0].attempts[1].number);
  assert.match(report.results[0].screenshot, /attempt-02/);
});

test('retry exhaustion and excessive Retry-After remain explicit limited outcomes', async t => {
  const exhausted = await setup(t, { urls: [], retry: { maxAttempts: 2 } });
  exhausted.dependencies.capturePage = async () => { throw new CaptureError('HTTP_503', 'Temporary server failure.'); };
  const failed = await runJob(exhausted.config, exhausted.dependencies);
  assert.equal(failed.report.results[0].status, 'failed');
  assert.equal(failed.report.results[0].attempts.length, 2);

  const limited = await setup(t, { urls: [], retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10 } });
  limited.dependencies.capturePage = async () => { throw new CaptureError('HTTP_429', 'Rate limited.', 'limited', { retryAfterMs: 60000 }); };
  const rateLimited = await runJob(limited.config, limited.dependencies);
  assert.equal(rateLimited.report.results[0].status, 'limited');
  assert.ok(rateLimited.report.limits.includes('rate-limited'));
  assert.equal(rateLimited.report.results[0].attempts.length, 1);

  const guided = await setup(t, { urls: [], retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 20 } });
  let calls = 0;
  const successfulCapture = guided.dependencies.capturePage;
  guided.dependencies.capturePage = async (...args) => {
    if (calls++ === 0) throw new CaptureError('HTTP_429', 'Rate limited.', 'limited', { retryAfterMs: 5 });
    return successfulCapture(...args);
  };
  const afterWait = await runJob(guided.config, guided.dependencies);
  assert.equal(afterWait.report.results[0].status, 'captured');
  assert.equal(afterWait.report.results[0].attempts[0].retryDelayMs, 5);
});

test('browser crash reconnects into an owned capture session; export failure remains incomplete', async t => {
  const { config, dependencies } = await setup(t, { urls: [], retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } });
  const open = dependencies.openBrowser;
  let sessions = 0;
  dependencies.openBrowser = async value => { sessions++; return open(value); };
  const capture = dependencies.capturePage;
  let attempts = 0;
  dependencies.capturePage = async (...args) => {
    attempts++;
    if (attempts === 1) throw new CaptureError('BROWSER_CRASHED', 'Browser crashed.');
    return capture(...args);
  };
  const result = await runJob(config, dependencies);
  assert.equal(sessions, 2);
  assert.equal(result.report.results[0].status, 'captured');

  const exporting = await setup(t, { urls: [], buildPdf: true });
  exporting.dependencies.buildPdf = async () => { throw new Error('private exception text'); };
  const failedExport = await runJob(exporting.config, exporting.dependencies);
  assert.equal(failedExport.report.lifecycle, 'incomplete');
  assert.equal(failedExport.report.exportError.code, 'PDF_FAILED');
  assert.equal(JSON.stringify(failedExport.report).includes('private exception text'), false);
});

test('cancellation preserves completed evidence and resume continues without duplicate results', async t => {
  const { config, dependencies } = await setup(t, { retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } });
  const controller = createJobController();
  let calls = 0;
  const capture = dependencies.capturePage;
  dependencies.capturePage = async (...args) => { calls++; return capture(...args); };
  dependencies.onResult = result => {
    if (result.index === 1) controller.cancel();
  };
  const firstRun = await runJob(config, dependencies, { controller });
  assert.equal(firstRun.report.lifecycle, 'cancelled');
  assert.equal(firstRun.report.results.length, 1);
  assert.equal(firstRun.report.pending, 1);
  const firstScreenshot = path.join(firstRun.runDir, firstRun.report.results[0].screenshot);
  assert.ok((await fs.stat(firstScreenshot)).size > 0);
  const checkpointPath = path.join(firstRun.runDir, 'checkpoint.json');
  const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
  checkpoint.queue.items[1].status = 'running';
  checkpoint.attemptHistory.push([2, [{ type: 'attempt', number: 1, status: 'running', timestamp: new Date().toISOString() }]]);
  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint));

  const resumed = await resumeJob(firstRun.runDir, config, dependencies);
  assert.equal(resumed.report.lifecycle, 'complete');
  assert.deepEqual(resumed.report.results.map(result => result.index), [1, 2]);
  assert.equal(calls, 2);
  assert.ok(resumed.report.events.some(event => event.type === 'attempt-interrupted' && event.targetId === 2));
});

test('pending pause resumes only at a safe boundary and cancellation never starts browser work', async t => {
  const { config, dependencies } = await setup(t, { urls: [] });
  const events = [];
  const controller = createJobController({ onEvent: event => events.push(event.type) });
  controller.pause();
  const running = runJob(config, dependencies, { controller });
  while (!events.includes('paused')) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(controller.getState(), 'paused');
  controller.resume();
  const completed = await running;
  assert.equal(completed.report.lifecycle, 'complete');

  const cancelled = createJobController();
  cancelled.cancel();
  let opened = false;
  const neverOpen = { ...dependencies, openBrowser: async () => { opened = true; return dependencies.openBrowser(); } };
  const stopped = await runJob(config, neverOpen, { controller: cancelled });
  assert.equal(opened, false);
  assert.equal(stopped.report.lifecycle, 'cancelled');
  assert.equal(stopped.report.pending, 1);
});

test('missing/corrupt artifacts are recaptured and checkpoint incompatibility is rejected', async t => {
  const { config, dependencies } = await setup(t, { urls: [], retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } });
  const first = await runJob(config, dependencies);
  await fs.writeFile(path.join(first.runDir, first.report.results[0].screenshot), 'not an image');
  let recaptured = 0;
  const original = dependencies.capturePage;
  dependencies.capturePage = async (...args) => { recaptured++; return original(...args); };
  const resumed = await resumeJob(first.runDir, config, dependencies);
  assert.equal(recaptured, 1);
  assert.equal(resumed.report.results.length, 1);
  const checkpointPath = path.join(first.runDir, 'checkpoint.json');
  const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
  checkpoint.version = 999;
  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint));
  await assert.rejects(readCheckpoint(first.runDir, config), { code: 'CHECKPOINT_INCOMPATIBLE' });
  checkpoint.version = 1;
  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint));
  await assert.rejects(readCheckpoint(first.runDir, { ...config, timeoutMs: config.timeoutMs + 1 }), { code: 'CHECKPOINT_CONFIG_MISMATCH' });
});

test('shareable reports do not serialize raw query values or private resume queue keys', async t => {
  const { config, dependencies } = await setup(t, { urls: ['https://example.test/second?token=private-secret'] });
  const { runDir, report } = await runJob(config, dependencies);
  const serialized = await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8');
  const checkpoint = await fs.readFile(path.join(runDir, 'checkpoint.json'), 'utf8');
  assert.equal(serialized.includes('private-secret'), false);
  assert.equal(JSON.stringify(report).includes('private-secret'), false);
  assert.equal(checkpoint.includes('private-secret'), true);
});

test('corrupt and missing private checkpoints fail clearly', async t => {
  const { config } = await setup(t, { urls: [] });
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-invalid-checkpoint-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  await assert.rejects(readCheckpoint(outputDir, config), { code: 'CHECKPOINT_UNREADABLE' });
  await fs.writeFile(path.join(outputDir, 'checkpoint.json'), '{');
  await assert.rejects(readCheckpoint(outputDir, config), { code: 'CHECKPOINT_UNREADABLE' });
});
