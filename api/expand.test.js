/* npm test: новое поле displayName живёт с двумя версиями. Старая версия его не знает, новая не требует */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.QUEST_QUIET = '1';
process.env.QUEST_ORIGINS = 'http://localhost:5191';
const { start } = await import('./index.js');
const { Db } = await import('./db.js');
const { publicUser } = await import('./auth.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofera-expand-'));
const file = path.join(dir, 'db.json');
let app;
let base;

before(async () => {
  app = start({ port: 0, file });
  await new Promise((resolve) => app.server.once('listening', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.db.flush();
  app.server.close();
  app.server.closeAllConnections();
  fs.rmSync(dir, { recursive: true, force: true });
});

const login = async () => (await (await fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5191' },
  body: JSON.stringify({ login: 'junior', password: 'junior' }),
})).json()).accessToken;
const rename = (token, displayName) => fetch(`${base}/me/display-name`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5191', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ displayName }),
});

test('строка без поля отвечает логином: так выглядит база сразу после выкатки', () => {
  const user = publicUser({ login: 'junior', achievements: [], plan: 'free' });
  assert.equal(user.displayName, 'junior');
});

test('поле пишется, неверное значение — 422', async () => {
  const token = await login();
  assert.equal((await rename(token, 'x')).status, 422);
  const res = await rename(token, 'Младший');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.displayName, 'Младший');
});

test('откат не теряет поле: строка сохраняется целиком вместе с тем, чего версия не знает', () => {
  app.db.flush();
  const reopened = Db.open(file, () => { throw new Error('файл должен быть'); });
  const row = [...reopened.table('users').values()].find((u) => u.login === 'junior');
  assert.equal(row.displayName, 'Младший');
  reopened.tables.users.set(row.id, { ...row, cookies: row.cookies + 1 });
  assert.equal(reopened.dump().tables.users.find((u) => u.login === 'junior').displayName, 'Младший');
});
