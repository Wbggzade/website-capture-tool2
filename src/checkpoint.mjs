import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CaptureError } from './errors.mjs';

export const CHECKPOINT_VERSION = 1;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => !(key === 'endpoint' && value.mode === 'attach'))
      .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function configFingerprint(config) {
  return createHash('sha256').update(stable(config)).digest('hex');
}

export async function atomicWrite(filename, contents, mode = 0o600) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, contents, { mode });
    await fs.rename(temp, filename);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeCheckpoint(runDir, checkpoint) {
  const filename = path.join(runDir, 'checkpoint.json');
  await atomicWrite(filename, JSON.stringify({ version: CHECKPOINT_VERSION, ...checkpoint }, null, 2));
}

export async function readCheckpoint(runDir, config) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(path.join(runDir, 'checkpoint.json'), 'utf8'));
  } catch {
    throw new CaptureError('CHECKPOINT_UNREADABLE', 'The private resume checkpoint is missing or corrupt.');
  }
  if (data?.version !== CHECKPOINT_VERSION || !data.privateConfig || typeof data.privateConfig !== 'object' ||
      !Array.isArray(data.queue?.items) ||
      !Array.isArray(data.queue?.edges) || !Array.isArray(data.results) || !Array.isArray(data.attemptHistory)) {
    throw new CaptureError('CHECKPOINT_INCOMPATIBLE', 'The resume checkpoint version or structure is not supported.');
  }
  if (data.configFingerprint !== configFingerprint(config)) {
    throw new CaptureError('CHECKPOINT_CONFIG_MISMATCH', 'The supplied configuration does not match this checkpoint.');
  }
  const ids = new Set();
  for (const item of data.queue.items) {
    if (!Number.isInteger(item.id) || item.id < 1 || ids.has(item.id) ||
        typeof item.key !== 'string' || !['pending', 'running', 'captured', 'partial', 'failed', 'blocked', 'skipped', 'limited'].includes(item.status)) {
      throw new CaptureError('CHECKPOINT_INCOMPATIBLE', 'The checkpoint contains invalid queue items.');
    }
    ids.add(item.id);
  }
  return data;
}
