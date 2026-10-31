/* Боты «Офферомании»: биржа, продавцы лотов и «Вечный кандидат».
   - Бегущая строка — 24 самых новых оффера сида (o00001…o00024, они же верх Барахолки по умолчанию). Раз в BOTS.priceMs бот
     двигает цену одного из них на 3–12% в пределах редкости → событие price. Покупка по старой цене получит 409 PRICE_CHANGED (Т13).
   - «Заморозка» (премиальное усиление): пока она включена, боты не трогают цены офферов из вишлиста того, кто её включил.
   - GET /ticker — офферы бегущей строки с текущими ценами; дальше их обновляют события price из /stream.
   - Продавцы держат открытыми BOTS.lots лотов: закончился один — выставляют новый. Старт — половина цены оффера,
     потолок «Вечного кандидата» (botCap) — 110–150% цены.
   - «Вечный кандидат» отвечает на ставку человека с шансом BOTS.outbidRate примерно через BOTS.outbidMs: на 1–3 шага выше,
     но не дороже потолка. На свежий лот человека он иногда ставит первым. Перебитому человеку 🍪 возвращаются, как при любой ставке. */
import crypto from 'node:crypto';
import express from 'express';
import { AUCTION, BOTS } from './config.js';
import { DbError } from './db.js';
import { HttpError } from './errors.js';
import { card } from './catalog.js';
import { isBot } from './auction.js';
import { RARITIES } from './seed.js';
import { bus } from './bus.js';
import { log } from './log.js';

const offerId = (n) => `o${String(n).padStart(5, '0')}`;
export const TICKER = [...Array(24)].map((_, i) => offerId(i + 1));
export const ETERNAL = { id: 'bot:eternal', name: 'Вечный кандидат' };
export const SELLERS = [
  { id: 'bot:previous', name: 'Прошлый владелец' },
  { id: 'bot:recruiter', name: 'Рекрутер-фрилансер' },
  { id: 'bot:reseller', name: 'Перекупщик офферов' },
];
const MOVE = [0.03, 0.12];
const CAP = [1.1, 1.5];
const USER_LOT_CAP = 1.2;   // на лотах людей потолка в строке нет — считается от цены оффера
const OFFERS_TOTAL = 10000;

const between = ([a, b]) => a + Math.random() * (b - a);
const pick = (list) => list[crypto.randomInt(list.length)];
const clamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));
/* Отказ, который боту не страшен: перебили раньше, торги кончились, база занята */
const expected = (e) => e instanceof HttpError || e instanceof DbError;

export function createBots({ db, auction }) {
  const router = express.Router();
  const timers = new Set();
  const later = (ms, fn) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn().catch((e) => {
        if (!expected(e)) log('err', `бот: ${e.stack ?? e}`);
      });
    }, ms);
    timer.unref();
    timers.add(timer);
  };

  /* ---------- биржа ---------- */

  async function frozenOffers() {
    const now = Date.now();
    const freezers = new Set((await db.where(null, 'users', (u) => Date.parse(u.effects?.freeze ?? '') > now)).map((u) => u.id));
    if (!freezers.size) return new Set();
    return new Set((await db.where(null, 'wishlist', (w) => freezers.has(w.userId))).map((w) => w.offerId));
  }

  async function movePrice() {
    const frozen = await frozenOffers();
    const free = TICKER.filter((id) => !frozen.has(id));
    if (!free.length) return;
    const id = pick(free);
    const change = await db.tx(null, async (t) => {
      const o = await t.get('offers', id);
      if (!o) return null;
      const range = RARITIES.find((r) => r.id === o.rarity).price;
      const sign = Math.random() < 0.5 ? -1 : 1;
      const d = between(MOVE);
      let price = clamp(Math.round(o.price * (1 + sign * d)), range);
      if (price === o.price) price = clamp(Math.round(o.price * (1 - sign * d)), range);   // упёрлись в край — в другую сторону
      if (price === o.price) return null;
      return { offer: await t.update('offers', id, { price }), was: o.price };
    });
    if (change) bus.emit('price', { offerId: id, price: change.offer.price, was: change.was, by: 'bot', at: Date.now() });
  }

  let moving = false;
  if (BOTS.priceMs > 0) {
    const tick = setInterval(() => {
      if (moving) return;   // база тормозит — следующий шаг ждёт, а не копится
      moving = true;
      movePrice().catch((e) => {
        if (!expected(e)) log('err', `биржа: ${e.stack ?? e}`);
      }).finally(() => (moving = false));
    }, BOTS.priceMs);
    tick.unref();
    timers.add(tick);
  }

  router.get('/ticker', async (req, res) => {
    const items = await db.getMany(req.db, 'offers', TICKER);
    res.json({ items: items.map(card), priceMs: BOTS.priceMs, serverTime: Date.now() });
  });

  /* ---------- продавцы ---------- */

  async function refill() {
    const open = await db.where(null, 'lots', (l) => l.status === 'open' && isBot(l.sellerId));
    for (let i = open.length; i < BOTS.lots; i++) {
      const offer = await db.get(null, 'offers', offerId(1 + crypto.randomInt(OFFERS_TOTAL)));
      if (!offer) continue;
      const lot = await auction.openBotLot(offer, pick(SELLERS), {
        startPrice: Math.max(AUCTION.step, Math.round(offer.price * 0.5 / AUCTION.step) * AUCTION.step),
        botCap: Math.round(offer.price * between(CAP)),
        durationSec: AUCTION.lotSec * between([0.6, 1.4]),
      });
      log('bot', `лот ${lot.id} · ${lot.sellerName} · ${offer.title} от ${lot.startPrice} 🍪`);
    }
  }

  /* Пополнение — по очереди: два лота, закончившихся разом, не дадут лишний */
  let refilling = Promise.resolve();
  const refillSoon = () => {
    refilling = refilling.then(refill).catch((e) => log('err', `продавцы: ${e.stack ?? e}`));
  };
  refillSoon();
  bus.on('lot-end', (e) => {
    if (isBot(e.seller?.id)) refillSoon();
  });

  /* ---------- «Вечный кандидат» ---------- */

  async function outbid(lotId, price) {
    const lot = await db.get(null, 'lots', lotId);
    if (!lot || lot.status !== 'open' || lot.price !== price || lot.leaderId === ETERNAL.id) return;   // уже перебили или торги кончились
    const cap = lot.botCap ?? Math.round(((await db.get(null, 'offers', lot.offerId))?.price ?? 0) * USER_LOT_CAP);
    const min = lot.bids ? lot.price + lot.step : lot.startPrice;
    if (min > cap) return log('bot', `${ETERNAL.name} пасует на ${lot.id}: ${min} 🍪 — дороже, чем оффер стоит`);
    await auction.placeBid(null, lot.id, ETERNAL, { amount: Math.min(cap, min + lot.step * crypto.randomInt(3)), expected: lot.price });
  }

  const react = (lotId, price) => {
    if (BOTS.outbidRate > 0 && Math.random() < BOTS.outbidRate) later(BOTS.outbidMs * between([0.6, 1.4]), () => outbid(lotId, price));
  };
  bus.on('bid', (e) => {
    if (!isBot(e.leader?.id)) react(e.lotId, e.price);
  });
  bus.on('lot-open', (lot) => {
    if (!isBot(lot.sellerId)) react(lot.id, lot.price);
  });

  return {
    router,
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
