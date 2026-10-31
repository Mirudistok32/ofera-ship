/* Idempotency-Key для покупки (и прокачки в 12.5). Ключ живёт в пространстве пользователя: `${userId}:${key}`.
   - Успешный ответ записывается в таблицу idempotency в той же транзакции, что и сама покупка.
     Повтор с тем же ключом получает тот же ответ и заголовок Idempotent-Replayed: true, новой покупки нет.
   - Два запроса с одним ключом наперегонки: обе транзакции пишут строку ключа, вторая ловит конфликт при commit,
     повторяется (retryTx), видит записанный ответ и отдаёт его.
   - Ошибки не запоминаются: после 409 «цену подняли» можно повторить с тем же ключом и новой ценой.
   - Тот же ключ с другим телом или на другой адрес — 422 IDEMPOTENCY_MISMATCH. */
import crypto from 'node:crypto';
import { HttpError } from './errors.js';

const KEY = /^[\w.:-]{1,128}$/;

/* → { id, key, print } или null, если ключа нет */
export function idempotency(req) {
  const key = req.headers['idempotency-key'];
  if (key === undefined) return null;
  if (!KEY.test(key)) throw new HttpError(400, 'BAD_IDEMPOTENCY_KEY', 'Idempotency-Key — от 1 до 128 букв, цифр и знаков _ . : -');
  const print = crypto.createHash('sha1').update(`${req.method} ${req.path} ${JSON.stringify(req.body ?? null)}`).digest('hex');
  return { id: `${req.auth.sub}:${key}`, key, print };
}

/* Строка ключа из базы → готовый ответ для повтора или null */
export function stored(row, idem) {
  if (!row) return null;
  if (row.print !== idem.print) throw new HttpError(422, 'IDEMPOTENCY_MISMATCH', 'Этот Idempotency-Key уже потрачен на другой запрос');
  return row;
}

export function replay(res, row) {
  res.setHeader('Idempotent-Replayed', 'true');
  res.status(row.status).json(row.body);
}

export function remember(t, idem, userId, status, body) {
  return t.insert('idempotency', { id: idem.id, userId, key: idem.key, print: idem.print, status, body, createdAt: new Date().toISOString() });
}
