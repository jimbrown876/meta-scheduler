// Started only under lockf/flock. Parent death closes this private pipe even
// when no JS finally handler can run. Do not start subprocesses from here.
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdout.write('LOCKED\n');
