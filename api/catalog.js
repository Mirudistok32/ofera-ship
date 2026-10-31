/* Каталог «Офферомании»: офферы, компании, флаги, вишлист.
   - GET /offers — фильтры, сортировка, курсор, X-Total-Count. Без q — запрос «по индексу», с q — полный перебор (300–800 мс).
     Лимит — 10 запросов в секунду на клиента (IP + Origin), дальше 429 «Остынь» с Retry-After.
   - Курсор непрозрачный: последняя строка страницы (значение сортировки + id) и отпечаток фильтра.
     Новые офферы и удаления не дают дублей и пропусков; курсор от другого фильтра — 400.
   - Вилка «до N ₽*»: нижняя граница скрыта, пока оффер не куплен, не мифический и не включён «Знакомый в HR». /offers/:id/salary — 403.
   - GET /companies?ids= — батч одним запросом в базу (лекарство от N+1 в карточках).
   - GET /flags — справочник с ETag: совпал If-None-Match — 304 без тела и без запроса в базу.
   - Вишлист: PUT и DELETE идемпотентны, два одинаковых запроса наперегонки дают одну запись.
   - Ачивки: страница оффера с токеном считается просмотром («Насмотренность»), 5 в вишлисте — «Хочу-хочу». */
import crypto from 'node:crypto';
import express from 'express';
import { DbError } from './db.js';
import { HttpError } from './errors.js';
import { RARITIES } from './seed.js';
import { log } from './log.js';

export const SEARCH_LIMIT = { requests: 10, windowMs: 1000 };
export const PAGE = { size: 20, max: 50 };
export const WISHLIST_MAX = 30;
export const COMPANIES_MAX = 100;

const SORTS = {
  new: { key: 'createdAt', dir: -1 },
  price: { key: 'price', dir: 1 },
  '-price': { key: 'price', dir: -1 },
  salary: { key: 'salaryTo', dir: 1 },
  '-salary': { key: 'salaryTo', dir: -1 },
};
const RARITY_IDS = RARITIES.map((r) => r.id);

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const notFound = () => new HttpError(404, 'NOT_FOUND', 'Вакансия закрыта, но объявление провисит ещё год');

/* Карточка для списка: без нижней границы вилки и длинных текстов */
export const card = ({ id, title, grade, companyId, rarity, price, salaryTo, flags, stack, city, createdAt, v }) =>
  ({ id, title, grade, companyId, rarity, price, salaryTo, flags, stack, city, createdAt, v });

/* Параллельная транзакция успела первой — пробуем ещё раз: повтор увидит уже новые данные */
export async function retryTx(fn, times = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof DbError && ['VERSION_CONFLICT', 'DUPLICATE'].includes(e.code)) || attempt >= times) throw e;
    }
  }
}

const etagMatches = (header, etag) =>
  Boolean(header) && (header.trim() === '*' || header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag));

/* Справочник с ETag. Хэш содержимого запоминается до следующей записи в таблицу (db.rev),
   поэтому 304 обходится без запроса в базу: X-DB-Queries: 0. Cache-Control: no-cache — браузер сам переспрашивает с If-None-Match */
export function reference(db, table) {
  let cached = null;   // { rev, etag, body }
  return async (req, res) => {
    const rev = db.rev(table);
    if (cached?.rev !== rev) {
      const items = await db.run(req.db, 'index', () => [...db.table(table).values()].map(({ v, ...row }) => row));
      const body = JSON.stringify({ items });
      cached = { rev, etag: `"${sha1(body).slice(0, 16)}"`, body };
    }
    res.setHeader('ETag', cached.etag);
    res.setHeader('Cache-Control', 'no-cache');
    if (etagMatches(req.headers['if-none-match'], cached.etag)) return res.status(304).end();
    res.type('json').send(cached.body);
  };
}

/* Скользящее окно на клиента; отказ не занимает место в окне */
function searchLimit() {
  const hits = new Map();   // `${ip}|${origin}` → времена принятых запросов
  return (req, _res, next) => {
    const key = `${req.ip}|${req.headers.origin ?? '-'}`;
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < SEARCH_LIMIT.windowMs);
    hits.set(key, recent);
    if (recent.length >= SEARCH_LIMIT.requests) {
      const retry = Math.max(1, Math.ceil((recent[0] + SEARCH_LIMIT.windowMs - now) / 1000));
      log('http', `429 поиск: ${recent.length} запросов за секунду · ${req.headers.origin ?? req.ip}`);
      throw new HttpError(429, 'RATE_LIMIT', 'Слишком много откликов. Остынь', { headers: { 'Retry-After': String(retry) } });
    }
    recent.push(now);
    next();
  };
}

/* ?rarity=a,b и ?rarity=a&rarity=b — одно и то же */
const raw = (query, name) => [query[name]].flat().filter((v) => typeof v === 'string').join(',').trim();
const list = (query, name) => [...new Set(raw(query, name).split(',').map((s) => s.trim()).filter(Boolean))].sort();

function parseFilters(query) {
  const fields = {};
  const num = (name) => {
    const s = raw(query, name);
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) fields[name] = 'Нужно число не меньше нуля';
    return n;
  };
  const f = {
    q: raw(query, 'q').toLowerCase(),
    rarity: list(query, 'rarity'),
    grade: list(query, 'grade'),
    flag: list(query, 'flag'),
    companyId: list(query, 'companyId'),
    city: raw(query, 'city'),
    priceMin: num('priceMin'),
    priceMax: num('priceMax'),
    noFlags: ['1', 'true'].includes(raw(query, 'noFlags')),
    sort: raw(query, 'sort') || 'new',
  };
  const badRarity = f.rarity.filter((r) => !RARITY_IDS.includes(r));
  if (badRarity.length) fields.rarity = `Нет такой редкости: ${badRarity.join(', ')}. Есть: ${RARITY_IDS.join(', ')}`;
  if (!SORTS[f.sort]) fields.sort = `Сортировки: ${Object.keys(SORTS).join(', ')}`;
  if (f.q.length > 100) fields.q = 'Запрос длиннее 100 символов';
  if (f.priceMin != null && f.priceMax != null && f.priceMin > f.priceMax) fields.priceMax = 'Максимум меньше минимума';
  const limit = Number(raw(query, 'limit') || PAGE.size);
  if (!Number.isInteger(limit) || limit < 1) fields.limit = `Целое от 1 до ${PAGE.max}`;
  if (Object.keys(fields).length) throw new HttpError(422, 'VALIDATION', 'Фильтры заполнены с ошибками', { fields });
  return { ...f, limit: Math.min(limit, PAGE.max) };
}

function matches(o, f, companies) {
  if (f.noFlags && o.flags.length) return false;
  if (f.rarity.length && !f.rarity.includes(o.rarity)) return false;
  if (f.grade.length && !f.grade.includes(o.grade)) return false;
  if (f.companyId.length && !f.companyId.includes(o.companyId)) return false;
  if (f.flag.length && !f.flag.every((x) => o.flags.includes(x))) return false;
  if (f.city && o.city !== f.city) return false;
  if (f.priceMin != null && o.price < f.priceMin) return false;
  if (f.priceMax != null && o.price > f.priceMax) return false;
  if (f.q) {
    const text = `${o.title} ${o.city} ${o.stack.join(' ')} ${o.pitch} ${companies.get(o.companyId)?.name ?? ''}`.toLowerCase();
    if (!text.includes(f.q)) return false;
  }
  return true;
}

/* Порядок сортировки + id: строки с одинаковой ценой тоже стоят в стабильном порядке, курсор на них не спотыкается */
const order = ({ key, dir }) => (a, b) => {
  if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * dir;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const encodeCursor = (row, sort, print) => Buffer.from(JSON.stringify({ k: row[sort.key], id: row.id, f: print })).toString('base64url');

function decodeCursor(s, sort, print) {
  let c = null;
  try {
    c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {}
  if (!c || typeof c.id !== 'string' || !('k' in c)) throw new HttpError(400, 'BAD_CURSOR', 'Курсор испорчен — начни ленту сначала');
  if (c.f !== print) throw new HttpError(400, 'CURSOR_MISMATCH', 'Курсор от другого фильтра — начни ленту сначала');
  return { [sort.key]: c.k, id: c.id };
}

const wishId = (userId, offerId) => `${userId}:${offerId}`;
const myWishes = (db, ctx, userId) => db.where(ctx, 'wishlist', (w) => w.userId === userId);

/* Чем открыта вилка: мифический оффер честен для всех, остальным — покупка или «Знакомый в HR» */
async function salaryAccess(db, ctx, offer, auth) {
  if (offer.rarity === 'mythic') return 'mythic';
  if (!auth) return null;
  const user = await db.get(ctx, 'users', auth.sub);
  if (Date.parse(user?.effects?.['hr-friend'] ?? '') > Date.now()) return 'hr-friend';
  const [own] = await db.where(ctx, 'album', (a) => a.userId === auth.sub && a.offerId === offer.id);
  return own ? 'purchased' : null;
}

export function createCatalog({ db, auth, achievements }) {
  const { requireAuth, optionalAuth } = auth;
  const router = express.Router();

  router.get('/offers', searchLimit(), optionalAuth, async (req, res) => {
    const f = parseFilters(req.query);
    const sort = SORTS[f.sort];
    const { limit, ...rest } = f;
    const print = sha1(JSON.stringify(rest)).slice(0, 8);
    const cursor = raw(req.query, 'cursor');
    const after = cursor ? decodeCursor(cursor, sort, print) : null;
    const cmp = order(sort);

    const page = await db.run(req.db, f.q ? 'scan' : 'index', () => {
      const rows = [...db.table('offers').values()].filter((o) => matches(o, f, db.table('companies'))).sort(cmp);
      let from = after ? rows.findIndex((o) => cmp(o, after) > 0) : 0;
      if (from < 0) from = rows.length;
      const items = rows.slice(from, from + limit);
      const more = from + limit < rows.length;
      return { total: rows.length, items: items.map(card), nextCursor: more ? encodeCursor(items.at(-1), sort, print) : null };
    });

    if (req.auth) {
      const wished = new Set((await myWishes(db, req.db, req.auth.sub)).map((w) => w.offerId));
      for (const o of page.items) o.inWishlist = wished.has(o.id);
    }
    res.setHeader('X-Total-Count', String(page.total));
    res.json({ ...page, ...(f.noFlags && !page.total ? { hint: 'Таких не бывает' } : {}) });
  });

  router.get('/offers/:id', optionalAuth, async (req, res) => {
    const offer = await db.get(req.db, 'offers', req.params.id);
    if (!offer) throw notFound();
    const access = await salaryAccess(db, req.db, offer, req.auth);
    const wished = req.auth ? Boolean(await db.get(req.db, 'wishlist', wishId(req.auth.sub, offer.id))) : false;
    if (req.auth) await achievements.noteView(req.db, req.auth.sub, offer.id);   // «Насмотренность»
    res.json({
      ...offer,
      salaryFrom: access ? offer.salaryFrom : null,
      salaryHidden: !access,
      salaryAccess: access,
      inWishlist: wished,
      serverTime: Date.now(),
    });
  });

  router.get('/offers/:id/salary', requireAuth, async (req, res) => {
    const offer = await db.get(req.db, 'offers', req.params.id);
    if (!offer) throw notFound();
    const access = await salaryAccess(db, req.db, offer, req.auth);
    if (!access) throw new HttpError(403, 'SALARY_HIDDEN', 'Вилку покажут после покупки. Или если есть знакомый в HR');
    res.json({ offerId: offer.id, from: offer.salaryFrom, to: offer.salaryTo, access });
  });

  router.get('/companies', async (req, res) => {
    if (req.query.ids === undefined) return res.json({ items: await db.where(req.db, 'companies', () => true) });
    const ids = [...new Set(raw(req.query, 'ids').split(',').map((s) => s.trim()).filter(Boolean))];
    if (!ids.length) throw new HttpError(422, 'VALIDATION', 'Какие компании нужны?', { fields: { ids: 'Перечисли id через запятую' } });
    if (ids.length > COMPANIES_MAX) throw new HttpError(422, 'VALIDATION', 'Слишком длинный список', { fields: { ids: `Не больше ${COMPANIES_MAX} за раз` } });
    const items = await db.getMany(req.db, 'companies', ids);   // один запрос, как WHERE id IN (…)
    const found = new Set(items.map((c) => c.id));
    res.json({ items, missing: ids.filter((id) => !found.has(id)) });
  });

  router.get('/companies/:id', async (req, res) => {
    const company = await db.get(req.db, 'companies', req.params.id);
    if (!company) throw notFound();
    res.json(company);
  });

  router.get('/flags', reference(db, 'flags'));

  router.get('/wishlist', requireAuth, async (req, res) => {
    const rows = (await myWishes(db, req.db, req.auth.sub)).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    const offers = await db.getMany(req.db, 'offers', rows.map((w) => w.offerId));
    res.json({ items: offers.map((o) => ({ ...card(o), inWishlist: true })), total: offers.length });
  });

  router.put('/wishlist/:offerId', requireAuth, async (req, res) => {
    const { sub } = req.auth;
    const { offerId } = req.params;
    const before = (await myWishes(db, req.db, sub)).length;
    await retryTx(() => db.tx(req.db, async (t) => {
      if (await t.get('wishlist', wishId(sub, offerId))) return;   // уже там — PUT идемпотентен
      if (!(await t.get('offers', offerId))) throw notFound();
      if (before >= WISHLIST_MAX) throw new HttpError(422, 'WISHLIST_FULL', `Вишлист не резиновый: не больше ${WISHLIST_MAX}`);
      await t.insert('wishlist', { id: wishId(sub, offerId), userId: sub, offerId, addedAt: iso() });
    }));
    const total = (await myWishes(db, req.db, sub)).length;
    await achievements.award(req.db, sub, 'wishlist', { total });
    res.json({ offerId, inWishlist: true, total });
  });

  router.delete('/wishlist/:offerId', requireAuth, async (req, res) => {
    const { sub } = req.auth;
    const { offerId } = req.params;
    await retryTx(() => db.tx(req.db, async (t) => {
      if (await t.get('wishlist', wishId(sub, offerId))) await t.remove('wishlist', wishId(sub, offerId));
    }));
    res.json({ offerId, inWishlist: false, total: (await myWishes(db, req.db, sub)).length });
  });

  return router;
}
