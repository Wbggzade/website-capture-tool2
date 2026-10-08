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

test('real browser captures generic content, rejects errors, records broken images and exports only usable captures', async t => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const route = req.url.replace(/^\/site/, '');
    if (route === '/error') { res.writeHead(500); res.end('<h1>Service unavailable</h1>'); }
    else if (route === '/redirect') { res.writeHead(302, { Location: '/outside' }); res.end(); }
    else if (route === '/login') res.end('<h1>Authentication failed</h1><main>Authentication Testing</main>');
    else if (route === '/empty') res.end('<html><body></body></html>');
    else if (route === '/bad.png') { res.writeHead(404); res.end('missing'); }
    else if (route === '/broken') res.end('<h1>Broken image fixture</h1><img src="/site/bad.png">');
    else res.end('<!doctype html><title>Owned capture fixture</title><h1>Generic page without main</h1><div style="height:1800px">Tall fixture</div><footer>End of page</footer>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-browser-test-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const root = `http://127.0.0.1:${server.address().port}/site`;
  const config = validateConfig({ startUrl: root, urls: ['/error', '/login', '/empty', '/broken', '/redirect'].map(route => root + route),
    outputDir, scopePath: '/site', exploration: { enabled: false }, timeoutMs: 1500, imageTimeoutMs: 500, browser: { headless: true, ...(process.env.CAPTURE_TEST_CHANNEL ? { channel: process.env.CAPTURE_TEST_CHANNEL } : {}) } });
  const { report, runDir } = await runJob(config, { openBrowser, capturePage, buildPdf });
  assert.equal(report.fatalError, null, JSON.stringify(report));
  assert.deepEqual(report.results.map(item => item.status), ['captured', 'failed', 'blocked', 'failed', 'partial', 'blocked']);
  assert.equal(report.results[0].height > config.viewport.height, true);
  assert.equal(report.results[1].error.code, 'HTTP_500');
  assert.equal(report.results[2].error.code, 'ACCESS_SCREEN');
  assert.equal(report.results[3].error.code, 'CONTENT_NOT_READY');
  assert.equal(report.results[4].warnings.some(item => item.code === 'BROKEN_IMAGES'), true);
  assert.equal(report.results[5].error.code, 'OUT_OF_SCOPE');
  assert.equal(report.exitCode, 1);
  assert.equal(report.pdf, 'archive.pdf');
  const pdf = await PDFDocument.load(await fs.readFile(path.join(runDir, report.pdf)));
  assert.ok(pdf.getPageCount() >= 2);
  for (const item of report.results.filter(item => item.screenshot)) assert.ok((await fs.stat(path.join(runDir, item.screenshot))).size > 0);
});

test('real browser discovers ordered links, preserves query/hash routes, inventories controls and avoids action links', async t => {
  const requests = [];
  const rootPage = `<!doctype html><title>Discovery fixture</title>
    <nav><a href="/site/a">A</a><a href="/site/b">B</a></nav>
    <main><h1>Discovery</h1><a class="card" href="https://outside.invalid/promo">Unrelated card</a>
    <a href="/site/list?page=1">Page one</a><a href="/site/list?page=2">Page two</a>
    <a href="/site#/alpha">Alpha route</a><a href="/site#/beta">Beta route</a>
    <a href="/site/alias">Alias</a><a href="/site/destination">Destination</a>
    <a href="/site/a">Repeated A</a><a href="#heading">Heading anchor</a>
    <a href="/site/logout">Logout</a><a href="/site/report.pdf">PDF</a>
    <a href="/site/download" download>Download</a><a href="mailto:test@example.test">Mail</a>
    <a href="/site/hidden" style="display:none">Hidden</a>
    <details><summary>Details</summary><a href="/site/not-yet-visible">Hidden lesson</a></details>
    <button role="tab" aria-selected="false" onclick="fetch('/mutate')">Specifications</button>
    <button onclick="fetch('/mutate')">Delete account</button>
    <button onclick="fetch('/mutate')">Mystery</button></main>`;
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/site/alias') { res.writeHead(302, { Location: '/site/destination' }); res.end(); }
    else if (req.url === '/site') res.end(rootPage);
    else if (req.url === '/site/a') res.end('<h1>A</h1><a href="/site/a/child">Child</a><a href="/site">Cycle</a>');
    else res.end('<h1>Leaf</h1><a href="/site">Home</a>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-discovery-browser-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = validateConfig({ startUrl: origin + '/site', scopePath: '/site', outputDir, buildPdf: false, exploration: { enabled: false },
    browser: { headless: true, ...(process.env.CAPTURE_TEST_CHANNEL ? { channel: process.env.CAPTURE_TEST_CHANNEL } : {}) } });
  const { report } = await runJob(config, { openBrowser, capturePage, buildPdf });
  assert.equal(report.fatalError, null, JSON.stringify(report));
  assert.deepEqual(report.graph.pages.map(item => item.url.replace(origin, '')), [
    '/site', '/site/a', '/site/b', '/site/list?[redacted]', '/site/list?[redacted]', '/site#[redacted]', '/site#[redacted]', '/site/alias', '/site/destination', '/site/a/child'
  ]);
  assert.equal(report.counts.failed, 0, JSON.stringify(report.results));
  assert.equal(report.counts.partial, 0);
  assert.equal(report.counts.captured, 9);
  assert.equal(report.counts.skipped, 1);
  assert.equal(report.results[8].reason, 'already-captured-redirect-target');
  assert.equal(report.results[9].parentId, 2);
  assert.ok(report.unexploredControls > 0);
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.results[0].controls.map(item => item.status), ['deferred', 'deferred', 'excluded', 'unclassified']);
  assert.equal(requests.includes('/mutate'), false);
  assert.equal(requests.includes('/site/logout'), false);
  assert.equal(requests.includes('/site/hidden'), false);
  assert.equal(requests.includes('/site/not-yet-visible'), false);
  assert.equal(requests.includes('/site/list?page=1'), true);
  assert.equal(requests.includes('/site/list?page=2'), true);
  const limited = await runJob({ ...config, discovery: { ...config.discovery, maxPages: 1, maxLinksPerPage: 1, maxControlsPerPage: 1 } }, { openBrowser, capturePage, buildPdf });
  assert.equal(limited.report.planned, 1);
  assert.deepEqual(limited.report.graph.limits, ['max-links-per-page', 'max-controls-per-page', 'max-pages']);
  assert.equal(limited.report.status, 'incomplete');
});
