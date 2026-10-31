/* Движок ачивок «Офферомании». Роуты сообщают о событии (покупка, просмотр, вишлист, полка, прокачка, аукцион),
   правило решает по данным события, выдана ли ачивка. Выданная — навсегда; на премиум тратится счёт (trophies), не сами ачивки.
   - earned(user, event, data) — чистая функция: какие ачивки это событие добавляет. Покупка зовёт её внутри своей транзакции.
   - award(ctx, userId, event, data) — то же отдельной транзакцией, для событий после основной записи.
   - noteView — «Насмотренность»: запоминает до 10 открытых офферов, пока ачивки нет.
   Новые ачивки уходят в шину событием achievement (в SSE — через /stream, только владельцу). «Первый вход» и «Онбординг» выдаёт сид. */
import { ACHIEVEMENTS } from './seed.js';
import { retryTx } from './catalog.js';
import { bus } from './bus.js';
import { log } from './log.js';

export const WATCHER_VIEWS = 10;
export const WISHLIST_GOAL = 5;

const RULES = [
  { id: 'family', on: 'purchase', test: ({ offer }) => offer.flags.includes('family') },
  { id: 'red-flag', on: 'purchase', test: ({ offer }) => offer.flags.length >= 3 },
  { id: 'night-shift', on: 'purchase', test: ({ at }) => new Date(at).getHours() < 5 },   // по часам сервера
  { id: 'watcher', on: 'view', test: ({ viewed }) => viewed >= WATCHER_VIEWS },
  { id: 'wishlist', on: 'wishlist', test: ({ total }) => total >= WISHLIST_GOAL },
  { id: 'collector', on: 'shelf', test: ({ shelves }) => shelves >= 4 },
  { id: 'upgrade', on: 'upgrade', test: () => true },
  { id: 'auction', on: 'auction-win', test: () => true },
];

const passing = (event, data) => RULES.filter((r) => r.on === event && r.test(data)).map((r) => r.id);

export function earned(user, event, data) {
  return passing(event, data).filter((id) => !user.achievements.includes(id));
}

/* После commit: журнал и событие для SSE */
export function announce(user, ids) {
  if (!ids.length) return;
  const items = ids.map((id) => ACHIEVEMENTS.find((a) => a.id === id));
  log('http', `ачивки ${user.login}: ${items.map((a) => `${a.emoji} ${a.name}`).join(', ')}`);
  bus.emit('achievement', { userId: user.id, items, at: Date.now() });
}

export function createAchievements({ db }) {
  async function award(ctx, userId, event, data) {
    if (!passing(event, data).length) return [];   // правило не сработало — в базу не ходим
    const { user, ids } = await retryTx(() => db.tx(ctx, async (t) => {
      const u = await t.get('users', userId);
      const ids = u ? earned(u, event, data) : [];
      if (ids.length) await t.update('users', userId, { achievements: [...u.achievements, ...ids] });
      return { user: u, ids };
    }));
    if (user) announce(user, ids);
    return ids;
  }

  async function noteView(ctx, userId, offerId) {
    const { user, ids } = await retryTx(() => db.tx(ctx, async (t) => {
      const u = await t.get('users', userId);
      const viewed = u?.viewed ?? [];
      if (!u || u.achievements.includes('watcher') || viewed.includes(offerId)) return { user: u, ids: [] };
      const next = [...viewed, offerId];
      const ids = earned(u, 'view', { viewed: next.length });
      await t.update('users', userId, { viewed: next, achievements: [...u.achievements, ...ids] });
      return { user: u, ids };
    }));
    if (user) announce(user, ids);
    return ids;
  }

  return { award, noteView };
}
