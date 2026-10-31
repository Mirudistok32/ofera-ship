/* Лавка и ачивки «Офферомании».
   - GET /shop — усиления (цена, заряды, перезарядка, срок эффекта); справочник с ETag и 304, как /flags.
   - POST /shop/:id/buy — заряд за 🍪. Премиальные усиления и «Аванс» не продаются.
   - POST /boosts/:id/use — включить усиление: минус заряд, перезарядка, эффект до effects[id].
     «Аванс» зарядов не тратит: +50 🍪 и перезарядка 10 минут. Премиальные — только с plan: premium в токене и в базе (premiumGate).
     Скидочные (письмо, «Оффер на руках») и «Рекомендация» включаются в окне покупки или прокачки, не здесь.
   - GET /achievements — все ачивки с отметкой got. Выдаёт их движок ачивок (achievements.js).
   Все записи — транзакцией: два «Аванса» наперегонки дают +50 один раз. */
import express from 'express';
import { HttpError } from './errors.js';
import { publicUser, premiumGate } from './auth.js';
import { reference, retryTx } from './catalog.js';
import { log } from './log.js';

export const ADVANCE = { id: 'advance', cookies: 50 };

const iso = (ms) => new Date(ms).toISOString();
const notFound = () => new HttpError(404, 'NOT_FOUND', 'Такого в Лавке не держат');
const gone = () => new HttpError(401, 'TOKEN_INVALID', 'Такого сотрудника нет');

export function createShop({ db, auth }) {
  const { requireAuth } = auth;
  const router = express.Router();

  router.get('/shop', reference(db, 'boosts'));

  router.post('/shop/:id/buy', requireAuth, async (req, res) => {
    const { id } = req.params;
    const user = await retryTx(() => db.tx(req.db, async (t) => {
      const boost = await t.get('boosts', id);
      if (!boost) throw notFound();
      if (boost.premium || !boost.price) throw new HttpError(422, 'NOT_FOR_SALE', boost.premium ? 'Это не продаётся: только с «Синдромом отличника»' : 'Аванс не покупают — его ждут');
      const u = await t.get('users', req.auth.sub);
      if (!u) throw gone();
      const have = u.boosts?.[id] ?? 0;
      if (have >= boost.qty) throw new HttpError(422, 'LIMIT', `Больше ${boost.qty} в рюкзак не влезет`);
      if (u.cookies < boost.price) throw new HttpError(409, 'NOT_ENOUGH_COOKIES', 'Печенек не хватает. Попроси аванс', { extra: { cookies: u.cookies, price: boost.price } });
      return t.update('users', u.id, { cookies: u.cookies - boost.price, boosts: { ...u.boosts, [id]: have + 1 } });
    }));
    log('http', `Лавка: покупка ${id} · ${user.login} · осталось ${user.cookies} 🍪`);
    res.json({ boost: id, user: publicUser(user), serverTime: Date.now() });
  });

  router.post('/boosts/:id/use', requireAuth, async (req, res) => {
    const { id } = req.params;
    const user = await retryTx(() => db.tx(req.db, async (t) => {
      const boost = await t.get('boosts', id);
      if (!boost) throw notFound();
      if (!boost.durationSec && id !== ADVANCE.id) throw new HttpError(422, 'USE_AT_PURCHASE', 'Это усиление включается в окне покупки или прокачки');
      const u = await t.get('users', req.auth.sub);
      if (!u) throw gone();
      if (boost.premium) premiumGate(req.auth, u);
      const now = Date.now();
      const readyAt = Date.parse(u.cooldowns?.[id] ?? '');
      if (readyAt > now) {
        const wait = Math.ceil((readyAt - now) / 1000);
        throw new HttpError(409, 'COOLDOWN', `${boost.name}: перезарядка, ещё ${wait} с`, { headers: { 'Retry-After': String(wait) }, extra: { readyAt: iso(readyAt) } });
      }
      const patch = boost.cooldownSec ? { cooldowns: { ...u.cooldowns, [id]: iso(now + boost.cooldownSec * 1000) } } : {};
      if (id === ADVANCE.id) return t.update('users', u.id, { ...patch, cookies: u.cookies + ADVANCE.cookies });
      const left = u.boosts?.[id] ?? 0;
      if (left < 1) throw new HttpError(409, 'NO_CHARGES', `${boost.name}: заряды кончились. Загляни в Лавку`);
      return t.update('users', u.id, { ...patch, boosts: { ...u.boosts, [id]: left - 1 }, effects: { ...u.effects, [id]: iso(now + boost.durationSec * 1000) } });
    }));
    log('http', `усиление ${id} · ${user.login} · ${user.cookies} 🍪`);
    res.json({ boost: id, user: publicUser(user), serverTime: Date.now() });
  });

  router.get('/achievements', requireAuth, async (req, res) => {
    const [user, defs] = await Promise.all([
      db.get(req.db, 'users', req.auth.sub),
      db.where(req.db, 'achievementDefs', () => true),
    ]);
    if (!user) throw gone();
    const got = new Set(user.achievements);
    res.json({ items: defs.map(({ v, ...a }) => ({ ...a, got: got.has(a.id) })), got: got.size, total: defs.length });
  });

  return router;
}
