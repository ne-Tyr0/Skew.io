import { spawn } from 'node:child_process';

// `npm run dev -- --bots 6` fills the arena with AI players. Passed as an arg
// (not an env var) so it works the same on Windows and Unix shells.
const botArg = process.argv.indexOf('--bots');
const bots = botArg >= 0 ? (process.argv[botArg + 1] ?? '0') : '0';

const procs = [
  ['server', 'npm', ['run', 'dev:server'], { ...process.env, BOTS: bots }],
  ['client', 'npm', ['run', 'dev:client'], process.env],
].map(([tag, cmd, args, env]) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', env });
  const pipe = (s, stream) => s.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => stream.write(`[${tag}] ${l}\n`)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  return p;
});

const die = () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', die);
process.on('SIGTERM', die);
