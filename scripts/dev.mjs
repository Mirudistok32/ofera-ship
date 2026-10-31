/* npm run dev: api на :4010 и web на :5191 в одном терминале. Ctrl+C останавливает оба */
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (name, color) => {
  const p = spawn(npm, ['run', 'dev', '--prefix', name], { stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const out = (d) => process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => prefix + l).join('\n') + '\n');
  p.stdout.on('data', out);
  p.stderr.on('data', out);
  return p;
};
const procs = [run('api', 36), run('web', 35)];
const stop = () => {
  procs.forEach((p) => p.kill());
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
