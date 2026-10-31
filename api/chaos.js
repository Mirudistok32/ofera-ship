/* Пульт сбоев «Офферомании»: GET /__chaos — ручки и наборы, PATCH /__chaos — поменять ручки, POST /__chaos/preset/:id — набор,
   POST /__chaos/expire-tokens — «сделать токен просроченным».
   - Ручки: задержка и разброс, процент 500 «HR ушёл на обед», 503 «Идёт реорганизация», шторм 429, обрыв сети,
     срок жизни access-токена, «база без индекса», размер пула. Для проверок тикетов ещё две:
     flaky — каждый адрес падает первые N раз (GET: обрыв → 500 → 429 с Retry-After, остальные методы — один 500),
     priceJump — первая покупка оффера после «Начать» видит цену на 10% выше (409 «цену подняли»).
   - Сбои не трогают служебное (/__*, /health), вход и refresh (/auth/*), preflight и поток /stream.
   - Сбой — после задержки: клиент успевает отменить запрос, и тогда сервер его уже не обрабатывает. */
import express from 'express';
import { HttpError } from './errors.js';
import { log } from './log.js';
import { bus } from './bus.js';
import { ACCESS_TTL } from './config.js';
import { DEFAULTS as DB } from './db.js';

/* Ручка: [мин, макс] для чисел, 'bool' для флажков */
const KNOBS = {
  delayMs: [0, 10_000],
  jitterMs: [0, 10_000],
  fail500: [0, 100],
  fail503: [0, 100],
  storm429: [0, 100],
  netDrop: [0, 100],
  flaky: [0, 3],
  priceJump: 'bool',
  accessTtl: [2, 3600],
  noIndex: 'bool',
  poolSize: [1, 20],
};

export const CALM = {
  delayMs: 0, jitterMs: 0, fail500: 0, fail503: 0, storm429: 0, netDrop: 0,
  flaky: 0, priceJump: false, accessTtl: ACCESS_TTL, noIndex: DB.noIndex, poolSize: DB.poolSize,
};

export const PRESETS = [
  { id: 'calm', name: 'Спокойный день', about: 'Без сбоев: всё отвечает сразу', set: {} },
  { id: 'friday', name: 'Пятница вечер', about: 'Задержка 0,4–1,2 с, 15% «HR ушёл на обед», 10% шторм 429, 5% обрыв сети',
    set: { delayMs: 400, jitterMs: 800, fail500: 15, storm429: 10, netDrop: 5 } },
  { id: 'black-friday', name: 'Чёрная пятница', about: 'Пул из 2 соединений, база без индекса, 25% шторм 429: очередь растёт до 503 «База перегружена»',
    set: { delayMs: 200, jitterMs: 300, storm429: 25, noIndex: true, poolSize: 2 } },
  { id: 'reorg', name: 'Реорганизация', about: '30% 503 «Идёт реорганизация», 5% 500, токен живёт 10 с',
    set: { delayMs: 200, fail503: 30, fail500: 5, accessTtl: 10 } },
];

const FLAKY_GET = ['drop', 500, 429];
const JUMP = 1.1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = (req) => req.method === 'OPTIONS' || /^\/(__|health$|ready$|auth\/|stream$)/.test(req.path);

export function createChaos({ db, auth, origins }) {
  const settings = { ...CALM };
  const flaky = new Map();    // `${origin} ${method} ${url}` → сколько раз уже упал
  const jumped = new Map();   // `${origin} ${offerId}` → промис подъёма цены: двойной клик ждёт тот же подъём

  /* Ручки, которые живут в других модулях, — туда */
  const apply = () => {
    auth.settings.accessTtl = settings.accessTtl;
    db.settings.noIndex = settings.noIndex;
    db.settings.poolSize = settings.poolSize;
    db.pump();
  };

  const presetOf = () => PRESETS.find((p) => Object.entries({ ...CALM, ...p.set }).every(([k, v]) => settings[k] === v))?.id ?? null;
  const state = () => ({ settings: { ...settings }, preset: presetOf(), presets: PRESETS, knobs: KNOBS, tokenGen: db.meta.tokenGen ?? 0, serverTime: Date.now() });

  /* Проверить и применить часть ручек; неизвестная или вне диапазона — 422 со всеми полями сразу */
  function set(patch) {
    const fields = {};
    for (const [k, v] of Object.entries(patch ?? {})) {
      const knob = KNOBS[k];
      if (!knob) fields[k] = 'Нет такой ручки';
      else if (knob === 'bool' ? typeof v !== 'boolean' : !(Number.isInteger(v) && v >= knob[0] && v <= knob[1])) {
        fields[k] = knob === 'bool' ? 'Нужно true или false' : `Целое от ${knob[0]} до ${knob[1]}`;
      }
    }
    if (Object.keys(fields).length) throw new HttpError(422, 'VALIDATION', 'Пульт так не крутится', { fields });
    Object.assign(settings, patch);
    flaky.clear();
    jumped.clear();
    apply();
    const changed = Object.entries(settings).filter(([k, v]) => v !== CALM[k]).map(([k, v]) => `${k}=${v}`).join(' ');
    log('chaos', `${presetOf() ? `набор ${presetOf()}` : 'свои ручки'}${changed ? ` · ${changed}` : ' · без сбоев'}`);
    return state();
  }

  const preset = (id, extra = {}) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Такого набора нет');
    return set({ ...CALM, ...p.set, ...extra });
  };

  /* Какой сбой достаётся запросу: null, 'drop', 500, 503 или 429 */
  function fault(req) {
    if (settings.flaky) {
      const key = `${req.headers.origin ?? '—'} ${req.method} ${req.originalUrl}`;
      const n = flaky.get(key) ?? 0;
      const plan = req.method === 'GET' ? FLAKY_GET.slice(0, settings.flaky) : [500];
      if (n < plan.length) {
        flaky.set(key, n + 1);
        return plan[n];
      }
      flaky.delete(key);   // прошёл — следующий заход снова начнётся со сбоев
    }
    const roll = (pct) => pct > 0 && Math.random() * 100 < pct;
    if (roll(settings.netDrop)) return 'drop';
    if (roll(settings.storm429)) return 429;
    if (roll(settings.fail503)) return 503;
    if (roll(settings.fail500)) return 500;
    return null;
  }

  /* Первая покупка оффера после «Начать»: цена +10%, событие price — покупка с прежней expectedPrice получит 409 */
  function jump(req) {
    const offerId = req.body?.offerId;
    if (typeof offerId !== 'string') return;
    const key = `${req.headers.origin ?? '—'} ${offerId}`;
    if (!jumped.has(key)) jumped.set(key, raise(req, offerId));
    return jumped.get(key);
  }

  async function raise(req, offerId) {
    const was = await db.tx(req.db, async (t) => {
      const offer = await t.get('offers', offerId);
      if (!offer) return null;
      await t.update('offers', offerId, { price: Math.round(offer.price * JUMP) });
      return offer.price;
    });
    if (was === null) return;
    const price = Math.round(was * JUMP);
    log('chaos', `цена ${offerId} ${was} → ${price} перед покупкой`);
    bus.emit('price', { offerId, price, was, by: 'hr', at: Date.now() });
  }

  /* Мидлвар: задержка, потом сбой или обычная обработка */
  const middleware = async (req, res, next) => {
    try {
      if (quiet(req)) return next();
      const delay = settings.delayMs + Math.random() * settings.jitterMs;
      if (delay > 0) await sleep(delay);
      if (res.destroyed || res.writableEnded || req.socket.destroyed) return;   // клиент ушёл, пока ждали
      const f = fault(req);
      if (f) req.chaos = f;
      if (f === 'drop') {
        log('chaos', `обрыв ${req.method} ${req.originalUrl}`);
        // Не socket.destroy(): обрыв до первого байта на переиспользованном keep-alive соединении Chrome молча переотправляет сам,
        // и невидимая для fetch попытка съедала бы следующий сбой с паузой 0 мс. Ответ с двумя разными Content-Length
        // браузер и Node отвергают как сетевую ошибку (TypeError: Failed to fetch) и не переотправляют
        return req.socket.end('HTTP/1.1 502 Drop\r\nContent-Length: 1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n');
      }
      if (f === 429) throw new HttpError(429, 'RATE_LIMIT', 'Слишком много откликов. Остынь', { headers: { 'Retry-After': '1' } });
      if (f === 503) throw new HttpError(503, 'REORG', 'Идёт реорганизация', { headers: { 'Retry-After': '2' } });
      if (f === 500) throw new HttpError(500, 'INTERNAL', 'HR ушёл на обед');
      if (settings.priceJump && req.method === 'POST' && req.path === '/purchases') await jump(req);
      next();
    } catch (e) {
      if (e instanceof HttpError) log('chaos', `${e.status} ${req.method} ${req.originalUrl}`);
      next(e);
    }
  };

  /* Менять пульт можно без Origin (curl) или со своих origin: чужая страница простым POST его не крутит */
  const own = (req, _res, next) => {
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'Пульт — только для своих');
    next();
  };

  const router = express.Router();
  router.get('/__chaos', (req, res) => res.json(state()));
  router.patch('/__chaos', own, (req, res) => res.json(set(req.body)));
  router.post('/__chaos/preset/:id', own, (req, res) => res.json(preset(req.params.id)));
  router.post('/__chaos/expire-tokens', own, (req, res) => res.json({ ...state(), tokenGen: auth.expireAll() }));

  return { router, middleware, settings, set, preset, own };
}
