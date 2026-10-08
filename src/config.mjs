import path from 'node:path';
import { CaptureError } from './errors.mjs';
import { inScope, parseHttpUrl, urlKey } from './url.mjs';

function invalid(message) { throw new CaptureError('INVALID_CONFIG', message); }
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) invalid(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
export function validateConfig(input, baseDir = process.cwd()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Configuration must be an object.');
  const known = new Set(['startUrl', 'urls', 'scopePath', 'outputDir', 'capturePng', 'buildPdf', 'readinessSelector', 'timeoutMs', 'imageTimeoutMs', 'viewport', 'browser', 'discovery', 'exploration', 'retry', 'access']);
  for (const key of Object.keys(input)) if (!known.has(key)) invalid(`Unknown configuration field: ${key}`);
  const startUrl = urlKey(input.startUrl);
  const scopePath = input.scopePath ?? '/';
  if (typeof scopePath !== 'string' || !scopePath.startsWith('/') || /[?#\\]/.test(scopePath)) invalid('scopePath must be an absolute URL path.');
  if (!inScope(startUrl, startUrl, scopePath)) invalid('The starting URL is outside scopePath.');
  if (input.urls !== undefined && !Array.isArray(input.urls)) invalid('urls must be an array.');
  const urls = [...new Set([startUrl, ...(input.urls ?? []).map(urlKey)])];
  if (urls.some(url => !inScope(url, startUrl, scopePath))) invalid('All targets must be within the starting origin and scopePath.');
  const capturePng = input.capturePng ?? true;
  const buildPdf = input.buildPdf ?? true;
  if (typeof capturePng !== 'boolean' || typeof buildPdf !== 'boolean') invalid('Output options must be booleans.');
  if (!capturePng) invalid('Stage 1 requires PNG capture; PDF generation depends on fresh PNG files.');
  const readinessSelector = input.readinessSelector ?? 'body';
  if (typeof readinessSelector !== 'string' || !readinessSelector.trim()) invalid('readinessSelector must be a nonempty CSS selector.');
  const outputDir = input.outputDir ?? 'captures';
  if (typeof outputDir !== 'string' || !outputDir.trim()) invalid('outputDir must be a path.');
  const viewport = input.viewport ?? { width: 1440, height: 1000 };
  if (!viewport || typeof viewport !== 'object') invalid('viewport must be an object.');
  integer(viewport.width, 'viewport.width', 320, 3840);
  integer(viewport.height, 'viewport.height', 240, 2160);
  const browser = { mode: 'launch', headless: false, ...input.browser };
  if (!['launch', 'attach'].includes(browser.mode)) invalid('browser.mode must be launch or attach.');
  if (typeof browser.headless !== 'boolean') invalid('browser.headless must be a boolean.');
  if (browser.channel !== undefined && !['chromium', 'chrome', 'msedge'].includes(browser.channel)) invalid('Unsupported browser channel.');
  if (browser.mode === 'attach') {
    const endpoint = parseHttpUrl(browser.endpoint);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.search || endpoint.hash || endpoint.pathname !== '/') invalid('Use a local browser debugging endpoint without a path or query.');
    browser.endpoint = endpoint.href;
  }
  if (input.discovery !== undefined && (!input.discovery || typeof input.discovery !== 'object' || Array.isArray(input.discovery))) invalid('discovery must be an object.');
  const discovery = { enabled: true, maxPages: 50, maxDepth: 3, maxDurationMs: 120000, maxLinksPerPage: 500, maxControlsPerPage: 100, ...input.discovery };
  const discoveryKeys = ['enabled', 'maxPages', 'maxDepth', 'maxDurationMs', 'maxLinksPerPage', 'maxControlsPerPage'];
  for (const key of Object.keys(discovery)) if (!discoveryKeys.includes(key)) invalid(`Unknown discovery field: ${key}`);
  if (typeof discovery.enabled !== 'boolean') invalid('discovery.enabled must be a boolean.');
  integer(discovery.maxPages, 'discovery.maxPages', 1, 1000);
  integer(discovery.maxDepth, 'discovery.maxDepth', 0, 20);
  integer(discovery.maxDurationMs, 'discovery.maxDurationMs', 100, 3600000);
  integer(discovery.maxLinksPerPage, 'discovery.maxLinksPerPage', 1, 2000);
  integer(discovery.maxControlsPerPage, 'discovery.maxControlsPerPage', 1, 200);
  if (urls.length > discovery.maxPages) invalid('Explicit targets exceed discovery.maxPages.');
  if (input.exploration !== undefined && (!input.exploration || typeof input.exploration !== 'object' || Array.isArray(input.exploration))) invalid('exploration must be an object.');
  const explorationDefaults = { enabled: true, maxStates: 8, maxStateDepth: 3, maxScrollSteps: 20, maxScrollRegions: 4, maxFullPageHeight: 12000, maxDurationMs: 60000, settleTimeoutMs: 1200, settleIntervalMs: 100, paginationSelectors: [] };
  const exploration = { ...explorationDefaults, ...input.exploration };
  for (const key of Object.keys(exploration)) if (!(key in explorationDefaults)) invalid(`Unknown exploration field: ${key}`);
  if (typeof exploration.enabled !== 'boolean') invalid('exploration.enabled must be a boolean.');
  integer(exploration.maxStates, 'exploration.maxStates', 1, 50);
  integer(exploration.maxStateDepth, 'exploration.maxStateDepth', 1, 10);
  integer(exploration.maxScrollSteps, 'exploration.maxScrollSteps', 1, 100);
  integer(exploration.maxScrollRegions, 'exploration.maxScrollRegions', 0, 10);
  integer(exploration.maxFullPageHeight, 'exploration.maxFullPageHeight', 1000, 20000);
  integer(exploration.maxDurationMs, 'exploration.maxDurationMs', 100, 600000);
  integer(exploration.settleTimeoutMs, 'exploration.settleTimeoutMs', 100, 10000);
  integer(exploration.settleIntervalMs, 'exploration.settleIntervalMs', 25, 1000);
  if (exploration.settleTimeoutMs < exploration.settleIntervalMs * 2) invalid('settleTimeoutMs must allow at least two stability intervals.');
  if (!Array.isArray(exploration.paginationSelectors) || exploration.paginationSelectors.some(value => typeof value !== 'string' || !value.trim()) || exploration.paginationSelectors.length > 20) invalid('paginationSelectors must contain at most 20 nonempty CSS selectors.');
  if (input.retry !== undefined && (!input.retry || typeof input.retry !== 'object' || Array.isArray(input.retry))) invalid('retry must be an object.');
  const retry = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10000, ...input.retry };
  for (const key of Object.keys(retry)) if (!['maxAttempts', 'baseDelayMs', 'maxDelayMs'].includes(key)) invalid(`Unknown retry field: ${key}`);
  integer(retry.maxAttempts, 'retry.maxAttempts', 1, 5);
  integer(retry.baseDelayMs, 'retry.baseDelayMs', 0, 30000);
  integer(retry.maxDelayMs, 'retry.maxDelayMs', 0, 60000);
  if (retry.maxDelayMs < retry.baseDelayMs) invalid('retry.maxDelayMs must be at least retry.baseDelayMs.');
  if (input.access !== undefined && (!input.access || typeof input.access !== 'object' || Array.isArray(input.access))) invalid('access must be an object.');
  const access = {
    loginSelectors: ['input[type="password"]'],
    deniedSelectors: ['[data-access-denied]'],
    challengeSelectors: ['iframe[src*="captcha" i]', '[class*="captcha" i]', '[id*="captcha" i]', '[data-sitekey]'],
    ...input.access
  };
  for (const key of Object.keys(access)) if (!['loginSelectors', 'deniedSelectors', 'challengeSelectors'].includes(key)) invalid(`Unknown access field: ${key}`);
  for (const [name, selectors] of Object.entries(access)) {
    if (!Array.isArray(selectors) || selectors.length > 20 || selectors.some(value => typeof value !== 'string' || !value.trim())) {
      invalid(`access.${name} must contain at most 20 nonempty CSS selectors.`);
    }
  }
  return { startUrl, urls, scopePath, outputDir: path.resolve(baseDir, outputDir), capturePng, buildPdf, readinessSelector, discovery, exploration,
    timeoutMs: integer(input.timeoutMs ?? 15000, 'timeoutMs', 100, 120000),
    imageTimeoutMs: integer(input.imageTimeoutMs ?? 5000, 'imageTimeoutMs', 100, 60000), viewport, browser, retry, access };
}
