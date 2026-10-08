import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { validateConfig } from './config.mjs';
import { publicError } from './errors.mjs';
import { openBrowser } from './browser.mjs';
import { capturePage } from './capture.mjs';
import { buildPdf } from './export.mjs';
import { resumeJob, runJob } from './job.mjs';
import { createJobController } from './controller.mjs';

try {
  const args = process.argv.slice(2);
  const resumeIndex = args.indexOf('--resume');
  const resumeFrom = resumeIndex >= 0 ? path.resolve(args[resumeIndex + 1] ?? '') : null;
  if (resumeIndex >= 0 && !args[resumeIndex + 1]) throw new Error('Supply a run directory after --resume.');
  const configArg = resumeIndex >= 0
    ? args.find((_, index) => index !== resumeIndex && index !== resumeIndex + 1)
    : args[0];
  const configPath = path.resolve(configArg ?? 'capture.config.json');
  const config = validateConfig(JSON.parse(await fs.readFile(configPath, 'utf8')), path.dirname(configPath));
  const dependencies = { openBrowser, capturePage, buildPdf,
    onResult: result => console.log(`${result.index}: ${result.status}${result.error ? ` (${result.error.code})` : ''}`) };
  let prompt;
  let promptChain = Promise.resolve();
  const controller = createJobController({ onEvent: event => {
    if (event.type !== 'user-action-required') return;
    promptChain = promptChain.then(async () => {
      prompt ??= createInterface({ input: stdin, output: stdout });
      await prompt.question(`\n${event.reason}: resolve this manually in the capture browser, then press Enter to verify access (Ctrl+C cancels). `);
      controller.resume();
    });
  } });
  const cancel = () => controller.cancel();
  process.once('SIGINT', cancel);
  let outcome;
  try {
    outcome = resumeFrom
      ? await resumeJob(resumeFrom, config, dependencies, { controller })
      : await runJob(config, dependencies, { controller });
    await promptChain;
  } finally {
    process.off('SIGINT', cancel);
    prompt?.close();
  }
  const { runDir, report } = outcome;
  console.log(`${report.lifecycle.toUpperCase()}: ${JSON.stringify(report.counts)}`);
  console.log(`Discovered: ${report.discovered}; attempted: ${report.attempted}; pending: ${report.pending}; limited: ${report.limited}`);
  if (report.limits.length) console.log(`Limits reached: ${report.limits.join(', ')}`);
  console.log(`Results: ${runDir}`);
  process.exitCode = report.exitCode;
} catch (error) {
  const safe = publicError(error);
  console.error(`${safe.code}: ${safe.message}`);
  process.exitCode = 1;
}
