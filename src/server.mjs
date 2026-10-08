import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ZipArchive } from 'archiver';
import { buildPdf } from './export.mjs';
import { capturePage } from './capture.mjs';
import { openBrowser } from './browser.mjs';
import { createJobController } from './controller.mjs';
import { validateConfig } from './config.mjs';
import { CaptureError, publicError } from './errors.mjs';
import { parseHttpUrl } from './url.mjs';
import { runJob } from './job.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

function normalizeUrlInput(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function isSameLoopback(hostname) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname || '');
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return isSameLoopback(parsed.hostname);
  } catch {
    return false;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function getActionName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function safeRelativeArtifact(runDir, input) {
  if (typeof input !== 'string') throw new CaptureError('INVALID_ARTIFACT_PATH', 'Artifact path is required.');
  const trimmed = input.trim();
  if (!trimmed || trimmed === '.' || trimmed.includes('\0')) throw new CaptureError('INVALID_ARTIFACT_PATH', 'Artifact path is invalid.');
  const normalized = path.normalize(trimmed).replace(/\\/g, '/');
  const relative = normalized.startsWith('/') ? normalized.slice(1) : normalized;
  if (relative === '..' || relative.startsWith('../') || relative.startsWith('..\\')) {
    throw new CaptureError('INVALID_ARTIFACT_PATH', 'Artifact path must stay inside the run directory.');
  }
  const fullPath = path.resolve(runDir, relative);
  const runRoot = `${path.resolve(runDir)}${path.sep}`;
  if (!fullPath.startsWith(path.resolve(runDir)) || (fullPath !== path.resolve(runDir) && !fullPath.startsWith(runRoot))) {
    throw new CaptureError('INVALID_ARTIFACT_PATH', 'Artifact path must stay inside the run directory.');
  }
  return fullPath;
}

async function listDownloadFiles(runDir) {
  const files = [];
  const addFile = async relativePath => {
    const fullPath = safeRelativeArtifact(runDir, relativePath);
    const info = await fs.lstat(fullPath);
    if (info.isFile()) files.push({ fullPath, relativePath: relativePath.split(path.sep).join('/') });
  };

  await addFile('manifest.json');
  try {
    await addFile('archive.pdf');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const walkScreenshots = async (directory, relativeDirectory) => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' && relativeDirectory === 'screenshots') return;
      throw error;
    }
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const fullPath = safeRelativeArtifact(runDir, relativePath);
      if (entry.isDirectory()) {
        await walkScreenshots(fullPath, relativePath);
      } else if (entry.isFile()) {
        await addFile(relativePath);
      }
    }
  };
  await walkScreenshots(path.join(runDir, 'screenshots'), 'screenshots');
  return files;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CaptureError('INVALID_JSON', 'Request body must be valid JSON.');
  }
}

async function servePublicFile(res, fileName) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  const content = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  };
  res.writeHead(200, {
    'Content-Type': types[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  res.end(content);
}

function getJobState(job) {
  const report = job.report ?? {};
  const lifecycle = job.lifecycle ?? report.lifecycle ?? 'running';
  return {
    jobId: job.id,
    url: job.url,
    lifecycle,
    status: report.status ?? job.status ?? 'running',
    activity: job.activity ?? 'Starting',
    counts: report.counts ?? { captured: 0, partial: 0, failed: 0, blocked: 0, skipped: 0, limited: 0 },
    discovered: report.discovered ?? 0,
    attempted: report.attempted ?? 0,
    pending: report.pending ?? 0,
    planned: report.planned ?? 0,
    limited: report.limited ?? 0,
    manualAccess: !!(report.events && report.events.some(event => event.type === 'user-action-required')) || job.manualAccess,
    downloadAvailable: !!job.runDir && ['complete', 'incomplete', 'cancelled', 'failed'].includes(lifecycle),
    results: Array.isArray(report.results) ? report.results : [],
    pdf: report.pdf ?? null,
    exportError: report.exportError ?? null,
    error: report.fatalError ?? null,
    events: job.events.slice(-25)
  };
}

export async function startServer(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const outputDir = options.outputDir ?? path.resolve(process.cwd(), 'captures');
  const engine = options.engine ?? { runJob };
  const jobs = new Map();
  const servers = new Map();

  const ensureJob = jobId => {
    const job = jobs.get(jobId);
    if (!job) throw new CaptureError('JOB_NOT_FOUND', 'The requested job was not found.');
    return job;
  };

  const emitJobEvent = (jobId, event) => {
    const job = jobs.get(jobId);
    if (!job) return;
    const record = { ...event, timestamp: event.timestamp ?? new Date().toISOString() };
    job.events.push(record);
    job.activity = record.type ?? job.activity ?? 'Running';
    if (record.type === 'user-action-required') {
      job.manualAccess = true;
      job.lifecycle = 'waiting-for-user-action';
      job.status = 'waiting-for-user-action';
    }
    if (record.type === 'job-finished' || record.type === 'page-finished') {
      job.activity = record.type === 'job-finished' ? 'Complete' : 'Processing results';
    }
    for (const stream of job.streams) {
      stream.write(`event: job-event\ndata: ${JSON.stringify({ jobId, event: record })}\n\n`);
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
      const origin = req.headers.origin;
      if (origin && !isAllowedOrigin(origin)) {
        sendJson(res, 403, { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin requests are not allowed for capture control endpoints.' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, status: 'ready', host, port });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        await servePublicFile(res, 'index.html');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/styles.css') {
        await servePublicFile(res, 'styles.css');
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const body = await readBody(req);
        const inputUrl = body.url;
        const normalized = normalizeUrlInput(inputUrl);
        if (!normalized) {
          sendJson(res, 400, { code: 'INVALID_URL', message: 'Enter a valid HTTP or HTTPS website URL.' });
          return;
        }
        const existing = [...jobs.values()].find(job => ['running', 'paused', 'waiting-for-user-action', 'cancelling'].includes(job.lifecycle ?? 'running'));
        if (existing) {
          sendJson(res, 409, { code: 'JOB_ALREADY_RUNNING', message: 'A capture job is already running. Wait for it to finish or cancel it first.' });
          return;
        }
        const parsed = parseHttpUrl(normalized);
        const config = validateConfig({ startUrl: parsed.href, outputDir, buildPdf: true, discovery: { enabled: true }, exploration: { enabled: true } }, process.cwd());
        const jobId = randomUUID();
        const job = {
          id: jobId,
          url: parsed.href,
          lifecycle: 'running',
          status: 'running',
          activity: 'Starting',
          runDir: null,
          report: null,
          manualAccess: false,
          events: [],
          streams: new Set(),
          controller: createJobController({ onEvent: event => emitJobEvent(jobId, event) })
        };
        jobs.set(jobId, job);

        const start = async () => {
          try {
            const result = await engine.runJob(config, {
              openBrowser,
              capturePage,
              buildPdf,
              onResult: report => {
                job.report = report;
                job.activity = report.status;
              }
            }, { controller: job.controller, onEvent: event => emitJobEvent(jobId, event) });
            job.runDir = result.runDir;
            job.report = result.report;
            job.lifecycle = result.report.lifecycle;
            job.status = result.report.status;
            job.activity = result.report.lifecycle;
            emitJobEvent(jobId, { type: 'job-finished', lifecycle: result.report.lifecycle, status: result.report.status, timestamp: new Date().toISOString() });
            return result;
          } catch (error) {
            const safe = publicError(error);
            job.report = { lifecycle: 'incomplete', status: 'incomplete', counts: { captured: 0, partial: 0, failed: 0, blocked: 0, skipped: 0, limited: 0 }, ...safe };
            job.lifecycle = 'incomplete';
            job.status = 'incomplete';
            const event = { type: 'job-failed', code: safe.code, message: safe.message, lifecycle: 'incomplete', timestamp: new Date().toISOString() };
            emitJobEvent(jobId, event);
            return { jobId, report: job.report };
          }
        };

        job.promise = start();
        sendJson(res, 202, { jobId, lifecycle: 'running', status: 'created', url: parsed.href, message: 'Capture started.' });
        return;
      }

      const jobMatch = /^\/api\/jobs\/([^/]+)(?:$|\/)/.exec(url.pathname);
      if (!jobMatch && (req.method === 'POST' || req.method === 'GET')) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'The requested route was not found.' }));
        return;
      }

      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]);
        const job = ensureJob(jobId);

        if (req.method === 'GET' && url.pathname === `/api/jobs/${jobId}`) {
          const report = job.report ?? { lifecycle: job.lifecycle ?? 'running', status: job.status ?? 'running', counts: { captured: 0, partial: 0, failed: 0, blocked: 0, skipped: 0, limited: 0 }, discovered: 0, pending: 0, results: [], events: job.events.slice(-20) };
          const payload = { ...getJobState(job), report, manualAccess: job.manualAccess || report.lifecycle === 'waiting-for-user-action', active: !job.report || job.lifecycle === 'running' || job.lifecycle === 'paused' || job.lifecycle === 'waiting-for-user-action' };
          sendJson(res, 200, payload);
          return;
        }

        if (req.method === 'GET' && url.pathname === `/api/jobs/${jobId}/events`) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
          });
          res.write(`event: snapshot\ndata: ${JSON.stringify(getJobState(job))}\n\n`);
          job.streams.add(res);
          req.on('close', () => job.streams.delete(res));
          return;
        }

        if (req.method === 'GET' && url.pathname === `/api/jobs/${jobId}/archive.zip`) {
          if (!job.runDir || !job.report || ['running', 'paused', 'waiting-for-user-action', 'cancelling'].includes(job.lifecycle)) {
            sendJson(res, 409, { code: 'RESULTS_NOT_READY', message: 'Results can be downloaded after the capture job has finished.' });
            return;
          }
          const files = await listDownloadFiles(job.runDir);
          const archive = new ZipArchive({ zlib: { level: 6 } });
          archive.on('warning', error => archive.emit('error', error));
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="website-capture-${jobId}.zip"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
          });
          try {
            const streaming = pipeline(archive, res);
            for (const file of files) archive.file(file.fullPath, { name: file.relativePath });
            await archive.finalize();
            await streaming;
          } catch (error) {
            if (res.headersSent) res.destroy(error);
            else sendJson(res, 500, { code: 'ARCHIVE_FAILED', message: 'The result archive could not be created.' });
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === `/api/jobs/${jobId}/artifacts`) {
          const artifact = url.searchParams.get('path');
          if (!artifact) {
            sendJson(res, 400, { code: 'INVALID_ARTIFACT_PATH', message: 'An artifact path is required.' });
            return;
          }
          try {
            const runDir = job.runDir ?? path.join(outputDir, `${jobId}-run`);
            const fullPath = safeRelativeArtifact(runDir, artifact);
            const resolved = await fs.readFile(fullPath);
            const extension = path.extname(fullPath).toLowerCase();
            const mime = {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.gif': 'image/gif',
              '.webp': 'image/webp',
              '.pdf': 'application/pdf',
              '.json': 'application/json',
              '.html': 'text/html; charset=utf-8'
            };
            res.writeHead(200, {
              'Content-Type': mime[extension] ?? 'application/octet-stream',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff'
            });
            res.end(resolved);
            return;
          } catch (error) {
            const safe = error instanceof CaptureError ? error : new CaptureError('INVALID_ARTIFACT_PATH', 'The requested artifact is unavailable or not allowed.');
            sendJson(res, 400, publicError(safe));
            return;
          }
        }

        if (req.method === 'POST' && url.pathname === `/api/jobs/${jobId}/control`) {
          const body = await readBody(req);
          const action = getActionName(body.action);
          if (!['pause', 'resume', 'cancel', 'continue'].includes(action)) {
            sendJson(res, 400, { code: 'INVALID_ACTION', message: 'Supported actions are pause, resume, cancel and continue.' });
            return;
          }

          if (action === 'pause') {
            const paused = job.controller.pause();
            sendJson(res, paused ? 200 : 409, { jobId, action, lifecycle: job.controller.getState(), message: paused ? 'Capture paused.' : 'The job cannot be paused in its current state.' });
            return;
          }

          if (action === 'resume') {
            const resumed = job.controller.resume();
            sendJson(res, resumed ? 200 : 409, { jobId, action, lifecycle: job.controller.getState(), message: resumed ? 'Capture resumed.' : 'The job was not paused or waiting for user action.' });
            return;
          }

          if (action === 'continue') {
            const continued = job.controller.resume();
            sendJson(res, continued ? 200 : 409, { jobId, action, lifecycle: job.controller.getState(), message: continued ? 'Manual access was cleared.' : 'The job was not waiting for manual verification.' });
            return;
          }

          const cancelled = job.controller.cancel();
          sendJson(res, cancelled ? 200 : 409, { jobId, action, lifecycle: job.controller.getState(), message: cancelled ? 'Capture cancellation requested.' : 'The job cannot be cancelled in its current state.' });
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'The requested resource was not found.' }));
    } catch (error) {
      const safe = publicError(error);
      sendJson(res, safe.code === 'INVALID_JSON' ? 400 : safe.status === 'blocked' ? 403 : 500, safe);
    }
  });

  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const portNumber = typeof address === 'object' && address ? address.port : port;
  const baseUrl = `http://${host}:${portNumber}`;

  return {
    server,
    jobs,
    host,
    port: portNumber,
    baseUrl,
    close: async () => new Promise(resolve => server.close(resolve))
  };
}

export async function createUiServer(options = {}) {
  const server = await startServer(options);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const normalized = process.argv[2] ? Number.parseInt(process.argv[2], 10) : DEFAULT_PORT;
  const host = process.argv[3] ?? DEFAULT_HOST;
  const server = await startServer({ host, port: Number.isFinite(normalized) ? normalized : DEFAULT_PORT, outputDir: path.resolve(process.cwd(), 'captures') });
  console.log(`Website capture UI is running at ${server.baseUrl}`);
}
