import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';

async function makeServer(options = {}) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-ui-'));
  const serverInfo = await startServer({ host: '127.0.0.1', port: 0, outputDir, ...options });
  const baseUrl = `${serverInfo.baseUrl}`;
  return { ...serverInfo, baseUrl, cleanup: async () => {
    await serverInfo.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  } };
}

async function createResultRun(runDir, report) {
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(path.join(runDir, 'screenshots'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(report));
  const screenshot = path.join(runDir, 'screenshots', 'capture.png');
  await fs.writeFile(screenshot, Buffer.from('png-data'));
  if (report.pdf) await fs.writeFile(path.join(runDir, report.pdf), Buffer.from('pdf-data'));
  return runDir;
}

async function waitForStatus(baseUrl, jobId, expectedState, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}`);
    if (response.ok) {
      const payload = await response.json();
      if (payload.status === expectedState || payload.lifecycle === expectedState) return payload;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach ${expectedState}.`);
}

test('frontend serves the form and rejects invalid URL values', async () => {
  const server = await makeServer();
  try {
    const page = await fetch(`${server.baseUrl}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Website capture/i);
    assert.match(html, /Start capture/i);

    const css = await fetch(`${server.baseUrl}/styles.css`);
    const cssText = await css.text();
    assert.match(cssText, /:focus-visible/i);
    assert.match(cssText, /@media \(max-width: 700px\)/i);

    const bad = await fetch(`${server.baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ url: 'ftp://example.com' })
    });
    assert.equal(bad.status, 400);
    const payload = await bad.json();
    assert.equal(payload.code, 'INVALID_URL');
  } finally {
    await server.cleanup();
  }
});

test('duplicate submissions are blocked while a job is active', async () => {
  const engine = { runJob: async () => {
    await new Promise(resolve => setTimeout(resolve, 250));
    return {
      runDir: path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'capture-dup-')), 'job'),
      report: { lifecycle: 'complete', status: 'complete', counts: { captured: 1, partial: 0, failed: 0, blocked: 0, skipped: 0, limited: 0 }, discovered: 1, attempted: 1, pending: 0, results: [] }
    };
  } };
  const server = await makeServer({ engine });
  try {
    const original = await fetch(`${server.baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ url: 'https://example.com' })
    });
    assert.equal(original.status, 202);
    const blocked = await fetch(`${server.baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ url: 'https://example.org' })
    });
    assert.equal(blocked.status, 409);
    const body = await blocked.json();
    assert.match(body.message, /already running/i);
  } finally {
    await server.cleanup();
  }
});

test('successful captures expose result links and reject unsafe artifact paths', async () => {
  const engine = { runJob: async (_, __, options) => {
    const jobDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'capture-success-')));
    const report = {
      lifecycle: 'complete',
      status: 'complete',
      counts: { captured: 1, partial: 0, failed: 0, blocked: 0, skipped: 0, limited: 0 },
      discovered: 1,
      attempted: 1,
      pending: 0,
      results: [{ url: 'https://example.com/', status: 'captured', screenshot: 'screenshots/capture.png', artifacts: [{ file: 'screenshots/capture.png' }], pdf: 'report.pdf' }],
      pdf: 'report.pdf'
    };
    await createResultRun(jobDir, report);
    options.onEvent?.({ type: 'job-finished', lifecycle: 'complete', status: 'complete', timestamp: new Date().toISOString() });
    return { runDir: jobDir, report };
  } };
  const server = await makeServer({ engine });
  try {
    const created = await fetch(`${server.baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ url: 'https://example.com' })
    });
    assert.equal(created.status, 202);
    const payload = await created.json();
    const jobId = payload.jobId;
    const report = await waitForStatus(server.baseUrl, jobId, 'complete');
    assert.equal(report.status, 'complete');
    assert.equal(report.results.length, 1);

    const artifact = await fetch(`${server.baseUrl}/api/jobs/${jobId}/artifacts?path=${encodeURIComponent('screenshots/capture.png')}`);
    assert.equal(artifact.status, 200);
    assert.equal(artifact.headers.get('content-type'), 'image/png');

    const blocked = await fetch(`${server.baseUrl}/api/jobs/${jobId}/artifacts?path=${encodeURIComponent('../secret.txt')}`);
    assert.equal(blocked.status, 400);
    const blockedBody = await blocked.json();
    assert.equal(blockedBody.code, 'INVALID_ARTIFACT_PATH');
  } finally {
    await server.cleanup();
  }
});

test('partial and blocked outcomes surface the right counts and manual access state', async () => {
  const runPartial = async () => {
    const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-partial-'));
    const report = {
      lifecycle: 'incomplete',
      status: 'partial',
      counts: { captured: 0, partial: 1, failed: 0, blocked: 0, skipped: 0, limited: 0 },
      discovered: 1,
      attempted: 1,
      pending: 0,
      results: [{ url: 'https://example.com/', status: 'partial', warnings: [{ code: 'BROKEN_IMAGES' }] }]
    };
    await createResultRun(jobDir, { ...report, pdf: null, results: report.results });
    return { runDir: jobDir, report };
  };

  const engine = { runJob: async () => runPartial() };
  const server = await makeServer({ engine });
  try {
    const response = await fetch(`${server.baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ url: 'https://example.com/partial' })
    });
    assert.equal(response.status, 202);
    const payload = await response.json();
    const report = await waitForStatus(server.baseUrl, payload.jobId, 'partial');
    assert.equal(report.status, 'partial');
    assert.equal(report.counts.partial, 1);
  } finally {
    await server.cleanup();
  }
});

test('manual access events provide a continue action', async () => {
  const engine = { runJob: async (_config, _deps, options) => {
    const controller = options.controller;
    setTimeout(() => {
      if (controller.getState() === 'waiting-for-user-action') {
        controller.resume();
      }
    }, 80);
    controller.waitForUserAction('LOGIN_REQUIRED', 1);
    return {
      runDir: path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'capture-manual-'))),
      report: {
        lifecycle: 'complete',
        status: 'complete',
        counts: { captured: 1, partial: 0, failed: 0, blocked: 0, skipped: 0, limited: 0 },
        discovered: 1,
        attempted: 1,
        pending: 0,
        results: [{ url: 'https://example.com/login', status: 'captured' }]
      }
    };
  } };

  const server = await makeServer({ engine });
  try {
    const created = await fetch(`${server.baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ url: 'https://example.com/login' })
    });
    assert.equal(created.status, 202);
    const payload = await created.json();
    const before = await fetch(`${server.baseUrl}/api/jobs/${payload.jobId}`);
    const after = await before.json();
    assert.ok(after.lifecycle === 'waiting-for-user-action' || after.lifecycle === 'complete');

    const control = await fetch(`${server.baseUrl}/api/jobs/${payload.jobId}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ action: 'continue' })
    });
    assert.equal(control.status, 200);
    const finalState = await fetch(`${server.baseUrl}/api/jobs/${payload.jobId}`);
    assert.equal(finalState.status, 200);
    const finalBody = await finalState.json();
    assert.ok(['complete', 'incomplete'].includes(finalBody.lifecycle));
  } finally {
    await server.cleanup();
  }
});

