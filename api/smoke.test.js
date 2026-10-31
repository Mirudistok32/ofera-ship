/* npm test: сервер поднимается на временной базе и отвечает на главное. В образ не попадает (.dockerignore) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

process.env.QUEST_QUIET = '1';
process.env.QUEST_ORIGINS = 'http://localhost:5191';
const { start } = await import('./index.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofera-test-'));
let app;
let base;

before(async () => {
  app = start({ port: 0, file: path.join(dir, 'db.json') });
  await new Promise((resolve) => app.server.once('listening', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.db.flush();
  app.server.close();
  app.server.closeAllConnections();
  fs.rmSync(dir, { recursive: true, force: true });
});

const login = (password) => fetch(`${base}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5191' },
  body: JSON.stringify({ login: 'junior', password }),
});

test('/health и /ready отвечают', async () => {
  for (const url of ['/health', '/ready']) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 201);
    assert.equal((await res.json()).ok, true);
  }
});

test('база не отвечает: /ready — 503, /health — 200', async () => {
  const { run } = app.db;
  app.db.run = () => Promise.reject(new Error('база упала'));
  try {
    assert.equal((await fetch(`${base}/ready`)).status, 503);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    app.db.run = run;
  }
  assert.equal((await fetch(`${base}/ready`)).status, 200);
});

test('верный пароль даёт токен и cookie, недоступную скриптам', async () => {
  const res = await login('junior');
  assert.equal(res.status, 200);
  assert.ok((await res.json()).accessToken);
  assert.match(res.headers.get('set-cookie'), /HttpOnly/i);
});

test('неверный пароль не пускает', async () => {
  const res = await login('нет');
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, 'BAD_CREDENTIALS');
});

test('чужой origin не получает CORS-заголовков', async () => {
  const res = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});
