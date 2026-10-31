/* Ключи стендов и поиск секретов. Значения ключей и найденных секретов на экран не попадают.
   npm run secrets:init            — создать secrets/<стенд>.jwt, которых нет; существующие не трогает
   npm run secrets:rotate -- prod  — новый ключ стенду. Затем docker compose up -d --force-recreate api
   npm run secrets:scan            — вся история git; -- --staged — только то, что уходит в коммит */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'secrets');
const STANDS = ['dev', 'stage', 'prod'];
const SCANNER = 'zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';

/* Сначала временный файл: при сбое на полпути старый ключ останется целым */
function writeKey(stand) {
  const file = path.join(DIR, `${stand}.jwt`);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${crypto.randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function init() {
  for (const stand of STANDS) {
    const has = fs.existsSync(path.join(DIR, `${stand}.jwt`));
    if (!has) writeKey(stand);
    console.log(`${has ? '·' : '✓'} secrets/${stand}.jwt${has ? ' уже есть' : ''}`);
  }
}

function rotate(stand) {
  if (!STANDS.includes(stand)) {
    console.error(`Укажи стенд: npm run secrets:rotate -- ${STANDS.join(' | ')}`);
    return 2;
  }
  writeKey(stand);
  console.log(`✓ secrets/${stand}.jwt заменён. Применить: OFERA_STAND=${stand} docker compose up -d --force-recreate api`);
  return 0;
}

/* Сканер свой, если установлен, иначе образ с закреплённой версией. --verbose называет файл и коммит, --redact прячет значение */
function scan(staged) {
  const args = ['git', '--redact', '--verbose', '--no-banner', '--config', '.gitleaks.toml', ...(staged ? ['--staged'] : []), '.'];
  const local = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).status === 0;
  const docker = !local && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
  if (!local && !docker) {
    console.error('⚠ Сканер не запущен: нет gitleaks и не работает Docker. Коммит пропущен без проверки, поймает CI');
    return staged ? 0 : 2;
  }
  const run = local
    ? spawnSync('gitleaks', args, { cwd: ROOT, stdio: 'inherit' })
    : spawnSync('docker', ['run', '--rm', '-v', `${ROOT}:/repo:ro`, '-w', '/repo', '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=/repo', SCANNER, ...args], { stdio: 'inherit' });
  return run.status ?? 2;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'init') init();
else if (cmd === 'rotate') process.exitCode = rotate(arg);
else if (cmd === 'scan') process.exitCode = scan(arg === '--staged');
else {
  console.error('Команды: init, rotate <стенд>, scan [--staged]');
  process.exitCode = 2;
}
