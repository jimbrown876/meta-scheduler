// meta-scheduler — Made by Antonio Automates and Claude to help you get your time back.
// MIT licensed. See LICENSE.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

export function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export function loadAccount(accountName) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(accountName || '')) throw new Error('Invalid account name.');
  const path = join(projectRoot, 'accounts', `${accountName}.json`);
  if (!existsSync(path)) {
    throw new Error(`Account "${accountName}" not found at ${path}. Create it under accounts/ to onboard a new client.`);
  }
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  if (cfg.name !== accountName) throw new Error('Account filename and name must match.');
  if (!cfg.timezone) throw new Error('Account timezone is required.');
  new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone });
  cfg.profileDir = expandHome(`~/Library/Application Support/playwright-meta-scheduler/${cfg.name}`);
  cfg.carouselsRoot = resolve(projectRoot, cfg.carouselsRoot);
  cfg.stateFile = join(projectRoot, 'state', `${cfg.name}.batch-state.json`);
  cfg.screenshotsDir = join(projectRoot, 'screenshots', cfg.name);
  // composerUrl can be overridden per account to pin a specific business_id + asset_id
  // (Meta otherwise honors a server-side "current business" that drifts across sessions).
  if (!cfg.composerUrl) cfg.composerUrl = 'https://business.facebook.com/latest/composer/';
  if (!cfg.businessSuiteUrl) cfg.businessSuiteUrl = 'https://business.facebook.com/';
  return cfg;
}

export function dayPaths(account, dayNum) {
  if (!/^\d{1,4}$/.test(String(dayNum))) throw new Error('Day must be a positive integer.');
  const day = String(dayNum).padStart(2, '0');
  return {
    imagesDir: join(account.carouselsRoot, account.imagesSubpath.replace('{day}', day)),
    captionFile: join(account.carouselsRoot, account.captionSubpath.replace('{day}', day)),
    captionStartLine: account.captionStartLine,
  };
}
