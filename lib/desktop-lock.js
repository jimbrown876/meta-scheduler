import { spawn } from 'node:child_process';
import { openSync, closeSync, fstatSync, mkdirSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLock } from './durable-state.js';

const holder = fileURLToPath(new URL('./desktop-lock-holder.js', import.meta.url));

// Hold an OS advisory lock on a permanent inode. A private stdin pipe ties the
// holder lifetime to this process: even SIGKILL closes the pipe and releases it.
// Keeping the inode avoids unlink/reacquire races; no PID-based lock stealing.
export async function withAdvisoryLock(path, action) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const st = fstatSync(fd);
  if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077)) { closeSync(fd); throw new Error('STATE_NOT_PRIVATE'); }
  const mac = process.platform === 'darwin';
  const child = spawn(mac ? '/usr/bin/lockf' : '/usr/bin/flock', [...(mac ? ['-k', '-s', '-t', '0'] : ['-n', '-E', '75']), '/dev/fd/3', process.execPath, holder], { stdio: ['pipe', 'pipe', 'pipe', fd] });
  closeSync(fd);
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => child.once('close', resolve));
  let acquired = false;
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      child.once('error', () => reject(new Error('DESKTOP_LOCK_UNAVAILABLE')));
      child.once('close', code => { if (!acquired) reject(new Error(code === 75 ? 'Runner lock exists: active process.' : 'DESKTOP_LOCK_UNAVAILABLE')); });
      child.stdout.on('data', data => {
        output += data;
        if (!acquired && output === 'LOCKED\n') { acquired = true; resolve(); }
      });
    });
    return await action();
  } finally {
    child.stdin.end();
    await closed;
  }
}

export function withPublisherLock(path, config, action) {
  return config.browserMode === 'extension' ? withAdvisoryLock(`${path}.advisory`, action) : withLock(path, action);
}
