import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { validateConfig } from '../src/config.mjs';
import { openBrowser } from '../src/browser.mjs';
import { capturePage } from '../src/capture.mjs';
import { buildPdf } from '../src/export.mjs';
import { runJob } from '../src/job.mjs';

async function fixture(t, html, overrides = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/site' ? html : '<h1>Discovered leaf</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const outputRoot = process.env.CAPTURE_TEST_OUTPUT_ROOT ?? os.tmpdir();
  await fs.mkdir(outputRoot, { recursive: true });
  const outputDir = await fs.mkdtemp(path.join(outputRoot, 'exploration-browser-'));
  if (!process.env.CAPTURE_TEST_OUTPUT_ROOT) t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  else console.log(`Fixture evidence: ${outputDir}`);
  const config = validateConfig({ startUrl: `http://127.0.0.1:${server.address().port}/site`, scopePath: '/site', outputDir, buildPdf: false,
    viewport: { width: 800, height: 500 }, timeoutMs: 2000, imageTimeoutMs: 500,
    browser: { headless: true, ...(process.env.CAPTURE_TEST_CHANNEL ? { channel: process.env.CAPTURE_TEST_CHANNEL } : {}) },
    exploration: { settleIntervalMs: 25, settleTimeoutMs: 200, ...overrides.exploration },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'exploration')) });
  return { config, requests, run: () => runJob(config, { openBrowser, capturePage, buildPdf }) };
}

test('nested disclosures, tabs and expandable panels capture states and enqueue newly visible links', async t => {
  const html = `<!doctype html><h1>Content controls</h1>
    <details><summary>Outer</summary><p>Outer content</p><details><summary>Inner</summary><a href="/site/nested">Nested lesson</a></details></details>
    <button type="button" role="tab" aria-controls="specs" aria-selected="false" onclick="this.setAttribute('aria-selected','true');document.getElementById('specs').hidden=false">Specifications</button>
    <section id="specs" hidden><a href="/site/specs">Specification page</a></section>
    <button type="button" aria-controls="menu" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.getElementById('menu').hidden=false">Menu</button>
    <nav id="menu" hidden><a href="/site/menu">Menu page</a></nav>
    <button type="button" onclick="fetch('/site/delete',{method:'POST'})">Delete account</button>
    <button type="button" onclick="fetch('/site/mystery')">Mystery</button>`;
  const { run, requests } = await fixture(t, html, { buildPdf: true });
  const { report, runDir } = await run();
  assert.equal(report.fatalError, null, JSON.stringify(report));
  const root = report.results[0];
  assert.equal(root.states.length, 4, JSON.stringify(root));
  assert.ok(root.states.every(state => state.status === 'captured'), JSON.stringify(root.states));
  assert.equal(root.states.at(-1).actions.length, 2);
  const outerState = root.states.find(state => state.actions.length === 1 && state.actions[0].label === 'Outer');
  const innerState = root.states.find(state => state.actions.length === 2);
  assert.equal(innerState.parentStateId, outerState.index);
  assert.equal(innerState.parentPageId, root.index);
  assert.ok(report.graph.pages.some(page => page.url.endsWith('/site/nested')));
  assert.ok(report.graph.pages.some(page => page.url.endsWith('/site/specs')));
  assert.ok(report.graph.pages.some(page => page.url.endsWith('/site/menu')));
  assert.ok(root.controls.some(control => control.label === 'Delete account' && control.status === 'excluded'));
  assert.ok(root.controls.some(control => control.label === 'Mystery' && control.status === 'unclassified'));
  assert.equal(requests.some(value => /delete|mystery/.test(value)), false);
  assert.equal(report.status, 'incomplete'); // Unknown control is honestly unexamined.
  for (const state of root.states) assert.ok((await fs.stat(path.join(runDir, state.screenshot))).size > 0);
  const pdf = await PDFDocument.load(await fs.readFile(path.join(runDir, report.pdf)));
  assert.ok(pdf.getPageCount() >= 8);
});

test('scroll captures retain ordered virtual-list frames and links revealed while scrolling', async t => {
  const html = `<!doctype html><h1>Long page</h1><div style="height:1700px">Tall content</div>
    <div id="list" style="height:180px;overflow:auto;border:1px solid"><div style="height:1000px;position:relative"><div id="rows" style="position:sticky;top:0">Row 0</div></div></div>
    <script>const list=document.getElementById('list');list.addEventListener('scroll',()=>{document.getElementById('rows').innerHTML='Row '+Math.floor(list.scrollTop/100)+(list.scrollTop>500?'<a href="/site/virtual">Virtual item</a>':'');});</script>`;
  const { run } = await fixture(t, html, { exploration: { maxFullPageHeight: 1000, maxScrollSteps: 12 } });
  const { report, runDir } = await run();
  const root = report.results[0];
  assert.equal(root.status, 'captured', JSON.stringify(root));
  assert.equal(root.artifacts[0].kind, 'overview');
  assert.deepEqual(root.artifacts.map(item => item.order), root.artifacts.map((_item, index) => index));
  assert.ok(root.artifacts.filter(item => item.kind === 'scroll-step').length >= 4);
  const inner = root.artifacts.filter(item => item.kind === 'scroll-region');
  assert.ok(inner.length >= 5);
  assert.ok(inner.at(-1).scrollTop > inner[0].scrollTop);
  assert.ok(report.graph.pages.some(page => page.url.endsWith('/site/virtual')));
  for (const image of root.artifacts) assert.ok((await fs.stat(path.join(runDir, 'screenshots', image.file))).size > 0);
});

test('infinite growth stops at the scroll budget and produces partial output', async t => {
  const html = `<!doctype html><h1>Infinite feed</h1><div id="feed" style="height:1300px">Feed</div>
    <script>addEventListener('scroll',()=>{if(scrollY+innerHeight>=document.body.scrollHeight-50)document.getElementById('feed').style.height=(document.getElementById('feed').offsetHeight+800)+'px';});</script>`;
  const { run } = await fixture(t, html, { exploration: { maxScrollSteps: 3, maxFullPageHeight: 1000 } });
  const { report } = await run();
  assert.equal(report.results[0].status, 'partial');
  assert.ok(report.results[0].warnings.some(item => item.code === 'SCROLL_STEP_LIMIT'));
  assert.equal(report.exitCode, 1);
});

test('state count limits remain visible and a no-op tab is reported as failed', async t => {
  const html = `<!doctype html><h1>Controls</h1><button role="tab" aria-selected="false" aria-controls="p">No-op tab</button><section id="p" hidden>Never shown</section><details><summary>More</summary>More content</details>`;
  const { run } = await fixture(t, html, { exploration: { maxStates: 1 } });
  const { report } = await run();
  assert.equal(report.results[0].states[0].status, 'failed');
  assert.equal(report.results[0].states[0].error.code, 'PANEL_NOT_VISIBLE');
  assert.ok(report.results[0].controls.some(control => control.reason === 'state-count-limit'));
  assert.equal(report.exitCode, 1);
});

test('content-shaped control attempting a POST is blocked without reaching the server', async t => {
  const html = `<!doctype html><h1>Unexpected behavior</h1><button role="tab" aria-selected="false" aria-controls="p" onclick="fetch('/site/write',{method:'POST'}).catch(()=>{});this.setAttribute('aria-selected','true');document.getElementById('p').hidden=false">Panel</button><section id="p" hidden>Content</section>`;
  const { run, requests } = await fixture(t, html);
  const { report } = await run();
  assert.equal(report.results[0].states[0].status, 'blocked');
  assert.equal(report.results[0].states[0].error.code, 'UNEXPECTED_SIDE_EFFECT');
  assert.equal(requests.includes('POST /site/write'), false);
});

test('explicit load-more configuration explores successive content until the control disables', async t => {
  const html = `<!doctype html><h1>Feed</h1><div id="items">First</div><button id="more" type="button" onclick="const items=document.getElementById('items');items.append(' Item');this.dataset.count=Number(this.dataset.count||0)+1;if(this.dataset.count==='2')this.disabled=true">Load more</button>`;
  const { run } = await fixture(t, html, { exploration: { paginationSelectors: ['#more'] } });
  const { report } = await run();
  assert.equal(report.results[0].states.length, 2, JSON.stringify(report.results[0]));
  assert.ok(report.results[0].states.every(state => state.status === 'captured'));
  assert.equal(report.results[0].states[1].actions.length, 2);
  assert.equal(report.unexploredControls, 0);
});

test('a removed scroll region preserves preceding screenshots and reports partial evidence', async t => {
  const html = `<!doctype html><h1>Disappearing region</h1><div id="list" style="height:180px;overflow:auto"><div style="height:1000px">Content</div></div><script>document.getElementById('list').addEventListener('scroll',event=>event.currentTarget.remove(),{once:true});</script>`;
  const { run } = await fixture(t, html);
  const { report, runDir } = await run();
  const root = report.results[0];
  assert.equal(root.status, 'partial', JSON.stringify(root));
  assert.ok(root.warnings.some(warning => warning.code === 'SCROLL_REGION_REMOVED'));
  assert.equal(root.artifacts[0].kind, 'recovered-overview');
  assert.ok((await fs.stat(path.join(runDir, root.screenshot))).size > 0);
  assert.equal(report.exitCode, 1);
});
