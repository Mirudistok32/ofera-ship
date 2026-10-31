/* Покупки и Альбом «Офферомании».
   - POST /purchases { offerId, expectedPrice, boosts? } — одна транзакция: проверка цены, усиления, списание 🍪,
     строка покупки, карточка в Альбоме, ачивки покупки. Ответ 201.
     Цена сдвинулась с той, что видел клиент, — 409 PRICE_CHANGED с текущей ценой: клиент переспрашивает, а не платит молча.
     Idempotency-Key: повтор с тем же ключом — тот же ответ, без второй покупки (idempotency.js). Без ключа два запроса — две покупки.
   - Усиления окна покупки: «Сопроводительное письмо» −10% и «Оффер на руках» −25% (премиальное). Вместе — 422 BOOSTS_INCOMPATIBLE.
   - GET /album — купленные карточки с оффером, полкой, уровнем и таймером «ответь HR» (hrDeadline считается от serverTime).
   - PATCH /album/:id { shelf } с If-Match: "<v>" — переложить на полку. Версия устарела — 409 VERSION_CONFLICT с текущей карточкой,
     без If-Match — 428. Офферы на всех четырёх полках дают «Коллекционера». */
import crypto from 'node:crypto';
import express from 'express';
import { HttpError } from './errors.js';
import { publicUser, premiumGate } from './auth.js';
import { card, retryTx } from './catalog.js';
import { earned, announce } from './achievements.js';
import { idempotency, stored, replay, remember } from './idempotency.js';
import { SHELVES } from './seed.js';
import { log } from './log.js';

export const DISCOUNTS = { 'cover-letter': 0.1, 'offer-in-hand': 0.25 };
const SHELF_IDS = SHELVES.map((s) => s.id);

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const newId = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
const notFound = () => new HttpError(404, 'NOT_FOUND', 'Вакансия закрыта, но объявление провисит ещё год');
const invalid = (fields) => new HttpError(422, 'VALIDATION', 'Заявка заполнена с ошибками', { fields });

/* Таймер «ответь HR до …» идёт по кругу: ближайший конец периода hrEverySec после now */
function hrDeadline(row, now) {
  const start = Date.parse(row.acquiredAt);
  const period = row.hrEverySec * 1000;
  return iso(start + Math.max(1, Math.ceil((now - start) / period)) * period);
}

export const albumCard = ({ userId, ...row }, offer, now = Date.now()) =>
  ({ ...row, hrDeadline: hrDeadline(row, now), offer: offer ? card(offer) : null });

/* Усиления окна покупки или прокачки: премиальные — по premiumGate, перезарядка — 409 COOLDOWN, нет зарядов — 409 NO_CHARGES.
   → новые boosts и cooldowns пользователя для записи в той же транзакции */
export function spendBoosts(auth, u, defs, at) {
  const cooldowns = { ...u.cooldowns };
  const charges = { ...u.boosts };
  for (const b of defs) {
    if (b.premium) premiumGate(auth, u);
    const readyAt = Date.parse(cooldowns[b.id] ?? '');
    if (readyAt > at) {
      const wait = Math.ceil((readyAt - at) / 1000);
      throw new HttpError(409, 'COOLDOWN', `${b.name}: перезарядка, ещё ${wait} с`, { headers: { 'Retry-After': String(wait) }, extra: { readyAt: iso(readyAt) } });
    }
    if ((charges[b.id] ?? 0) < 1) throw new HttpError(409, 'NO_CHARGES', `${b.name}: заряды кончились. Загляни в Лавку`);
    charges[b.id] -= 1;
    if (b.cooldownSec) cooldowns[b.id] = iso(at + b.cooldownSec * 1000);
  }
  return { boosts: charges, cooldowns };
}

function parsePurchase(body) {
  const { offerId, expectedPrice, boosts = [] } = body ?? {};
  const fields = {};
  if (typeof offerId !== 'string' || !offerId) fields.offerId = 'Какой оффер берём?';
  if (typeof expectedPrice !== 'number' || !Number.isFinite(expectedPrice)) fields.expectedPrice = 'Нужна цена, которую видно на экране';
  if (!Array.isArray(boosts) || boosts.some((b) => typeof b !== 'string')) fields.boosts = 'Список id усилений';
  else if (new Set(boosts).size !== boosts.length) fields.boosts = 'Одно усиление дважды не включить';
  if (Object.keys(fields).length) throw invalid(fields);
  return { offerId, expectedPrice, boosts };
}

/* «2» , "2", W/"2" → 2. what — чья версия: карточки Альбома, оффера в HR-панели */
export function ifMatch(req, what = 'карточки', refusal = 'не перекладываем') {
  const header = req.headers['if-match'];
  if (header === undefined) throw new HttpError(428, 'PRECONDITION_REQUIRED', `Без If-Match ${refusal}: пришли версию ${what}`);
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim());
  if (!m) throw new HttpError(400, 'BAD_IF_MATCH', `If-Match — версия ${what}, например "3"`);
  return Number(m[1]);
}

export function createPurchases({ db, auth, achievements }) {
  const { requireAuth } = auth;
  const router = express.Router();

  router.post('/purchases', requireAuth, async (req, res) => {
    const idem = idempotency(req);
    const { offerId, expectedPrice, boosts } = parsePurchase(req.body);
    const { sub } = req.auth;
    if (idem) {
      const done = stored(await db.get(req.db, 'idempotency', idem.id), idem);
      if (done) return replay(res, done);
    }

    /* Усиления проверяются до транзакции: неизвестные, не для покупки, несовместимые — 422 */
    const defs = boosts.length ? await db.getMany(req.db, 'boosts', boosts) : [];
    const unknown = boosts.filter((id) => !defs.some((b) => b.id === id));
    if (unknown.length) throw invalid({ boosts: `Нет такого усиления: ${unknown.join(', ')}` });
    const wrong = defs.filter((b) => !(b.id in DISCOUNTS));
    if (wrong.length) throw new HttpError(422, 'BOOST_NOT_FOR_PURCHASE', `${wrong.map((b) => b.name).join(', ')} — не для окна покупки`, { fields: { boosts: 'Здесь работают только скидки' } });
    const clash = defs.find((b) => b.incompatible.some((id) => boosts.includes(id)));
    if (clash) {
      const other = defs.find((b) => clash.incompatible.includes(b.id));
      throw new HttpError(422, 'BOOSTS_INCOMPATIBLE', `«${clash.name}» и «${other.name}» вместе не работают: выбери одно`, { fields: { boosts: 'Несовместимые усиления' } });
    }

    const result = await retryTx(() => db.tx(req.db, async (t) => {
      if (idem) {
        const done = stored(await t.get('idempotency', idem.id), idem);
        if (done) return { done };   // параллельный запрос с этим ключом успел первым
      }
      const offer = await t.get('offers', offerId);
      if (!offer) throw notFound();
      if (offer.price !== expectedPrice) {
        throw new HttpError(409, 'PRICE_CHANGED', offer.price > expectedPrice ? 'Пока шли раздумья, цену подняли' : 'Пока шли раздумья, цена сменилась',
          { extra: { price: offer.price, expectedPrice } });
      }
      const u = await t.get('users', sub);
      if (!u) throw new HttpError(401, 'TOKEN_INVALID', 'Такого сотрудника нет');

      const at = Date.now();
      const { boosts: charges, cooldowns } = spendBoosts(req.auth, u, defs, at);
      const paid = Math.round(offer.price * (1 - defs.reduce((s, b) => s + DISCOUNTS[b.id], 0)));
      if (u.cookies < paid) throw new HttpError(409, 'NOT_ENOUGH_COOKIES', 'Печенек не хватает. Попроси аванс', { extra: { cookies: u.cookies, price: paid } });

      const purchase = { id: newId('p'), userId: sub, offerId, price: offer.price, paid, boosts, createdAt: iso(at) };
      await t.insert('purchases', purchase);
      const row = await t.insert('album', {
        id: newId('a'), userId: sub, offerId, purchaseId: purchase.id,
        shelf: null, level: 0, hrEverySec: (5 + crypto.randomInt(56)) * 60, acquiredAt: iso(at),
      });
      const ids = earned(u, 'purchase', { offer, at });
      const user = await t.update('users', sub, { cookies: u.cookies - paid, boosts: charges, cooldowns, achievements: [...u.achievements, ...ids] });
      const { userId, ...pub } = purchase;
      const body = { purchase: pub, card: albumCard(row, offer, at), user: publicUser(user), achievements: ids, serverTime: at };
      if (idem) await remember(t, idem, sub, 201, body);
      return { body, user, ids };
    }));

    if (result.done) return replay(res, result.done);
    log('http', `покупка ${offerId} · ${result.user.login} · ${result.body.purchase.paid} 🍪${idem ? ` · ключ ${idem.key}` : ''}`);
    announce(result.user, result.ids);
    res.status(201).json(result.body);
  });

  router.get('/purchases', requireAuth, async (req, res) => {
    const rows = (await db.where(req.db, 'purchases', (p) => p.userId === req.auth.sub)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ items: rows.map(({ userId, ...p }) => p), total: rows.length });
  });

  /* ?shelf=accept|think|mom|frame — одна полка, ?shelf=none — неразобранные */
  router.get('/album', requireAuth, async (req, res) => {
    const shelf = typeof req.query.shelf === 'string' ? req.query.shelf : '';
    if (shelf && shelf !== 'none' && !SHELF_IDS.includes(shelf)) throw invalid({ shelf: `Полки: ${SHELF_IDS.join(', ')}, none` });
    const fits = (a) => !shelf || (shelf === 'none' ? !a.shelf : a.shelf === shelf);
    const rows = (await db.where(req.db, 'album', (a) => a.userId === req.auth.sub && fits(a)))
      .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt) || a.id.localeCompare(b.id));
    const offers = new Map((await db.getMany(req.db, 'offers', [...new Set(rows.map((a) => a.offerId))])).map((o) => [o.id, o]));
    const now = Date.now();
    res.json({ items: rows.map((a) => albumCard(a, offers.get(a.offerId), now)), total: rows.length, shelves: SHELVES, serverTime: now });
  });

  /* Без retryTx: конфликт версии здесь — ответ клиенту, а не повод попробовать ещё раз */
  router.patch('/album/:id', requireAuth, async (req, res) => {
    const expected = ifMatch(req);
    const { shelf } = req.body ?? {};
    if (shelf !== null && !SHELF_IDS.includes(shelf)) throw invalid({ shelf: `Полки: ${SHELF_IDS.join(', ')} или null` });
    const { sub } = req.auth;
    const row = await db.tx(req.db, async (t) => {
      const a = await t.get('album', req.params.id);
      if (!a || a.userId !== sub) throw notFound();
      return t.update('album', a.id, { shelf, shelvedAt: iso() }, expected);
    });
    let ids = [];
    if (shelf) {
      const mine = await db.where(req.db, 'album', (a) => a.userId === sub);
      ids = await achievements.award(req.db, sub, 'shelf', { shelves: new Set(mine.map((a) => a.shelf).filter(Boolean)).size });
    }
    const offer = await db.get(req.db, 'offers', row.offerId);
    res.setHeader('ETag', `"${row.v}"`);
    res.json({ card: albumCard(row, offer), achievements: ids, serverTime: Date.now() });
  });

  return router;
}
