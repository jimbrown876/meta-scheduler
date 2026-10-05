import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateQueue } from './desktop-queue.js';

export async function queueCli(args, input = process.stdin) {
  if (args.length !== 3 || args[1] !== '--state' || !args[2].startsWith('/') || !['enqueue', 'status', 'claim', 'finish', 'check', 'resume'].includes(args[0])) throw new Error('QUEUE_CONFIG_INVALID');
  const dir = lstatSync(dirname(args[2]));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw new Error('QUEUE_NOT_PRIVATE');
  let request = {};
  if (!['enqueue', 'status'].includes(args[0])) {
    let body = '';
    for await (const data of input) { body += data; if (body.length > 8192) throw new Error('QUEUE_REQUEST_TOO_LARGE'); }
    request = JSON.parse(body);
  }
  return updateQueue(args[2], args[0], request);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await queueCli(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: /^QUEUE_[A-Z_]+$/.test(error.message) ? error.message : 'QUEUE_UNAVAILABLE' }) + '\n'); process.exitCode = 1; }
}
