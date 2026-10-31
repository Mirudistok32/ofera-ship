/* Прокачка «Офферомании» — долгая задача: 202 сразу, результат потом.
   - POST /upgrade { cardId, kind, boosts? } → 202, Location: /jobs/:id. Задача идёт около 4 с (QUEST_JOB_MS) через этапы
     «HR читает резюме → … → решение». Клиент опрашивает GET /jobs/:id, пока status не done или failed; пока задача идёт,
     в ответе Retry-After — через сколько секунд спрашивать снова.
   - kind: 'level' — уровень карточки Junior → Middle → Senior → Lead → Архитектор презентаций за 🍪 (списываются сразу);
     'merge' — три дубля одного оффера сливаются в случайный оффер редкостью выше.
   - Шанс 15% «HR передумал» (QUEST_UPGRADE_FAIL): уровень не растёт, 🍪 не возвращаются, дубли остаются целы.
     «Улыбка на созвоне» (эффект) добавляет 5% к шансу, «Рекомендация» (в boosts) убирает срыв совсем.
   - Idempotency-Key — как у покупки: двойной клик с одним ключом = одна задача. Без ключа — две задачи и два списания.
   - Задачи лежат в таблице jobs: после перезапуска сервера незаконченные продолжаются с того же этапа.
   - Успешная прокачка даёт ачивку «Рост внутри компании». */
import crypto from 'node:crypto';
import express from 'express';
import { UPGRADE } from './config.js';
import { HttpError } from './errors.js';
import { publicUser } from './auth.js';
import { retryTx } from './catalog.js';
import { earned, announce } from './achievements.js';
import { idempotency, stored, replay, remember } from './idempotency.js';
import { albumCard, spendBoosts } from './purchases.js';
import { LEVELS, RARITIES } from './seed.js';
import { log } from './log.js';

/* Цена следующего уровня: LEVEL_COST[текущий уровень] */
export const LEVEL_COST = [40, 80, 160, 320];
export const MERGE_COUNT = 3;
export const UPGRADE_BOOSTS = { referral: 'гарантия', smile: '+5% к шансу' };
const SMILE_BONUS = 0.05;
const STAGES = ['HR читает резюме', 'Собеседование с тимлидом', 'Согласование с финдиректором', 'Служба безопасности звонит маме'];
const FINISHED = ['done', 'failed'];
const RARITY_IDS = RARITIES.map((r) => r.id);

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const newId = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
const notFound = (what = 'Карточки') => new HttpError(404, 'NOT_FOUND', `${what} нет — или она не твоя`);
const invalid = (fields) => new HttpError(422, 'VALIDATION', 'Заявка на прокачку заполнена с ошибками', { fields });
const onLot = (c) => new HttpError(409, 'CARD_ON_LOT', 'Карточка на аукционе: прокачать её можно после торгов', { extra: { lotId: c.lotId } });
const tickMs = () => UPGRADE.jobMs / (STAGES.length + 1);
const publicJob = ({ userId, v, ...job }) => job;

function parseUpgrade(body) {
  const { cardId, kind, boosts = [] } = body ?? {};
  const fields = {};
  if (typeof cardId !== 'string' || !cardId) fields.cardId = 'Какую карточку качаем?';
  if (kind !== 'level' && kind !== 'merge') fields.kind = 'level — уровень за 🍪, merge — слить три дубля';
  if (!Array.isArray(boosts) || boosts.some((b) => typeof b !== 'string')) fields.boosts = 'Список id усилений';
  else if (new Set(boosts).size !== boosts.length) fields.boosts = 'Одно усиление дважды не включить';
  else if (boosts.some((b) => b !== 'referral')) fields.boosts = 'В окне прокачки работает только «Рекомендация»';
  if (Object.keys(fields).length) throw invalid(fields);
  return { cardId, kind, boosts };
}

/* Шанс успеха: 1 − срыв; «Улыбка» в силе — +5%, «Рекомендация» — 100% */
function chanceOf(user, boosts, at) {
  if (boosts.includes('referral')) return 1;
  const smile = Date.parse(user.effects?.smile ?? '') > at ? SMILE_BONUS : 0;
  return Math.round(Math.min(1, Math.max(0, 1 - UPGRADE.failRate + smile)) * 100) / 100;
}

export function createUpgrade({ db, auth }) {
  const { requireAuth } = auth;
  const router = express.Router();
  const timers = new Map();

  /* ---------- исполнитель задач ---------- */

  function schedule(id, ms = tickMs()) {
    clearTimeout(timers.get(id));
    const timer = setTimeout(() => tick(id).catch((e) => {
      log('err', `задача ${id}: ${e.message} — повтор через 1 с`);
      schedule(id, 1000);
    }), ms);
    timer.unref();
    timers.set(id, timer);
  }

  /* Шаг задачи: следующий этап или решение. Прогресс пишется в базу — его видит опрос /jobs/:id */
  async function tick(id) {
    timers.delete(id);
    const job = await db.get(null, 'jobs', id);
    if (!job || FINISHED.includes(job.status)) return;
    const stage = job.status === 'queued' ? 0 : STAGES.indexOf(job.stage) + 1;
    if (stage < STAGES.length) {
      await db.tx(null, (t) => t.update('jobs', id, { status: 'running', stage: STAGES[stage], progress: Math.round(stage * 100 / STAGES.length), updatedAt: iso() }));
      return schedule(id);
    }
    await finish(job);
  }

  async function finish(job) {
    const lucky = Math.random() < job.chance;
    /* Оффер для слияния выбирается до транзакции: перебор по редкости — запрос «по индексу» */
    let target = null;
    if (lucky && job.kind === 'merge') {
      const pool = await db.where(null, 'offers', (o) => o.rarity === job.targetRarity);
      target = pool[crypto.randomInt(pool.length)];
    }
    const { user, ids, done } = await retryTx(() => db.tx(null, async (t) => {
      const u = await t.get('users', job.userId);
      const cards = await Promise.all(job.cardIds.map((id) => t.get('album', id)));
      const at = Date.now();
      const close = (patch) => t.update('jobs', job.id, { progress: 100, updatedAt: iso(at), finishedAt: iso(at), ...patch });

      if (cards.some((c) => !c || c.userId !== job.userId || c.lotId) || (job.kind === 'level' && cards[0].level !== job.fromLevel)) {
        await t.update('users', u.id, { cookies: u.cookies + job.cost });
        const done = await close({ status: 'failed', stage: 'Карточка уже не та', error: { code: 'CARDS_CHANGED', message: 'Пока шло согласование, карточку прокачали, слили или выставили на аукцион. 🍪 вернули' } });
        return { user: u, ids: [], done };
      }
      if (!lucky) {
        const done = await close({ status: 'failed', stage: 'HR передумал', error: { code: 'HR_CHANGED_MIND', message: 'HR передумал. Печеньки съедены на собеседовании' } });
        return { user: u, ids: [], done };
      }

      let result;
      if (job.kind === 'level') {
        const card = await t.update('album', cards[0].id, { level: job.fromLevel + 1, upgradedAt: iso(at) });
        result = { card: albumCard(card, await t.get('offers', card.offerId), at) };
      } else {
        for (const c of cards) await t.remove('album', c.id);
        const card = await t.insert('album', {
          id: newId('a'), userId: job.userId, offerId: target.id, purchaseId: null, mergedFrom: job.cardIds,
          shelf: null, level: 0, hrEverySec: (5 + crypto.randomInt(56)) * 60, acquiredAt: iso(at),
        });
        result = { card: albumCard(card, target, at), merged: job.cardIds };
      }
      const ids = earned(u, 'upgrade', {});
      if (ids.length) await t.update('users', u.id, { achievements: [...u.achievements, ...ids] });
      const done = await close({ status: 'done', stage: job.kind === 'level' ? `Теперь ${LEVELS[job.fromLevel + 1]}` : 'Дубли слились', result });
      return { user: u, ids, done };
    }));
    log('http', `прокачка ${job.id} · ${user.login} · ${done.status === 'done' ? done.stage : done.error.code}`);
    announce(user, ids);
  }

  /* Незаконченные задачи прошлого запуска — дальше с того же этапа */
  const unfinished = [...db.table('jobs').values()].filter((j) => !FINISHED.includes(j.status));
  for (const j of unfinished) schedule(j.id);
  if (unfinished.length) log('http', `продолжаю задачи прокачки: ${unfinished.length}`);

  /* ---------- роуты ---------- */

  router.get('/upgrade', (req, res) => {
    res.json({
      levels: LEVELS, costs: LEVEL_COST, mergeCount: MERGE_COUNT, rarities: RARITY_IDS,
      failRate: UPGRADE.failRate, smileBonus: SMILE_BONUS, boosts: UPGRADE_BOOSTS, jobMs: UPGRADE.jobMs,
    });
  });

  router.post('/upgrade', requireAuth, async (req, res) => {
    const idem = idempotency(req);
    const { cardId, kind, boosts } = parseUpgrade(req.body);
    const { sub } = req.auth;
    const located = (body) => res.setHeader('Location', `/jobs/${body.job.id}`);
    if (idem) {
      const done = stored(await db.get(req.db, 'idempotency', idem.id), idem);
      if (done) {
        located(done.body);
        return replay(res, done);
      }
    }

    /* Карточка и её дубли — до транзакции; в транзакции они читаются ещё раз, и параллельная запись даст конфликт версий */
    const card = await db.get(req.db, 'album', cardId);
    if (!card || card.userId !== sub) throw notFound();
    if (card.lotId) throw onLot(card);
    let cardIds = [cardId];
    let targetRarity = null;
    if (kind === 'level' && card.level >= LEVELS.length - 1) {
      throw new HttpError(422, 'MAX_LEVEL', `Выше «${LEVELS.at(-1)}» только пенсия`, { fields: { cardId: 'Уровень уже максимальный' } });
    }
    if (kind === 'merge') {
      const offer = await db.get(req.db, 'offers', card.offerId);
      targetRarity = RARITY_IDS[RARITY_IDS.indexOf(offer.rarity) + 1] ?? null;
      if (!targetRarity) throw new HttpError(422, 'MAX_RARITY', 'Мифический — потолок. Выше только честная вилка', { fields: { cardId: 'Редкость уже максимальная' } });
      const twins = (await db.where(req.db, 'album', (a) => a.userId === sub && a.offerId === card.offerId && a.id !== cardId && !a.lotId))
        .sort((a, b) => a.level - b.level || a.acquiredAt.localeCompare(b.acquiredAt));
      if (twins.length < MERGE_COUNT - 1) {
        throw new HttpError(422, 'NOT_ENOUGH_DUPLICATES', `Для слияния нужно ${MERGE_COUNT} одинаковых оффера, есть ${twins.length + 1}`, { fields: { cardId: 'Мало дублей' } });
      }
      cardIds = [cardId, ...twins.slice(0, MERGE_COUNT - 1).map((a) => a.id)];
    }
    const defs = boosts.length ? await db.getMany(req.db, 'boosts', boosts) : [];

    const result = await retryTx(() => db.tx(req.db, async (t) => {
      if (idem) {
        const done = stored(await t.get('idempotency', idem.id), idem);
        if (done) return { done };   // параллельный запрос с этим ключом успел первым
      }
      for (const id of cardIds) {
        const c = await t.get('album', id);
        if (!c || c.userId !== sub) throw notFound();
        if (c.lotId) throw onLot(c);
      }
      const u = await t.get('users', sub);
      if (!u) throw new HttpError(401, 'TOKEN_INVALID', 'Такого сотрудника нет');
      const at = Date.now();
      const cost = kind === 'level' ? LEVEL_COST[card.level] : 0;
      if (u.cookies < cost) throw new HttpError(409, 'NOT_ENOUGH_COOKIES', 'Печенек не хватает. Попроси аванс', { extra: { cookies: u.cookies, price: cost } });
      const spent = spendBoosts(req.auth, u, defs, at);

      const job = await t.insert('jobs', {
        id: newId('j'), userId: sub, kind, cardIds, fromLevel: card.level, targetRarity, cost, boosts,
        chance: chanceOf(u, boosts, at), status: 'queued', stage: 'В очереди у HR', progress: 0,
        result: null, error: null, createdAt: iso(at), updatedAt: iso(at), finishedAt: null,
      });
      const user = await t.update('users', sub, { cookies: u.cookies - cost, ...spent });
      const body = { job: publicJob(job), user: publicUser(user), serverTime: at };
      if (idem) await remember(t, idem, sub, 202, body);
      return { body, user };
    }));

    if (result.done) {
      located(result.done.body);
      return replay(res, result.done);
    }
    const { job } = result.body;
    log('http', `прокачка ${job.id} · ${kind} ${cardId} · ${result.user.login} · шанс ${job.chance * 100}%${idem ? ` · ключ ${idem.key}` : ''}`);
    schedule(job.id);
    located(result.body);
    res.status(202).json(result.body);
  });

  /* ?active=1 — только незаконченные: после F5 страница Прокачки находит свою задачу */
  router.get('/jobs', requireAuth, async (req, res) => {
    const active = req.query.active === '1';
    const rows = (await db.where(req.db, 'jobs', (j) => j.userId === req.auth.sub && (!active || !FINISHED.includes(j.status))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
    res.json({ items: rows.map(publicJob), serverTime: Date.now() });
  });

  router.get('/jobs/:id', requireAuth, async (req, res) => {
    const job = await db.get(req.db, 'jobs', req.params.id);
    if (!job || job.userId !== req.auth.sub) throw notFound('Задачи');
    if (!FINISHED.includes(job.status)) res.setHeader('Retry-After', String(Math.max(1, Math.round(tickMs() / 1000))));
    res.json({ job: publicJob(job), serverTime: Date.now() });
  });

  return router;
}
