import { openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, fsyncSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function readState(path, initial) {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(initial);
    throw error; // Corrupt or symlinked state must never become an empty history.
  }
}

export function writeState(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function withLock(path, action) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Runner lock exists: ${path}. Check the previous process and reconcile pending operations before manually removing it.`);
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fsyncSync(fd);
    return await action();
  } finally { closeSync(fd); unlinkSync(path); }
}
