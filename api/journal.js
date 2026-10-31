/* Журнал запросов по origin — то, что сервер видел от каркаса (:5190) и эталона (:5191). По нему проверка тикета выносит вердикт.
   Запись: метод, адрес, статус и код ошибки, отменён ли клиентом, оборван ли пультом, время, Idempotency-Key, If-None-Match,
   чей токен и в каком состоянии (отпечаток, sub, role, plan, ok | expired | invalid), Retry-After, тело не-GET запроса.
   Пишутся только запросы со своих origin; служебные /__* и preflight — нет. Живёт в памяти, по 3000 последних на origin.
   GET /__log?origin=…&since=<seq> — для пульта, DELETE /__log?origin=… — очистить. */
import express from 'express';
import { HttpError } from './errors.js';

const KEEP = 3000;
const BODY_MAX = 500;

/* localhost и 127.0.0.1 — один и тот же каркас */
export const originKey = (origin) => origin.replace('://127.0.0.1', '://localhost');

export function createJournal({ auth, origins }) {
  const byOrigin = new Map();   // originKey → записи по порядку начала
  let seq = 0;

  const listOf = (origin) => {
    const key = originKey(origin);
    if (!byOrigin.has(key)) byOrigin.set(key, []);
    return byOrigin.get(key);
  };

  /* Мидлвар ставится до CORS и пульта: запись появляется в начале запроса, дописывается при закрытии */
  const middleware = (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || !origins.includes(origin) || req.method === 'OPTIONS' || req.path.startsWith('/__')) return next();
    const token = auth.bearer(req) ?? (req.path === '/stream' && typeof req.query.token === 'string' ? req.query.token : null);
    const entry = {
      seq: ++seq, t: Date.now(), ms: null, method: req.method, url: req.originalUrl, path: req.path,
      status: null, code: null, info: null, aborted: false, chaos: null, sse: req.path === '/stream',
      idem: req.headers['idempotency-key'] ?? null, inm: req.headers['if-none-match'] ?? null,
      auth: auth.inspect(token), retryAfter: null, replayed: false, body: null, job: null,
    };
    const list = listOf(origin);
    list.push(entry);
    if (list.length > KEEP) list.shift();

    /* Код ошибки и пара полей из тела: цена из 409, статус задачи из /jobs/:id */
    const json = res.json;
    res.json = function (body) {
      if (body?.error) {
        entry.code = body.error.code;
        const { price, expectedPrice, tokenPlan, plan } = body.error;
        entry.info = { price, expectedPrice, tokenPlan, plan };
      }
      if (body?.job?.status) entry.job = body.job.status;
      return json.call(this, body);
    };

    res.on('close', () => {
      entry.ms = Date.now() - entry.t;
      entry.chaos = req.chaos ?? null;
      entry.status = req.chaos === 'drop' ? 0 : res.statusCode;
      entry.aborted = !res.writableFinished && req.chaos !== 'drop';
      entry.retryAfter = res.getHeader('Retry-After') ?? null;
      entry.replayed = res.getHeader('Idempotent-Replayed') === 'true';
      if (req.method !== 'GET' && req.body && JSON.stringify(req.body).length <= BODY_MAX) entry.body = req.body;
    });
    next();
  };

  /* Записи origin с номера since (не включая) */
  const since = (origin, from = 0) => listOf(origin).filter((e) => e.seq > from);
  const last = () => seq;

  const origin = (req) => {
    const o = typeof req.query.origin === 'string' ? req.query.origin : req.headers.origin;
    if (!o || !origins.includes(o)) throw new HttpError(422, 'VALIDATION', `Нужен ?origin= из списка: ${origins.join(', ')}`, { fields: { origin: 'Свой origin' } });
    return o;
  };

  const router = express.Router();
  router.get('/__log', (req, res) => {
    const from = Number(req.query.since) || 0;
    res.json({ origin: originKey(origin(req)), items: since(origin(req), from).slice(-500), last: last(), serverTime: Date.now() });
  });
  router.delete('/__log', (req, res) => {
    listOf(origin(req)).length = 0;
    res.status(204).end();
  });

  return { router, middleware, since, last, originOf: origin };
}
