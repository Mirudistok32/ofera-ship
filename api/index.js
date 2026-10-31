/* =========================================================
   «Офферомания» — бэкенд квеста. http://localhost:4010
   Каркас :5190 и эталон :5191 — другие origin → настоящий CORS с credentials.
   npm run quest:server · npm run quest:reset · npm run quest:selftest
   ========================================================= */
import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PORT, DB_FILE, ORIGINS } from './config.js';
import { Db, DbError, newCtx, dbHeaders } from './db.js';
import { seed } from './seed.js';
import { log, requestLog } from './log.js';
import { HttpError } from './errors.js';
import { createAuth } from './auth.js';
import { createCatalog } from './catalog.js';
import { createShop } from './shop.js';
import { createAchievements } from './achievements.js';
import { createPurchases } from './purchases.js';
import { createPremium } from './premium.js';
import { createUpgrade } from './upgrade.js';
import { createHr } from './hr.js';
import { createAuction } from './auction.js';
import { createBots } from './bots.js';
import { createStream } from './stream.js';
import { createChaos } from './chaos.js';
import { createJournal } from './journal.js';
import { createChecks } from './checks.js';
import { EMPTY_TABLES } from './seed.js';

export { HttpError };

export function sendError(req, res, status, code, message, { fields, headers, extra } = {}) {
  for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v);
  res.status(status).json({ error: { code, message, ...(fields ? { fields } : {}), requestId: req.id, ...extra } });
}

const EXPOSE = ['Retry-After', 'ETag', 'X-Total-Count', 'Server-Timing', 'X-Request-Id', 'X-DB-Queries', 'WWW-Authenticate', 'Idempotent-Replayed', 'Location'];
const ALLOW_HEADERS = ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-Match', 'If-None-Match', 'X-Request-Id'];
const ALLOW_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const PREFLIGHT_MAX_AGE = 600;

/* CORS руками: разрешённый origin получает свой ACAO (не *, иначе credentials не работают) и Vary: Origin.
   Чужой origin — ни одного CORS-заголовка: браузер сам не отдаст ответ скрипту */
function cors(origins) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    const allowed = origin && origins.includes(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', EXPOSE.join(', '));
    } else if (origin) {
      log('cors', `чужой origin ${origin} → без CORS-заголовков (${req.method} ${req.path})`);
    }
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      if (!allowed) return res.status(403).end();
      res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS.join(', '));
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS.join(', '));
      res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE));
      log('cors', `preflight ${req.headers['access-control-request-method']} ${req.path} ← ${origin} (Max-Age ${PREFLIGHT_MAX_AGE})`);
      return res.status(204).end();
    }
    next();
  };
}

/* Id запроса (свой или от клиента), счётчик «базы» и заголовки Server-Timing / X-DB-Queries перед отправкой */
function requestContext() {
  return (req, res, next) => {
    const own = req.headers['x-request-id'];
    req.id = typeof own === 'string' && /^[\w-]{1,64}$/.test(own) ? own : `r-${crypto.randomBytes(4).toString('hex')}`;
    req.t0 = performance.now();
    req.db = newCtx();
    res.setHeader('X-Request-Id', req.id);
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      if (!res.headersSent) dbHeaders(req, res);
      return writeHead.apply(this, args);
    };
    next();
  };
}

export function createApp({ db, origins = ORIGINS }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');   // ETag ставим сами там, где он нужен (справочники)
  app.locals.db = db.ensure(['album', ...EMPTY_TABLES]);

  /* Вход, refresh, выход и /me; requireAuth и requireRole — для роутов следующих пунктов */
  const auth = createAuth({ db, origins });
  app.locals.auth = auth;

  /* Журнал запросов по origin — до CORS: в него попадают и ответы-сбои пульта. Пульт — после разбора JSON (priceJump читает тело) */
  const journal = createJournal({ auth, origins });
  const chaos = createChaos({ db, auth, origins });
  app.locals.chaos = chaos;

  app.use(requestContext());
  app.use(requestLog());
  app.use(journal.middleware);
  app.use(cors(origins));
  app.use(express.json({ limit: '100kb' }));
  app.use(chaos.middleware);

  app.use(auth.router);

  /* Офферы, компании, флаги, вишлист; Лавка, усиления, ачивки; покупки и Альбом; премиум; прокачка; HR-панель;
     аукцион, боты с бегущей строкой и SSE /stream */
  const achievements = createAchievements({ db });
  const premium = createPremium({ db, auth });
  app.locals.premium = premium;
  app.use(createCatalog({ db, auth, achievements }));
  app.use(createShop({ db, auth }));
  app.use(createPurchases({ db, auth, achievements }));
  app.use(premium.router);
  app.use(createUpgrade({ db, auth }));
  app.use(createHr({ db, auth }));
  const auction = createAuction({ db, auth });
  app.use(auction.router);
  const bots = createBots({ db, auction });
  app.locals.bots = bots;
  app.use(bots.router);
  const stream = createStream({ auth });
  app.use(stream.router);

  /* Пульт /__chaos, журнал /__log и проверка тикетов /__check */
  app.use(chaos.router);
  app.use(journal.router);
  app.use(createChecks({ journal, chaos, auth, streams: stream.byOrigin }).router);

  /* Жив ли сервер и сколько в базе — один запрос «по индексу» */
  app.get('/health', async (req, res) => {
    const counts = await db.run(req.db, 'index', () => db.stats().counts);
    res.json({ ok: true, serverTime: Date.now(), boots: db.meta.boots, seed: db.meta.seed, counts });
  });

  /* Состояние пула для пульта */
  app.get('/__db', (req, res) => {
    const { active, queued, poolSize, queueMax, noIndex, counts } = db.stats();
    res.json({ active, queued, poolSize, queueMax, noIndex, counts, serverTime: Date.now() });
  });

  app.use((req, res) => sendError(req, res, 404, 'NOT_FOUND', 'Вакансия закрыта, но объявление провисит ещё год'));

  app.use((err, req, res, _next) => {   // четыре аргумента — так Express узнаёт обработчик ошибок
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) return sendError(req, res, err.status, err.code, err.message, err);
    if (err.type === 'entity.parse.failed') return sendError(req, res, 400, 'BAD_JSON', 'Тело запроса — не JSON');
    if (err.type === 'entity.too.large') return sendError(req, res, 413, 'TOO_LARGE', 'Резюме на 40 страниц не читаем');
    if (err instanceof DbError) {
      if (err.code === 'DB_BUSY') return sendError(req, res, 503, 'DB_BUSY', 'База перегружена', { headers: { 'Retry-After': String(err.retryAfter ?? 2) } });
      if (err.code === 'VERSION_CONFLICT') return sendError(req, res, 409, 'VERSION_CONFLICT', 'Пока шли раздумья, данные изменились', { extra: { current: err.current } });
      if (err.code === 'NOT_FOUND') return sendError(req, res, 404, 'NOT_FOUND', 'Вакансия закрыта, но объявление провисит ещё год');
    }
    log('err', req.id, err.stack ?? err);
    sendError(req, res, 500, 'INTERNAL', 'HR ушёл на обед');
  });

  return app;
}

export function start({ port = PORT, file = DB_FILE } = {}) {
  const db = Db.open(file, seed);
  db.setMeta({ boots: (db.meta.boots ?? 0) + 1, bootedAt: new Date().toISOString() });
  db.flush();
  const app = createApp({ db });
  const server = app.listen(port, () => {
    log('http', `«Офферомания» на http://localhost:${port} · запуск №${db.meta.boots} · ${db.tables.offers.size} офферов`);
    log('cors', `разрешены: ${ORIGINS.join(', ')}`);
  });
  const stop = () => {
    db.flush();
    server.close();
    server.closeAllConnections();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { app, db, server };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
