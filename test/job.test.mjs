import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { CaptureError } from '../src/errors.mjs';
import { runJob } from '../src/job.mjs';

async function setup(t) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-test-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const config = validateConfig({ startUrl: 'https://example.test/', urls: ['https://example.test/second'], outputDir, buildPdf: false,
    discovery: { enabled: false }, exploration: { enabled: false }, retry: { maxAttempts: 1 } });
  const lifecycle = [];
  const page = { setViewportSize: async () => {}, route: async () => {}, close: async () => lifecycle.push('page-closed') };
  const dependencies = {
    openBrowser: async () => ({ context: { newPage: async () => page }, close: async () => lifecycle.push('session-closed') }),
    capturePage: async () => ({ status: 'captured', warnings: [], width: 10, height: 20 }),
    buildPdf: async () => 'archive.pdf'
  };
  return { outputDir, config, dependencies, lifecycle };
}
test('failed page does not hide subsequent successes or return a success exit code', async t => {
  const { config, dependencies, lifecycle } = await setup(t);
  let count = 0;
  dependencies.capturePage = async () => { if (count++ === 0) throw new CaptureError('HTTP_500', 'Server returned HTTP 500.'); return { status: 'captured' }; };
  const { runDir, report } = await runJob(config, dependencies);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.results.map(item => item.status), ['failed', 'captured']);
  assert.equal(report.results[0].screenshot, undefined);
  assert.equal(report.results[1].screenshot, 'screenshots/0002.png');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(runDir, 'manifest.json'))), report);
  assert.deepEqual(lifecycle, ['page-closed', 'session-closed']);
});
test('resource warnings make overall output incomplete', async t => {
  const { config, dependencies } = await setup(t);
  dependencies.capturePage = async () => ({ status: 'partial', warnings: [{ code: 'BROKEN_IMAGES' }] });
  const { report } = await runJob(config, dependencies);
  assert.equal(report.exitCode, 1);
  assert.equal(report.counts.partial, 2);
});
test('successful runs are isolated and use relative output references', async t => {
  const { config, dependencies } = await setup(t);
  const first = await runJob(config, dependencies);
  const second = await runJob(config, dependencies);
  assert.equal(first.report.exitCode, 0);
  assert.notEqual(first.runDir, second.runDir);
  assert.equal(path.isAbsolute(first.report.results[0].screenshot), false);
});
test('PDF failure preserves captured results and prevents overall success', async t => {
  const { config, dependencies } = await setup(t);
  config.buildPdf = true;
  dependencies.buildPdf = async () => { throw Error('export failure'); };
  const { report } = await runJob(config, dependencies);
  assert.equal(report.counts.captured, 2);
  assert.equal(report.exitCode, 1);
  assert.equal(report.exportError.code, 'PDF_FAILED');
});
test('browser setup failure produces a report with unattempted work', async t => {
  const { config, dependencies } = await setup(t);
  dependencies.openBrowser = async () => { throw Error('browser unavailable'); };
  const { report } = await runJob(config, dependencies);
  assert.equal(report.exitCode, 1);
  assert.equal(report.planned, 2);
  assert.equal(report.results.length, 0);
  assert.equal(report.fatalError.code, 'JOB_FAILED');
});
