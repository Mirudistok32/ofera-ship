/* npm test: откуда берётся ключ JWT и когда сервер отказывается стартовать */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadJwtSecret, signJwt, verifyJwt } from './auth.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofera-secret-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const fakeDb = (meta = {}) => ({ meta, setMeta(patch) { Object.assign(this.meta, patch); } });
const keyFile = (name, text) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};
const NONE = path.join(dir, 'none');
const KEY = 'k'.repeat(43);

test('файл ключа важнее базы, ключ из базы стирается', () => {
  const db = fakeDb({ jwtSecret: 'старый ключ из базы' });
  assert.equal(loadJwtSecret(db, { file: keyFile('jwt', `${KEY}\n`), env: 'production' }), KEY);
  assert.equal(db.meta.jwtSecret, undefined);
});

test('в production без файла сервер не стартует, даже если ключ есть в базе', () => {
  assert.throws(() => loadJwtSecret(fakeDb({ jwtSecret: KEY }), { file: NONE, env: 'production' }), /Нет ключа JWT/);
});

test('вне production ключ создаётся в базе и не меняется', () => {
  const db = fakeDb();
  const key = loadJwtSecret(db, { file: NONE, env: 'development' });
  assert.ok(key.length >= 32);
  assert.equal(loadJwtSecret(db, { file: NONE, env: 'development' }), key);
});

test('короткий ключ не принимается', () => {
  assert.throws(() => loadJwtSecret(fakeDb(), { file: keyFile('short', 'abc\n'), env: 'production' }), /короче 32/);
});

test('токен с ключом одного стенда не проходит на другом', () => {
  const token = signJwt({ sub: 'u1' }, loadJwtSecret(fakeDb(), { file: keyFile('stage', `${'s'.repeat(43)}\n`), env: 'production' }));
  const prod = loadJwtSecret(fakeDb(), { file: keyFile('prod', `${'p'.repeat(43)}\n`), env: 'production' });
  assert.equal(verifyJwt(token, prod).reason, 'invalid');
});
