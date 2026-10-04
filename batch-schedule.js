#!/usr/bin/env node
// MIT; derived from arillera/meta-scheduler. See LICENSE.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadAccount } from './lib/account.js';
import { runBatch } from './lib/batch-core.js';
import { jobFingerprint } from './lib/job.js';
import { assertAccount, validateDatetime } from './lib/publishing-guards.js';

const { values } = parseArgs({ options: {
  account: { type: 'string', default: process.env.META_SCHEDULER_ACCOUNT || 'default' },
  plan: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  resume: { type: 'boolean' },
} });
if (values.help || !values.plan) {
  console.log('Usage: node batch-schedule.js --account NAME --plan plan.json [--dry-run]\nPlan IDs are required. All runs resume safely. No blind retry, range generation or implicit cross-posting.');
  process.exit(values.help ? 0 : 1);
}
try {
  const account = loadAccount(values.account);
  process.env.TZ = account.timezone;
  assertAccount(account, { live: !values['dry-run'] });
  const entries = JSON.parse(readFileSync(values.plan, 'utf8'));
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error('Expected a bounded JSON plan array.');
  for (const entry of entries) validateDatetime(entry.datetime);
  const results = await runBatch({ path: account.stateFile, entries, account, dryRun: values['dry-run'], fingerprint: entry => jobFingerprint(entry, account), run: entry => new Promise(resolve => {
    const args = ['schedule-post.js', '--account', account.name, '--datetime', entry.datetime, '--job-id', entry.id];
    if (entry.day) args.push('--day', String(entry.day));
    else args.push('--images', entry.images, '--caption', entry.caption);
    if (entry.captionStartLine) args.push('--caption-start-line', String(entry.captionStartLine));
    const child = spawn(process.execPath, args, { cwd: dirname(fileURLToPath(import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output = (output + data.toString()).slice(-65536); });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve({ status: 'failed_precommit' }));
    child.on('close', code => {
      const line = output.split('\n').filter(line => line.startsWith('META_RESULT ')).at(-1);
      try { const result = JSON.parse(line.slice(12)); resolve(code === 0 ? result : { status: 'uncertain' }); }
      catch { resolve({ status: 'uncertain' }); }
    });
  }) });
  console.log(JSON.stringify(results, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
