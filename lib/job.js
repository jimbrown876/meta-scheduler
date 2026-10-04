import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dayPaths } from './account.js';

export function jobFingerprint(entry, account) {
  const paths = entry.day ? dayPaths(account, entry.day) : { imagesDir: resolve(entry.images), captionFile: resolve(entry.caption) };
  const startLine = entry.captionStartLine ?? account.captionStartLine ?? 5;
  if (!Number.isSafeInteger(startLine) || startLine < 1) throw new Error('Caption start line must be a positive integer.');
  const captionBytes = readFileSync(paths.captionFile);
  const lines = captionBytes.toString('utf8').split('\n').slice(startLine - 1);
  const stop = lines.findIndex(line => line.trim() === '---');
  if (!(stop < 0 ? lines : lines.slice(0, stop)).join('\n').trim()) throw new Error('Caption cannot be empty.');
  const names = readdirSync(paths.imagesDir).filter(name => /\.(png|jpe?g|mp4|mov|m4v|webm)$/i.test(name)).sort();
  if (!names.length || names.some(name => !/\.(png|jpe?g)$/i.test(name))) throw new Error('Only nonempty image posts are verified in this fork.');
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ pageId: account.pageId, platforms: account.platforms, datetime: entry.datetime, timezone: account.timezone, captionStartLine: entry.captionStartLine ?? account.captionStartLine ?? 5 }));
  hash.update(captionBytes);
  for (const name of names) {
    hash.update(JSON.stringify(name)); hash.update(readFileSync(join(paths.imagesDir, name)));
  }
  return hash.digest('hex');
}
