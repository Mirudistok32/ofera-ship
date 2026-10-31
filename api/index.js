/* =========================================================
   «Офферомания» — бэкенд квеста. http://localhost:4010
   Каркас :5190 и эталон :5191 — другие origin → настоящий CORS с credentials.
   npm run quest:server · npm run quest:reset · npm run quest:selftest
   ========================================================= */
import express from 'express';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, DB_FILE, ORIGINS, TRUST_PROXY, CHAOS_OPEN, RELEASE, SLOT, STANDBY, HOLD_MS, DRAIN_MS } from './config.js';
import { Db, DbError, newCtx, dbHeaders } from './db.js';
import { seed } from './seed.js';
import { event, log, requestLog } from './log.js';
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
  app.set('trust proxy', TRUST_PROXY);
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
  if (CHAOS_OPEN) app.use(journal.middleware);
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
  if (CHAOS_OPEN) app.use(chaos.router);
  if (CHAOS_OPEN) app.use(journal.router);
  if (CHAOS_OPEN) app.use(createChecks({ journal, chaos, auth, streams: stream.byOrigin }).router);

  /* Жив ли процесс. База здесь ни при чём: её сбой перезапуском не вылечить */
  app.get('/health', (req, res) => res.json({ ok: true }));

  /* Можно ли слать сюда запросы: база отвечает. Нет — 503, балансировщик уводит трафик, процесс не трогают */
  app.get('/ready', async (req, res) => {
    const ok = await db.run(req.db, 'index', () => true).catch(() => false);
    res.status(ok ? 200 : 503).json({ ok });
  });

  /* Какая версия ответила: агент сверяет её до и после переключения */
  app.get('/version', (req, res) => res.json(versionInfo()));

  /* Состояние пула для пульта */
  if (CHAOS_OPEN) app.get('/__db', (req, res) => {
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
    event('err', `${req.id} ${err.stack ?? err}`, { requestId: req.id, msg: String(err.stack ?? err) });
    sendError(req, res, 500, 'INTERNAL', 'HR ушёл на обед');
  });

  return app;
}

const versionInfo = () => ({ release: RELEASE, slot: SLOT, stand: process.env.OFERA_STAND ?? null });

/* База живёт в памяти процесса, поэтому писатель должен быть один. Запасной слот не может проверить себя на настоящем файле,
   поэтому проверяет на копии в отдельном процессе: тот откроет базу, соберёт приложение и выйдет вместе со всеми таймерами */
function rehearse(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofera-rehearsal-'));
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(dir, path.basename(file)));
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    encoding: 'utf8',
    env: { ...process.env, QUEST_STANDBY: '0', QUEST_DRY_RUN: '1', QUEST_DATA: dir },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  if (run.status !== 0) {
    event('err', `репетиция запуска не прошла: ${run.stderr.trim()}`, { msg: 'репетиция запуска не прошла', detail: run.stderr.trim() });
    process.exit(1);
  }
}

export function start({ port = PORT, file = DB_FILE } = {}) {
  if (process.env.QUEST_DRY_RUN) {
    createApp({ db: Db.open(file, seed) });
    process.exit(0);
  }
  let db;
  let app;
  let holdTimer;
  let stopping = false;
  let busy = 0;   // поток SSE сюда не входит: он открыт всегда, а браузер переподключится сам
  const held = [];

  const serve = (req, res) => {
    if (!req.url.startsWith('/stream')) {
      busy++;
      res.once('close', () => { busy--; });
    }
    app(req, res);
  };

  const boot = () => {
    if (app) return;
    clearTimeout(holdTimer);
    db = Db.open(file, seed);
    db.setMeta({ boots: (db.meta.boots ?? 0) + 1, bootedAt: new Date().toISOString() });
    db.flush();
    app = createApp({ db });
    log('http', `«Офферомания» на http://localhost:${port} · запуск №${db.meta.boots} · ${db.tables.offers.size} офферов${held.length ? ` · придержано запросов: ${held.length}` : ''}`);
    log('cors', `разрешены: ${ORIGINS.join(', ')}`);
    for (const [req, res] of held.splice(0)) serve(req, res);
  };

  const server = http.createServer((req, res) => {
    if (app) return serve(req, res);
    const url = req.url.split('?')[0];
    if (url === '/health' || url === '/ready' || url === '/version') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(url === '/version' ? versionInfo() : { ok: true, standby: true }));
    }
    held.push([req, res]);
    /* Агент пропал между переключением и передачей базы: без этого запросы ждали бы вечно */
    holdTimer ??= setTimeout(boot, HOLD_MS);
  });

  if (STANDBY) {
    rehearse(file);
    process.on('SIGUSR2', boot);   // прежняя версия дописала файл и вышла, база теперь наша
  } else {
    boot();
  }
  server.listen(port);

  /* Новые подключения больше не принимаем, начатые запросы дорабатывают. Файл пишем последним: после него писать уже некому */
  const stop = () => {
    if (!app) process.exit(0);
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeIdleConnections();
    const deadline = Date.now() + DRAIN_MS;
    const wait = () => {
      if (busy > 0 && Date.now() < deadline) return setTimeout(wait, 50);
      db.flush();
      server.closeAllConnections();
      process.exit(0);
    };
    wait();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { app, db, server };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
