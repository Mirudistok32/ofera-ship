/* Аукцион «Офферомании»: свои дубли и лоты ботов.
   - GET /lots — открытые лоты (?status=ended — последние 20 законченных), GET /lots/:id — лот и последние ставки.
   - POST /lots { cardId, startPrice, durationSec? } — выставить дубль из Альбома: последний экземпляр оффера не продаётся.
     Карточка на лоте помечена lotId: её не прокачать и не слить, пока идут торги.
   - POST /lots/:id/bids { amount, expected } — ставка одной транзакцией. expected — цена лота, которую видел клиент:
     не совпала — 409 OUTBID с текущей ценой (перебили, пока думали). Шаг меньше 10 🍪 — 422 BID_STEP.
     🍪 ставки замораживаются: уходят из cookies в frozen и возвращаются, когда ставку перебьют.
     Антиснайпинг: ставка в последние 10 с продлевает торги на 15 с (AUCTION в config.js).
   - Конец торгов — таймер на лот: карточка уходит победителю, 🍪 — продавцу, победитель получает ачивку «Продано!».
     Без ставок лот закрывается unsold, карточка возвращается продавцу. После перезапуска таймеры ставятся заново.
   - serverTime — во всех ответах, и в ошибках тоже: таймер лота считается по часам сервера, а не браузера.
   В шину уходят bid и lot-end (SSE — stream.js). Боты (bots.js) ставят через тот же placeBid. */
import crypto from 'node:crypto';
import express from 'express';
import { AUCTION } from './config.js';
import { HttpError } from './errors.js';
import { publicUser } from './auth.js';
import { card, retryTx } from './catalog.js';
import { earned, announce } from './achievements.js';
import { bus } from './bus.js';
import { log } from './log.js';

export const LOT_DURATION = { min: 10, max: 3600 };
export const START_PRICE = { min: 10, max: 5000 };
const ENDED_SHOWN = 20;
const BIDS_SHOWN = 20;

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const newId = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
export const isBot = (id) => typeof id === 'string' && id.startsWith('bot:');
const minBid = (lot) => (lot.bids ? lot.price + lot.step : lot.startPrice);
const person = (id, name) => (id ? { id, name } : null);

/* Ошибка аукциона с serverTime: клиент сверяет часы даже по отказу */
const fail = (status, code, message, { fields, headers, extra } = {}) =>
  new HttpError(status, code, message, { fields, headers, extra: { ...extra, serverTime: Date.now() } });
const notFound = () => fail(404, 'NOT_FOUND', 'Лот снят, но объявление провисит ещё год');
const invalid = (fields) => fail(422, 'VALIDATION', 'Ставка заполнена с ошибками', { fields });

export const publicLot = ({ botCap, cardId, ...lot }, offer) => ({
  ...lot,
  seller: person(lot.sellerId, lot.sellerName),
  leader: person(lot.leaderId, lot.leaderName),
  minBid: minBid(lot),
  offer: offer ? card(offer) : null,
});

const int = (x) => Number.isInteger(x);

function parseBid(body) {
  const { amount, expected } = body ?? {};
  const fields = {};
  if (!int(amount) || amount < 1) fields.amount = 'Ставка — целое число 🍪';
  if (!int(expected) || expected < 0) fields.expected = 'Нужна цена лота, которую видно на экране';
  if (Object.keys(fields).length) throw invalid(fields);
  return { amount, expected };
}

function parseLot(body) {
  const { cardId, startPrice, durationSec = AUCTION.lotSec } = body ?? {};
  const fields = {};
  if (typeof cardId !== 'string' || !cardId) fields.cardId = 'Какую карточку выставляем?';
  if (!int(startPrice) || startPrice < START_PRICE.min || startPrice > START_PRICE.max) fields.startPrice = `Стартовая цена — от ${START_PRICE.min} до ${START_PRICE.max} 🍪`;
  if (!int(durationSec) || durationSec < LOT_DURATION.min || durationSec > LOT_DURATION.max) fields.durationSec = `Торги идут от ${LOT_DURATION.min} с до часа`;
  if (Object.keys(fields).length) throw fail(422, 'VALIDATION', 'Лот заполнен с ошибками', { fields });
  return { cardId, startPrice, durationSec };
}

export function createAuction({ db, auth }) {
  const { requireAuth } = auth;
  const router = express.Router();
  const timers = new Map();

  /* ---------- ставка ---------- */

  /* bidder — пользователь { id } или бот { id: 'bot:…', name }. Бот 🍪 не замораживает, но вернуть их перебитому человеку обязан */
  async function placeBid(ctx, lotId, bidder, { amount, expected }) {
    const result = await retryTx(() => db.tx(ctx, async (t) => {
      const lot = await t.get('lots', lotId);
      if (!lot) throw notFound();
      const at = Date.now();
      if (lot.status !== 'open' || Date.parse(lot.endsAt) <= at) throw fail(409, 'LOT_ENDED', 'Торги закончились: молоток уже стукнул', { extra: { lot: publicLot(lot) } });
      if (lot.sellerId === bidder.id) throw fail(409, 'OWN_LOT', 'На свой лот не ставят — это уже не торги, а накрутка');
      if (lot.leaderId === bidder.id) throw fail(409, 'ALREADY_LEADING', 'Ставка и так твоя — жди, пока перебьют', { extra: { price: lot.price, endsAt: lot.endsAt } });
      if (lot.price !== expected) {
        throw fail(409, 'OUTBID', 'Пока шли раздумья, ставку перебили', {
          extra: { price: lot.price, minBid: minBid(lot), leader: person(lot.leaderId, lot.leaderName), endsAt: lot.endsAt, expected },
        });
      }
      const need = minBid(lot);
      if (amount < need) {
        const first = !lot.bids;
        throw fail(422, 'BID_STEP', first ? `Стартовая цена — ${lot.startPrice} 🍪` : `Шаг ставки — от ${lot.step} 🍪`, {
          fields: { amount: first ? `Не меньше стартовой цены: ${need} 🍪` : `Не меньше ${need} 🍪: текущая ${lot.price} + шаг ${lot.step}` },
          extra: { minBid: need, price: lot.price },
        });
      }

      let user = null;
      if (!isBot(bidder.id)) {
        const u = await t.get('users', bidder.id);
        if (!u) throw fail(401, 'TOKEN_INVALID', 'Такого сотрудника нет');
        if (u.cookies < amount) throw fail(409, 'NOT_ENOUGH_COOKIES', 'Печенек не хватает. Попроси аванс', { extra: { cookies: u.cookies, amount } });
        user = u;
      }
      /* Прошлый лидер — человек: его 🍪 размораживаются в этой же транзакции */
      let refunded = null;
      if (lot.leaderId && !isBot(lot.leaderId)) {
        const prev = await t.get('users', lot.leaderId);
        if (prev) refunded = await t.update('users', prev.id, { cookies: prev.cookies + lot.price, frozen: Math.max(0, (prev.frozen ?? 0) - lot.price) });
      }
      if (user) user = await t.update('users', user.id, { cookies: user.cookies - amount, frozen: (user.frozen ?? 0) + amount });

      const extended = Date.parse(lot.endsAt) - at <= AUCTION.snipeSec * 1000;
      const endsAt = extended ? iso(Date.parse(lot.endsAt) + AUCTION.extendSec * 1000) : lot.endsAt;
      const name = user?.name ?? bidder.name;
      const next = await t.update('lots', lot.id, {
        price: amount, leaderId: bidder.id, leaderName: name, bids: lot.bids + 1, endsAt, extensions: lot.extensions + (extended ? 1 : 0),
      });
      const bid = { id: newId('b'), lotId: lot.id, bidderId: bidder.id, bidderName: name, amount, extended, createdAt: iso(at) };
      await t.insert('bids', bid);
      return { lot: next, bid, user, refunded, outbid: lot.leaderId, at };
    }));

    const { lot, bid, at } = result;
    log(isBot(bid.bidderId) ? 'bot' : 'http', `ставка ${lot.id} · ${bid.bidderName} · ${bid.amount} 🍪${bid.extended ? ` · антиснайпинг до ${lot.endsAt}` : ''}`);
    bus.emit('bid', {
      lotId: lot.id, offerId: lot.offerId, bidId: bid.id, amount: bid.amount, price: lot.price, minBid: minBid(lot),
      leader: person(lot.leaderId, lot.leaderName), outbid: result.outbid, bids: lot.bids, endsAt: lot.endsAt, extended: bid.extended, at,
    });
    return result;
  }

  /* ---------- конец торгов ---------- */

  function schedule(lot) {
    clearTimeout(timers.get(lot.id));
    const timer = setTimeout(() => close(lot.id).catch((e) => {
      log('err', `лот ${lot.id}: ${e.message} — повтор через 1 с`);
      setTimeout(() => schedule(lot), 1000).unref();
    }), Math.max(0, Date.parse(lot.endsAt) - Date.now()));
    timer.unref();
    timers.set(lot.id, timer);
  }

  /* Таймер стоит на старый endsAt: если антиснайпинг продлил торги, лот просто переставляется на новый срок */
  async function close(lotId) {
    timers.delete(lotId);
    const out = await retryTx(() => db.tx(null, async (t) => {
      const lot = await t.get('lots', lotId);
      if (!lot || lot.status !== 'open') return null;
      const at = Date.now();
      if (Date.parse(lot.endsAt) > at) return { later: lot };
      const human = (id) => id && !isBot(id);
      const own = human(lot.sellerId) ? await t.get('album', lot.cardId) : null;
      const winner = human(lot.leaderId) ? await t.get('users', lot.leaderId) : null;
      const end = (status, extra = {}) => t.update('lots', lot.id, { status, endedAt: iso(at), ...extra });

      /* Карточка продавца пропала (её успела слить задача прокачки, начатая до выставления) — торги отменяются, 🍪 лидеру назад */
      if (human(lot.sellerId) && (!own || own.userId !== lot.sellerId)) {
        if (winner) await t.update('users', winner.id, { cookies: winner.cookies + lot.price, frozen: Math.max(0, (winner.frozen ?? 0) - lot.price) });
        return { lot: await end('cancelled'), ids: [] };
      }
      if (!lot.leaderId) {
        if (own) await t.update('album', own.id, { lotId: null });
        return { lot: await end('unsold'), ids: [] };
      }

      let ids = [];
      let won = null;
      if (winner) {
        ids = earned(winner, 'auction-win', {});
        await t.update('users', winner.id, { frozen: Math.max(0, (winner.frozen ?? 0) - lot.price), achievements: [...winner.achievements, ...ids] });
        const row = { userId: winner.id, purchaseId: null, shelf: null, level: own?.level ?? 0, lotId: null, fromLot: lot.id, acquiredAt: iso(at) };
        won = own
          ? await t.update('album', own.id, row)
          : await t.insert('album', { id: newId('a'), offerId: lot.offerId, hrEverySec: (5 + crypto.randomInt(56)) * 60, ...row });
      } else if (own) {
        await t.remove('album', own.id);   // карточку купил бот — у продавца её больше нет
      }
      if (human(lot.sellerId)) {
        const seller = await t.get('users', lot.sellerId);
        if (seller) await t.update('users', seller.id, { cookies: seller.cookies + lot.price });
      }
      return { lot: await end('sold', { cardId: won?.id ?? lot.cardId }), winner, ids };
    }));

    if (!out) return;
    if (out.later) return schedule(out.later);
    const { lot, winner, ids } = out;
    const people = [lot.sellerId, lot.leaderId].some((id) => id && !isBot(id));
    log(people ? 'http' : 'bot', `лот ${lot.id} · ${lot.status}${lot.leaderId ? ` · ${lot.leaderName} за ${lot.price} 🍪` : ''}`);
    bus.emit('lot-end', {
      lotId: lot.id, offerId: lot.offerId, status: lot.status, price: lot.price,
      winner: lot.status === 'sold' ? person(lot.leaderId, lot.leaderName) : null, seller: person(lot.sellerId, lot.sellerName), at: Date.now(),
    });
    if (winner) announce(winner, ids);
  }

  /* Лот бота: оффер, стартовая цена и потолок, до которого «Вечный кандидат» готов перебивать */
  async function openBotLot(offer, seller, { startPrice, botCap, durationSec }) {
    const at = Date.now();
    const lot = await db.tx(null, (t) => t.insert('lots', {
      id: newId('l'), offerId: offer.id, cardId: null, sellerId: seller.id, sellerName: seller.name,
      startPrice, price: startPrice, step: AUCTION.step, leaderId: null, leaderName: null, bids: 0, extensions: 0, botCap,
      startsAt: iso(at), endsAt: iso(at + durationSec * 1000), status: 'open', endedAt: null,
    }));
    schedule(lot);
    return lot;
  }

  /* Незаконченные торги прошлого запуска: просроченные закроются сразу */
  for (const lot of db.table('lots').values()) if (lot.status === 'open') schedule(lot);

  /* ---------- роуты ---------- */

  const withOffers = async (ctx, lots) => {
    const offers = new Map((await db.getMany(ctx, 'offers', [...new Set(lots.map((l) => l.offerId))])).map((o) => [o.id, o]));
    return lots.map((l) => publicLot(l, offers.get(l.offerId)));
  };

  router.get('/lots', async (req, res) => {
    const ended = req.query.status === 'ended';
    if (req.query.status !== undefined && !['open', 'ended'].includes(req.query.status)) throw invalid({ status: 'open или ended' });
    let rows = await db.where(req.db, 'lots', (l) => (ended ? l.status !== 'open' : l.status === 'open'));
    rows = ended
      ? rows.sort((a, b) => b.endedAt.localeCompare(a.endedAt)).slice(0, ENDED_SHOWN)
      : rows.sort((a, b) => a.endsAt.localeCompare(b.endsAt) || a.id.localeCompare(b.id));
    res.json({ items: await withOffers(req.db, rows), total: rows.length, step: AUCTION.step, snipeSec: AUCTION.snipeSec, extendSec: AUCTION.extendSec, serverTime: Date.now() });
  });

  router.get('/lots/:id', async (req, res) => {
    const lot = await db.get(req.db, 'lots', req.params.id);
    if (!lot) throw notFound();
    const [item] = await withOffers(req.db, [lot]);
    const bids = (await db.where(req.db, 'bids', (b) => b.lotId === lot.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.amount - a.amount).slice(0, BIDS_SHOWN)
      .map(({ v, lotId, ...b }) => b);
    res.json({ lot: item, bids, serverTime: Date.now() });
  });

  router.post('/lots', requireAuth, async (req, res) => {
    const { cardId, startPrice, durationSec } = parseLot(req.body);
    const { sub } = req.auth;
    const mine = await db.where(req.db, 'album', (a) => a.userId === sub);
    const own = mine.find((a) => a.id === cardId);
    if (!own) throw fail(404, 'NOT_FOUND', 'Карточки нет — или она не твоя');
    if (own.lotId) throw fail(409, 'CARD_ON_LOT', 'Эта карточка уже на торгах', { extra: { lotId: own.lotId } });
    if (!mine.some((a) => a.offerId === own.offerId && a.id !== own.id && !a.lotId)) {
      throw fail(422, 'NOT_A_DUPLICATE', 'На аукцион идут только дубли: последний экземпляр оставь себе', { fields: { cardId: 'Нужен второй такой же оффер в Альбоме' } });
    }
    const lot = await retryTx(() => db.tx(req.db, async (t) => {
      const c = await t.get('album', cardId);
      if (!c || c.userId !== sub) throw fail(404, 'NOT_FOUND', 'Карточки нет — или она не твоя');
      if (c.lotId) throw fail(409, 'CARD_ON_LOT', 'Эта карточка уже на торгах', { extra: { lotId: c.lotId } });
      const u = await t.get('users', sub);
      const at = Date.now();
      const lot = await t.insert('lots', {
        id: newId('l'), offerId: c.offerId, cardId, sellerId: sub, sellerName: u.name,
        startPrice, price: startPrice, step: AUCTION.step, leaderId: null, leaderName: null, bids: 0, extensions: 0, botCap: null,
        startsAt: iso(at), endsAt: iso(at + durationSec * 1000), status: 'open', endedAt: null,
      });
      await t.update('album', cardId, { lotId: lot.id });
      return lot;
    }));
    schedule(lot);
    bus.emit('lot-open', lot);   // внутреннее событие для ботов, в SSE не идёт
    log('http', `лот ${lot.id} · ${lot.sellerName} выставил ${lot.offerId} от ${startPrice} 🍪 на ${durationSec} с`);
    const [item] = await withOffers(req.db, [lot]);
    res.status(201).json({ lot: item, serverTime: Date.now() });
  });

  router.post('/lots/:id/bids', requireAuth, async (req, res) => {
    const body = parseBid(req.body);
    const { lot, bid, user } = await placeBid(req.db, req.params.id, { id: req.auth.sub }, body);
    const [item] = await withOffers(req.db, [lot]);
    const { lotId, ...pub } = bid;
    res.status(201).json({ lot: item, bid: pub, user: publicUser(user), serverTime: Date.now() });
  });

  return { router, placeBid, openBotLot };
}
