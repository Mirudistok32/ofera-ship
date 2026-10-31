/* Премиум «Синдром отличника»: 3 ачивки со счёта (trophies) → премиум на 15 минут (QUEST_PREMIUM_SEC) и полные заряды премиальных усилений.
   - Тариф живёт в токене: сразу после покупки премиальные адреса отвечают 403 PLAN_STALE, пока клиент не сделает refresh.
     Кончился премиум — то же в обратную сторону: токен ещё говорит premium, база уже free.
   - GET /premium — состояние для экрана покупки; GET /lounge — «Переговорка отличников», закрытая страница только для премиума.
   - Часы премиума: таймер на каждого с купленным премиумом → событие premium-end в шине (в SSE — через /stream).
     Сервер был выключен в момент конца — события нет, но planOf всё равно считает по premiumUntil. */
import express from 'express';
import { PREMIUM } from './config.js';
import { HttpError } from './errors.js';
import { planOf, publicUser, premiumGate } from './auth.js';
import { card, retryTx } from './catalog.js';
import { BOOSTS } from './seed.js';
import { bus } from './bus.js';
import { log } from './log.js';

const PREMIUM_BOOSTS = BOOSTS.filter((b) => b.premium);
const trophies = (u) => u.achievements.length - (u.achievementsSpent ?? 0);

/* onEnd(user) — когда премиум пользователя кончился; schedule повторно для того же пользователя переставляет таймер */
export function premiumClock(onEnd) {
  const timers = new Map();
  return {
    schedule(user) {
      clearTimeout(timers.get(user.id));
      timers.delete(user.id);
      const left = Date.parse(user.premiumUntil ?? '') - Date.now();
      if (user.plan === 'premium' || !(left > 0)) return;   // премиум навсегда не кончается
      const timer = setTimeout(() => {
        timers.delete(user.id);
        onEnd(user);
      }, left);
      timer.unref();
      timers.set(user.id, timer);
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

export function createPremium({ db, auth }) {
  const { requireAuth } = auth;
  const router = express.Router();
  const clock = premiumClock((user) => {
    log('auth', `премиум ${user.login} закончился`);
    bus.emit('premium-end', { userId: user.id, at: Date.now() });
  });
  for (const u of db.table('users').values()) clock.schedule(u);

  const me = async (req) => {
    const user = await db.get(req.db, 'users', req.auth.sub);
    if (!user) throw new HttpError(401, 'TOKEN_INVALID', 'Такого сотрудника нет');
    return user;
  };

  router.get('/premium', requireAuth, async (req, res) => {
    const user = await me(req);
    res.json({
      plan: planOf(user), tokenPlan: req.auth.plan, forever: user.plan === 'premium', premiumUntil: user.premiumUntil,
      cost: PREMIUM.cost, durationSec: PREMIUM.sec, trophies: trophies(user), serverTime: Date.now(),
    });
  });

  router.post('/premium', requireAuth, async (req, res) => {
    const user = await retryTx(() => db.tx(req.db, async (t) => {
      const u = await t.get('users', req.auth.sub);
      if (!u) throw new HttpError(401, 'TOKEN_INVALID', 'Такого сотрудника нет');
      if (planOf(u) === 'premium') {
        throw new HttpError(409, 'ALREADY_PREMIUM', u.plan === 'premium' ? '«Синдром отличника» у тебя навсегда' : 'Премиум уже идёт — дождись конца', { extra: { premiumUntil: u.premiumUntil } });
      }
      if (trophies(u) < PREMIUM.cost) {
        throw new HttpError(409, 'NOT_ENOUGH_ACHIEVEMENTS', `Премиум стоит ${PREMIUM.cost} 🏆, на счету ${trophies(u)}`, { extra: { trophies: trophies(u), cost: PREMIUM.cost } });
      }
      const boosts = { ...u.boosts };
      for (const b of PREMIUM_BOOSTS) boosts[b.id] = Math.max(boosts[b.id] ?? 0, b.qty);
      return t.update('users', u.id, {
        premiumUntil: new Date(Date.now() + PREMIUM.sec * 1000).toISOString(),
        achievementsSpent: (u.achievementsSpent ?? 0) + PREMIUM.cost,
        boosts,
      });
    }));
    clock.schedule(user);
    log('auth', `премиум ${user.login} до ${user.premiumUntil} · токен ещё ${req.auth.plan}, нужен refresh`);
    res.json({ user: publicUser(user), premiumUntil: user.premiumUntil, tokenPlan: req.auth.plan, refreshNeeded: true, serverTime: Date.now() });
  });

  /* Закрытая страница: самые дорогие мифические офферы — только с премиумом в токене и в базе */
  router.get('/lounge', requireAuth, async (req, res) => {
    premiumGate(req.auth, await me(req));
    const items = (await db.where(req.db, 'offers', (o) => o.rarity === 'mythic')).sort((a, b) => b.price - a.price).slice(0, 10).map(card);
    res.json({ title: 'Переговорка отличников', items, serverTime: Date.now() });
  });

  return { router, clock };
}
