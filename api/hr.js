/* HR-панель «Офферомании» — только для роли hr, остальным 403 FORBIDDEN.
   - POST /hr/offers — выставить оффер. Ошибки — 422 со всеми полями сразу в fields: форма подсвечивает каждое поле (Т18).
     Правила: цена в диапазоне редкости, нижняя граница вилки не выше верхней («Ожидания не могут быть выше вилки»),
     у мифического вилка честная (нижняя ≥ 80% верхней), без красных флагов офферов не бывает.
   - PATCH /hr/offers/:id с If-Match: "<v>" — правка части полей; проверяется оффер целиком после правки.
     Версия устарела — 409 VERSION_CONFLICT с текущим оффером, без If-Match — 428.
   - GET /hr/offers — выставленные этим HR, GET /hr/offers/:id — оффер целиком, с нижней границей вилки.
   - POST /hr/black-friday { offerIds, percent } — массовая уценка. Каждый оффер — своя транзакция, поэтому успех частичный:
     200 и { ok: [{ id, was, price }], failed: [{ id, code, message }] }. Мифические не уцениваются, ниже пола редкости — нельзя.
   Смена цены уходит в шину событием price (в SSE — через /stream): у покупателя со старым expectedPrice будет 409 PRICE_CHANGED. */
import crypto from 'node:crypto';
import express from 'express';
import { HttpError } from './errors.js';
import { DbError } from './db.js';
import { ifMatch } from './purchases.js';
import { FLAGS, GRADES, RARITIES } from './seed.js';
import { bus } from './bus.js';
import { log } from './log.js';

export const SALARY = { min: 30_000, max: 1_500_000 };
export const HONEST = 0.8;   // мифический: нижняя граница вилки не ниже 80% верхней
export const BLACK_FRIDAY = { maxOffers: 50, percent: [5, 90] };
const EDITABLE = ['title', 'grade', 'companyId', 'rarity', 'price', 'salaryFrom', 'salaryTo', 'flags', 'stack', 'perks', 'city', 'pitch'];
const DEFAULTS = { stack: [], perks: [], city: 'Удалённо', pitch: '' };
const FLAG_IDS = FLAGS.map((f) => f.id);
const OVER = 'Ожидания не могут быть выше вилки';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const notFound = () => new HttpError(404, 'NOT_FOUND', 'Вакансия закрыта, но объявление провисит ещё год');
const pick = (body) => Object.fromEntries(EDITABLE.filter((k) => body?.[k] !== undefined).map((k) => [k, body[k]]));
const strings = (v, max) => Array.isArray(v) && v.length <= max && v.every((s) => typeof s === 'string' && s.trim() && s.length <= 40);
const money = (n) => n.toLocaleString('ru-RU');

/* Оффер целиком → { поле: что не так }. company — найдена ли компания (проверяется в базе до вызова) */
function problems(o, company) {
  const fields = {};
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (title.length < 3 || title.length > 80) fields.title = 'Название от 3 до 80 символов. «Ниндзя» не подойдёт';
  if (!GRADES.includes(o.grade)) fields.grade = `Грейды: ${GRADES.join(', ')}`;
  if (typeof o.companyId !== 'string' || !company) fields.companyId = 'Такой компании нет даже в стадии пивота';
  const rarity = RARITIES.find((r) => r.id === o.rarity);
  if (!rarity) fields.rarity = `Редкости: ${RARITIES.map((r) => r.id).join(', ')}`;
  if (!Number.isInteger(o.price)) fields.price = 'Цена — целое число 🍪';
  else if (rarity && (o.price < rarity.price[0] || o.price > rarity.price[1])) fields.price = `Цена редкости «${rarity.name}» — от ${rarity.price[0]} до ${rarity.price[1]} 🍪`;
  if (!Number.isInteger(o.salaryTo) || o.salaryTo < SALARY.min || o.salaryTo > SALARY.max) fields.salaryTo = `Верх вилки — от ${money(SALARY.min)} до ${money(SALARY.max)} ₽`;
  if (!Number.isInteger(o.salaryFrom) || o.salaryFrom < 0) fields.salaryFrom = 'Низ вилки — целое число рублей';
  else if (!fields.salaryTo && o.salaryFrom > o.salaryTo) fields.salaryFrom = OVER;
  else if (!fields.salaryTo && o.rarity === 'mythic' && o.salaryFrom < o.salaryTo * HONEST) fields.salaryFrom = `Мифический — значит честный: низ вилки не меньше ${money(Math.ceil(o.salaryTo * HONEST))} ₽`;
  if (!Array.isArray(o.flags) || !o.flags.length) fields.flags = 'Без красных флагов офферов не бывает. Таких не бывает';
  else if (new Set(o.flags).size !== o.flags.length) fields.flags = 'Один флаг дважды не повесить';
  else if (o.flags.some((f) => !FLAG_IDS.includes(f))) fields.flags = `Нет такого флага: ${o.flags.filter((f) => !FLAG_IDS.includes(f)).join(', ')}`;
  if (!strings(o.stack, 8)) fields.stack = 'Стек — до 8 строк';
  if (!strings(o.perks, 6)) fields.perks = 'Плюшки — до 6 строк. Фрукты по средам считаются';
  if (typeof o.city !== 'string' || o.city.trim().length < 2 || o.city.length > 40) fields.city = 'Город от 2 до 40 символов. «Где-то в облаке» — тоже город';
  if (typeof o.pitch !== 'string' || o.pitch.length > 300) fields.pitch = 'Описание — до 300 символов. Остальное расскажут на пятом этапе';
  return fields;
}

async function validate(t, o) {
  const company = typeof o.companyId === 'string' && o.companyId ? await t.get('companies', o.companyId) : null;
  const fields = problems(o, company);
  if (Object.keys(fields).length) {
    throw new HttpError(422, 'VALIDATION', fields.salaryFrom === OVER ? OVER : 'Оффер заполнен с ошибками', { fields });
  }
  return { ...o, title: o.title.trim(), city: o.city.trim() };
}

function priceMoved(offer, was) {
  if (offer.price !== was) bus.emit('price', { offerId: offer.id, price: offer.price, was, by: 'hr', at: Date.now() });
}

function parseBlackFriday(body) {
  const { offerIds, percent } = body ?? {};
  const fields = {};
  const [lo, hi] = BLACK_FRIDAY.percent;
  if (!Array.isArray(offerIds) || !offerIds.length || offerIds.some((id) => typeof id !== 'string' || !id)) fields.offerIds = 'Список id офферов';
  else if (offerIds.length > BLACK_FRIDAY.maxOffers) fields.offerIds = `За раз — до ${BLACK_FRIDAY.maxOffers} офферов`;
  else if (new Set(offerIds).size !== offerIds.length) fields.offerIds = 'Один оффер дважды не уценить';
  if (!Number.isInteger(percent) || percent < lo || percent > hi) fields.percent = `Скидка от ${lo} до ${hi}%. «Чёрная пятница» — не благотворительность`;
  if (Object.keys(fields).length) throw new HttpError(422, 'VALIDATION', 'Распродажа заполнена с ошибками', { fields });
  return { offerIds, percent };
}

export function createHr({ db, auth }) {
  const hrOnly = auth.requireRole('hr');
  const router = express.Router();

  router.get('/hr/offers', hrOnly, async (req, res) => {
    const rows = (await db.where(req.db, 'offers', (o) => o.createdBy === req.auth.sub)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ items: rows, total: rows.length, serverTime: Date.now() });
  });

  router.get('/hr/offers/:id', hrOnly, async (req, res) => {
    const offer = await db.get(req.db, 'offers', req.params.id);
    if (!offer) throw notFound();
    res.setHeader('ETag', `"${offer.v}"`);
    res.json({ offer, serverTime: Date.now() });
  });

  router.post('/hr/offers', hrOnly, async (req, res) => {
    const offer = await db.tx(req.db, async (t) => {
      const draft = await validate(t, { ...DEFAULTS, ...pick(req.body) });
      return t.insert('offers', { id: `o-${crypto.randomBytes(5).toString('hex')}`, ...draft, createdAt: iso(), createdBy: req.auth.sub });
    });
    log('http', `HR выставил ${offer.id} «${offer.title}» · ${offer.price} 🍪`);
    res.setHeader('ETag', `"${offer.v}"`);
    res.status(201).json({ offer, serverTime: Date.now() });
  });

  /* Без retryTx: конфликт версии — ответ HR, чью правку перебили */
  router.patch('/hr/offers/:id', hrOnly, async (req, res) => {
    const expected = ifMatch(req, 'оффера', 'не правим');
    const patch = pick(req.body);
    if (!Object.keys(patch).length) throw new HttpError(422, 'VALIDATION', 'Править нечего', { fields: { _: `Поля: ${EDITABLE.join(', ')}` } });
    const { offer, was } = await db.tx(req.db, async (t) => {
      const cur = await t.get('offers', req.params.id);
      if (!cur) throw notFound();
      const next = await validate(t, { ...DEFAULTS, ...cur, ...patch });
      return { offer: await t.update('offers', cur.id, { ...next, updatedAt: iso() }, expected), was: cur.price };
    });
    priceMoved(offer, was);
    log('http', `HR поправил ${offer.id}: ${Object.keys(patch).join(', ')} · v${offer.v}`);
    res.setHeader('ETag', `"${offer.v}"`);
    res.json({ offer, serverTime: Date.now() });
  });

  /* Офферы по одному: упавший не откатывает остальные. Ошибка базы (очередь, конфликт) — тоже строка в failed */
  router.post('/hr/black-friday', hrOnly, async (req, res) => {
    const { offerIds, percent } = parseBlackFriday(req.body);
    const ok = [];
    const failed = [];
    for (const id of offerIds) {
      try {
        const { offer, was } = await db.tx(req.db, async (t) => {
          const cur = await t.get('offers', id);
          if (!cur) throw notFound();
          if (cur.rarity === 'mythic') throw new HttpError(409, 'MYTHIC_PROTECTED', 'Мифические не уцениваются: честная вилка дороже скидки');
          const rarity = RARITIES.find((r) => r.id === cur.rarity);
          const price = Math.round(cur.price * (1 - percent / 100));
          if (price < rarity.price[0]) throw new HttpError(409, 'PRICE_FLOOR', `Дешевле ${rarity.price[0]} 🍪 ${rarity.name} оффер не продаём, а вышло бы ${price}`);
          return { offer: await t.update('offers', id, { price, discountedAt: iso() }), was: cur.price };
        });
        priceMoved(offer, was);
        ok.push({ id, was, price: offer.price });
      } catch (e) {
        if (!(e instanceof HttpError || e instanceof DbError)) throw e;
        failed.push({ id, code: e.code, message: e.message });
      }
    }
    log('http', `«Чёрная пятница» −${percent}%: уценено ${ok.length}, отказ ${failed.length}`);
    res.json({ ok, failed, percent, serverTime: Date.now() });
  });

  return router;
}
