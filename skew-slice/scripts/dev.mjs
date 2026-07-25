import { spawn } from 'node:child_process';

const procs = [
  ['server', 'npm', ['run', 'dev:server']],
  ['client', 'npm', ['run', 'dev:client']],
].map(([tag, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const pipe = (s, stream) => s.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => stream.write(`[${tag}] ${l}\n`)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  return p;
});

const die = () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', die);
process.on('SIGTERM', die);
