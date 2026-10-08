import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { openBrowser } from '../src/browser.mjs';
import { capturePage } from '../src/capture.mjs';
import { buildPdf } from '../src/export.mjs';
import { createJobController } from '../src/controller.mjs';
import { resumeJob, runJob } from '../src/job.mjs';

async function fixture(t, handler, overrides = {}) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-recovery-browser-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const startUrl = `http://127.0.0.1:${server.address().port}/site`;
  const config = validateConfig({ startUrl, scopePath: '/site', outputDir, buildPdf: false,
    discovery: { enabled: false }, exploration: { enabled: false }, timeoutMs: 2000, imageTimeoutMs: 500,
    ...overrides,
    browser: { headless: true, ...(process.env.CAPTURE_TEST_CHANNEL ? { channel: process.env.CAPTURE_TEST_CHANNEL } : {}) } });
  let page;
  const open = async value => {
    const session = await openBrowser(value);
    const context = session.context;
    return { ...session, context: { newPage: async () => { page = await context.newPage(); return page; } } };
  };
  return { config, getPage: () => page, dependencies: { openBrowser: open, capturePage, buildPdf } };
}

test('expired login pauses for manual resolution and retries only after access is verified', async t => {
  let authorized = false;
  const { config, dependencies, getPage } = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/site/protected' && !authorized) res.end('<h1>Sign in</h1><input type="password">');
    else res.end('<h1>Authorized fixture content</h1>');
  });
  config.urls.push(`${config.startUrl}/protected`);
  const controller = createJobController({ onEvent: async event => {
    if (event.type !== 'user-action-required') return;
    authorized = true;
    await getPage().evaluate(() => { document.body.innerHTML = '<h1>Access restored</h1>'; });
    controller.resume();
  } });
  const { report } = await runJob(config, dependencies, { controller });
  assert.equal(report.lifecycle, 'complete');
  const protectedPage = report.results.find(result => result.url.endsWith('/protected'));
  assert.equal(protectedPage.status, 'captured');
  assert.deepEqual(protectedPage.attempts.map(attempt => attempt.status), ['blocked', 'captured']);
  assert.ok(report.events.some(event => event.type === 'access-verified'));
});

test('supported CAPTCHA challenge pauses without attempting to solve it and cancellation preserves pending work', async t => {
  const { config, dependencies } = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/site' ? '<h1>Fixture</h1>' : req.url === '/site/captcha-frame'
      ? '<h1>Challenge frame</h1>' : '<h1>Security check</h1><iframe src="/site/captcha-frame"></iframe>');
  });
  config.urls.push(`${config.startUrl}/challenge`);
  const controller = createJobController({ onEvent: event => {
    if (event.type === 'user-action-required') controller.cancel();
  } });
  const { report } = await runJob(config, dependencies, { controller });
  assert.equal(report.lifecycle, 'cancelled');
  assert.equal(report.pending, 1);
  assert.ok(report.events.some(event => event.type === 'user-action-required' && event.reason === 'ACCESS_CHALLENGE'), JSON.stringify(report));
  assert.equal(report.results.some(result => result.url.endsWith('/challenge')), false);
});

test('cancellation during scrolling checkpoints ordered evidence and resume recaptures with fresh files', async t => {
  const html = `<h1>Long fixture</h1><div style="height:2600px">Long content</div>
    <a id="temporary" href="/site/temporary" style="display:none">Temporary virtual row</a>
    <script>addEventListener('scroll',()=>{const link=document.getElementById('temporary');link.style.display=scrollY>=600&&scrollY<1500?'block':'none';});</script>`;
  const { config, dependencies } = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(_req.url === '/site/temporary' ? '<h1>Temporary page</h1>' : html);
  }, { discovery: { enabled: true }, exploration: { enabled: true, maxFullPageHeight: 1000, maxScrollSteps: 10, settleIntervalMs: 25, settleTimeoutMs: 200 } });
  const controller = createJobController();
  const first = await runJob(config, dependencies, { controller, onEvent: event => {
    if (event.type === 'capture-evidence' && event.kind === 'scroll-step' && event.step === 2) controller.cancel();
  } });
  assert.equal(first.report.lifecycle, 'cancelled');
  assert.equal(first.report.results[0].status, 'partial');
  assert.ok(first.report.results[0].artifacts.some(artifact => artifact.kind === 'scroll-step'));
  assert.ok(first.report.graph.pages.some(page => page.url.endsWith('/site/temporary')));
  const oldScreenshot = first.report.results[0].screenshot;
  const resumed = await resumeJob(first.runDir, config, dependencies);
  assert.equal(resumed.report.lifecycle, 'complete');
  assert.notEqual(resumed.report.results[0].screenshot, oldScreenshot);
});

test('pause during scrolling checkpoints lifecycle and viewport progress before continuing', async t => {
  const { config, dependencies } = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<h1>Long fixture</h1><div style="height:2600px">Long content</div>');
  }, { exploration: { enabled: true, maxFullPageHeight: 1000, maxScrollSteps: 10, settleIntervalMs: 25, settleTimeoutMs: 200 } });
  const controller = createJobController();
  let requestedPause = false;
  let persistedPause;
  const persisted = new Promise(resolve => { persistedPause = resolve; });
  controller.subscribe(event => {
    if (event.type !== 'paused') return;
    setTimeout(async () => {
      const runDir = (await fs.readdir(config.outputDir)).map(name => path.join(config.outputDir, name))[0];
      const report = JSON.parse(await fs.readFile(path.join(runDir, 'manifest.json'), 'utf8'));
      const checkpoint = JSON.parse(await fs.readFile(path.join(runDir, 'checkpoint.json'), 'utf8'));
      persistedPause({ report, checkpoint });
      controller.resume();
    }, 50);
  });
  const outcome = await runJob(config, dependencies, { controller, onEvent: event => {
    if (!requestedPause && event.type === 'capture-evidence' && event.kind === 'scroll-step') {
      requestedPause = true;
      controller.pause();
    }
  } });
  const checkpointed = await persisted;
  assert.equal(checkpointed.report.lifecycle, 'paused');
  assert.ok(checkpointed.checkpoint.inFlight.evidencePaths.some(item => item.kind === 'scroll-step'));
  assert.equal(outcome.report.lifecycle, 'complete');
});

test('resume replays a cancelled nested action path and still discovers revealed links', async t => {
  const html = '<h1>Nested states</h1><details><summary>Outer</summary><details><summary>Inner</summary><a href="/site/revealed">Revealed link</a></details></details>';
  const { config, dependencies } = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/site' ? html : '<h1>Revealed page</h1>');
  }, { discovery: { enabled: true }, exploration: { enabled: true, settleIntervalMs: 25, settleTimeoutMs: 200 } });
  const controller = createJobController();
  const first = await runJob(config, dependencies, { controller, onEvent: event => {
    if (event.type === 'state-replay-progress' && event.actionDepth === 2) controller.cancel();
  } });
  assert.equal(first.report.lifecycle, 'cancelled');
  assert.equal(first.report.results[0].status, 'partial');
  assert.ok(first.report.results[0].states.some(state => state.actions.length === 2 && state.status === 'cancelled'));

  const resumed = await resumeJob(first.runDir, config, dependencies);
  const root = resumed.report.results[0];
  assert.ok(root.states?.some(state => state.actions.length === 2 && state.status === 'captured'), JSON.stringify(resumed.report));
  assert.ok(resumed.report.graph.pages.some(page => page.url.endsWith('/site/revealed')), JSON.stringify(resumed.report));
  assert.deepEqual(resumed.report.results.map(result => result.index), [1, 2]);
});

test('challenge during state replay uses manual verification before replaying the state', async t => {
  let resolved = false;
  const { config, dependencies, getPage } = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/site/captcha-frame') { res.end('<h1>Challenge frame</h1>'); return; }
    if (resolved) {
      res.end(`<h1>Specifications</h1>
        <button type="button" role="tab" aria-controls="panel" aria-selected="false"
          onclick="this.setAttribute('aria-selected','true');document.getElementById('panel').hidden=false">Details</button>
        <section id="panel" hidden>Verified content</section>`);
      return;
    }
    res.end(`<h1>Specifications</h1>
      <button type="button" role="tab" aria-controls="panel" aria-selected="false"
        onclick="this.setAttribute('aria-selected','true');document.getElementById('panel').hidden=false;document.getElementById('challenge').hidden=false">Details</button>
      <section id="panel" hidden>Panel</section>
      <div id="challenge" hidden><h1>Complete the security check</h1><iframe src="/site/captcha-frame"></iframe></div>`);
  }, { discovery: { enabled: true }, exploration: { enabled: true, settleIntervalMs: 25, settleTimeoutMs: 200 } });
  const controller = createJobController({ onEvent: async event => {
    if (event.type !== 'user-action-required') return;
    resolved = true;
    await getPage().evaluate(() => { document.body.innerHTML = '<h1>Manually verified fixture access</h1>'; });
    controller.resume();
  } });
  const report = (await runJob(config, dependencies, { controller })).report;
  assert.equal(report.lifecycle, 'complete', JSON.stringify(report));
  assert.ok(report.events.some(event => event.type === 'user-action-required' && event.reason === 'ACCESS_CHALLENGE'), JSON.stringify(report));
  assert.ok(report.events.some(event => event.type === 'access-verified'));
  assert.deepEqual(report.results[0].attempts.map(attempt => attempt.status), ['blocked', 'captured']);
  assert.ok(report.results[0].states.some(state => state.status === 'captured'));
});

test('transient navigation failure during state replay retries from a fresh attempt path', async t => {
  let requests = 0;
  const html = '<h1>Disclosure fixture</h1><details><summary>Details</summary><p>Revealed content</p></details>';
  const { config, dependencies } = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/site' && ++requests === 2) { res.writeHead(503); res.end('<h1>Temporary fixture failure</h1>'); return; }
    res.end(html);
  }, { discovery: { enabled: true }, exploration: { enabled: true, settleIntervalMs: 25, settleTimeoutMs: 200 } });
  const { report } = await runJob(config, dependencies);
  assert.equal(report.lifecycle, 'complete', JSON.stringify(report));
  assert.deepEqual(report.results[0].attempts.map(attempt => attempt.status), ['failed', 'captured']);
  assert.match(report.results[0].states[0].screenshot, /attempt-02-state-001/);
});
