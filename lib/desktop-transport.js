import { spawn } from 'node:child_process';

// A fixed command through Jim's existing authorized SSH connection. No shell
// interpolation of jobs, no exported SSH key, and no public control listener.
export function sshQueue(config, action, input = {}) {
  if (!['claim', 'finish', 'status', 'check', 'resume'].includes(action) || !/^[a-f0-9]{40}$/.test(config.queueRelease || '')) throw new Error('QUEUE_CONFIG_INVALID');
  const release = `/srv/georgia-wood-tools-publisher/releases/${config.queueRelease}`;
  // SSH enters root's home; jim cannot launch lock helpers from that directory.
  const command = `cd ${release} && /usr/sbin/runuser -u jim -- /usr/bin/node ${release}/lib/desktop-queue-cli.js ${action} --state /var/lib/georgia-wood-tools-publisher/desktop-queue.json`;
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', 'hostinger', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), 25000);
    child.stderr.resume();
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 32768) child.kill('SIGTERM'); });
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : undefined; };
    child.on('error', () => finish(new Error('DESKTOP_OFFLINE')));
    child.on('close', code => {
      if (settled) return;
      let result;
      try { result = JSON.parse(output); } catch { return finish(new Error('DESKTOP_OFFLINE')); }
      if (code !== 0 || result?.ok !== true) return finish(new Error(/^QUEUE_[A-Z_]+$/.test(result?.code) ? result.code : 'DESKTOP_OFFLINE'));
      settled = true; clearTimeout(timer); resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
