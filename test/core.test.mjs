import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { inScope, urlKey, displayUrl } from '../src/url.mjs';
import { checkResponse, checkContent } from '../src/readiness.mjs';
import { publicError } from '../src/errors.mjs';

test('scope accepts the course-root regression without accepting sibling paths or other origins', () => {
  assert.equal(inScope('https://example.test/docs', 'https://example.test/docs/', '/docs/'), true);
  assert.equal(inScope('https://example.test/docs/a', 'https://example.test/docs/', '/docs'), true);
  assert.equal(inScope('https://example.test/docs-evil', 'https://example.test/docs/', '/docs'), false);
  assert.equal(inScope('https://outside.test/docs/a', 'https://example.test/docs/', '/docs'), false);
});
test('identity preserves query pagination, hash routes and potentially meaningful trailing slashes', () => {
  assert.notEqual(urlKey('https://example.test/?page=1'), urlKey('https://example.test/?page=2'));
  assert.notEqual(urlKey('https://example.test/#/a'), urlKey('https://example.test/#/b'));
  assert.notEqual(urlKey('https://example.test/docs'), urlKey('https://example.test/docs/'));
});
test('URL validation accepts bare domains and rejects non-web URLs and embedded credentials', () => {
  assert.equal(urlKey(' www.example.ru '), 'https://www.example.ru/');
  for (const input of ['', 'not a website', 'file:///private', 'javascript:alert(1)', 'https://user:pass@example.test']) {
    assert.throws(() => urlKey(input), { code: 'INVALID_URL' });
  }
});
test('config validates every target and incompatible capture output flags before execution', () => {
  assert.throws(() => validateConfig({ startUrl: 'https://example.test', urls: ['https://outside.test'] }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateConfig({ startUrl: 'https://example.test', capturePng: false, buildPdf: true }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateConfig({ startUrl: 'https://example.test', timeoutMs: 0 }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateConfig({ startUrl: 'https://example.test', allowedPrefix: 'old-field' }), { code: 'INVALID_CONFIG' });
});
test('portable browser launch config does not require an explicit platform channel', () => {
  const config = validateConfig({ startUrl: 'https://example.test', browser: { mode: 'launch', headless: false } });
  assert.equal(config.browser.mode, 'launch');
  assert.equal(config.browser.headless, false);
  assert.equal(config.browser.channel, undefined);
});
test('attachment endpoint is restricted to local browser connection', () => {
  assert.throws(() => validateConfig({ startUrl: 'https://example.test', browser: { mode: 'attach', endpoint: 'https://remote.test' } }), { code: 'INVALID_CONFIG' });
});
test('targets deduplicate exactly while preserving user order', () => {
  const config = validateConfig({ startUrl: 'https://example.test/', urls: ['https://example.test/a', 'https://example.test/', 'https://example.test/b'] });
  assert.deepEqual(config.urls, ['https://example.test/', 'https://example.test/a', 'https://example.test/b']);
});
test('HTTP errors cannot produce success and access errors are classified as blocked', () => {
  for (const status of [401, 403]) assert.throws(() => checkResponse({ status: () => status }), { status: 'blocked' });
  for (const status of [404, 500]) assert.throws(() => checkResponse({ status: () => status }), { status: 'failed' });
  assert.throws(() => checkResponse({ status: () => 429 }), { status: 'limited', code: 'HTTP_429' });
  assert.doesNotThrow(() => checkResponse({ status: () => 200 }));
});
function fakePage({ errorScreen = false, ready = false } = {}) {
  return {
    url: () => 'https://example.test/',
    locator: selector => ({
      count: async () => 0,
      filter: () => ({ count: async () => Number(errorScreen) }),
      first: () => ({ waitFor: async () => { if (!ready) throw new Error('timeout'); } })
    }),
    waitForFunction: async () => { if (!ready) throw new Error('timeout'); }
  };
}
test('authentication failure signal is never overridden by course-like words', async () => {
  await assert.rejects(checkContent(fakePage({ errorScreen: true }), validateConfig({ startUrl: 'https://example.test/' })), { code: 'ACCESS_SCREEN' });
});
test('readiness timeout propagates as failure', async () => {
  await assert.rejects(checkContent(fakePage(), validateConfig({ startUrl: 'https://example.test/', timeoutMs: 100 })), { code: 'CONTENT_NOT_READY' });
});
test('generic ready pages do not require a main element or course vocabulary', async () => {
  await checkContent(fakePage({ ready: true }), validateConfig({ startUrl: 'https://example.test/' }));
});
test('output redacts query values, fragments, and raw exception contents', () => {
  assert.equal(displayUrl('https://example.test/callback?code=secret#token'), 'https://example.test/callback?[redacted]#[redacted]');
  assert.equal(JSON.stringify(publicError(new Error('token=secret'))).includes('secret'), false);
});
