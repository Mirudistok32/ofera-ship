/* Проверка тикетов: POST /__check/:n/start — включить набор сбоев тикета и запомнить, с какого запроса смотреть;
   GET /__check/:n — вердикт по пунктам из журнала запросов этого origin. GET /__check — список проверок.
   Origin — заголовок Origin (пульт в каркасе) или ?origin= (npm run quest:check). Проверяются Т2, Т3, Т4, Т7, Т8, Т10, Т11, Т13, Т19, Т20.
   Сервер видит только запросы: что в них, когда начались и кончились, отменены ли. Пункты проверки — про это, а не про вёрстку. */
import express from 'express';
import { HttpError } from './errors.js';
import { log } from './log.js';
import { CHECK } from './config.js';
import { originKey } from './journal.js';

const item = (ok, text) => ({ ok: Boolean(ok), text });
const end = (e) => e.t + (e.ms ?? Infinity);
const fine = (e) => e.status >= 200 && e.status < 400;
const failed = (e) => e.status === 0 || e.status >= 500 || e.status === 429;
const show = (e) => `${e.method} ${e.url}`;
const params = (e) => new URL(e.url, 'http://x').searchParams;
const list = (xs, n = 3) => xs.slice(0, n).join('; ') + (xs.length > n ? ` и ещё ${xs.length - n}` : '');

/* Пары «a ещё шёл, когда начался b» */
function overlaps(xs, same = () => true) {
  const pairs = [];
  xs.forEach((a, i) => {
    for (const b of xs.slice(i + 1)) if (b.t < end(a) && same(a, b)) pairs.push([a, b]);
  });
  return pairs;
}

/* Запросы одного вида по очереди (переключение фильтра, набор текста): cancelled — сколько отменено,
   kept — те, что ещё шли, когда начался следующий, и не отменены. Хороший клиент отменяет до старта нового — наложений нет вовсе */
function superseded(xs) {
  return { cancelled: xs.filter((e) => e.aborted).length, kept: [...new Set(overlaps(xs).filter(([a]) => !a.aborted).map(([a]) => a))] };
}

/* Цепочки попыток одного адреса: следующая попытка входит в цепочку, если прошлая упала */
function chains(xs) {
  const byKey = Map.groupBy(xs, (e) => `${e.method} ${e.url}`);
  const out = [];
  for (const tries of byKey.values()) {
    let chain = null;
    for (const e of tries) {
      if (chain && failed(chain.at(-1))) chain.push(e);
      else out.push((chain = [e]));
    }
  }
  return out;
}

const CHECKS = [
  {
    n: 2, title: 'Барахолка: useQuery, статусы, отмена в cleanup',
    preset: 'calm', set: { delayMs: 1200, jitterMs: 400 },
    steps: 'Открой Барахолку и, не дожидаясь ответа, переключи 3–4 фильтра или страницы подряд; потом уйди на другую страницу посреди загрузки.',
    verdict({ entries }) {
      const lists = entries.filter((e) => e.method === 'GET' && e.path === '/offers');
      const { cancelled, kept } = superseded(lists);
      return [
        item(lists.length >= 2, `Запросов GET /offers: ${lists.length} (нужно от 2)`),
        item(cancelled && !kept.length, kept.length
          ? `Прошлый запрос не отменён, ответ пришёл зря: ${list(kept.map(show))}`
          : cancelled ? `Отменено запросов: ${cancelled} — ответ, который уже не нужен, не ждём (abort в cleanup)`
            : 'Ни один запрос не отменён: переключай фильтры быстрее, загрузка идёт больше секунды'),
      ];
    },
  },
  {
    n: 3, title: '«HR ушёл на обед»: повтор только GET, backoff, Retry-After',
    preset: 'calm', set: { flaky: 3 },
    steps: 'Каждый адрес падает первые разы: GET — обрыв сети, 500, 429 с Retry-After: 1; POST и остальные — один 500. Открой Барахолку и оффер, в Лавке нажми «Кофе» один раз.',
    verdict({ entries }) {
      const all = chains(entries.filter((e) => e.method === 'GET'));
      const complete = all.filter((c) => c.length >= 4 && c.slice(0, 3).every(failed) && fine(c.at(-1)));
      const gaps = complete.map((c) => [c[1].t - end(c[0]), c[2].t - end(c[1])]);
      const flat = gaps.filter(([g1, g2]) => !(g1 >= 100 && g2 > g1));
      const hurried = [];
      for (const c of all) {
        c.forEach((e, i) => {
          const prev = c[i - 1];
          const gap = prev && e.t - end(prev);
          if (prev?.status === 429 && prev.retryAfter && gap < Number(prev.retryAfter) * 1000 - 50) hurried.push(`${show(e)} через ${gap} мс`);
        });
      }
      const writes = entries.filter((e) => e.method !== 'GET' && !e.sse && (e.status === 0 || e.status >= 500));
      const repeated = writes.filter((w) => entries.some((e) => e.seq > w.seq && e.method === w.method && e.url === w.url && e.t - end(w) < 1500));
      return [
        item(complete.length, complete.length
          ? `GET дошёл до ответа после обрыва, 500 и 429: ${complete.length} раз`
          : 'Нет GET, который после обрыва, 500 и 429 повторился и получил ответ: нужно минимум 3 повтора'),
        item(complete.length && !flat.length, flat.length
          ? `Пауза между повторами не растёт: ${list(flat.map(([a, b]) => `${a} → ${b} мс`))} (первая — от 100 мс, вторая — больше)`
          : `Паузы растут (backoff): ${list(gaps.map(([a, b]) => `${a} → ${b} мс`))}`),
        item(complete.length && !hurried.length, hurried.length
          ? `Повтор раньше Retry-After: ${list(hurried)}`
          : 'После 429 следующая попытка — не раньше Retry-After'),
        item(writes.length && !repeated.length, !writes.length
          ? 'Ни один POST/PUT/DELETE не упал: нажми «Кофе» в Лавке, первая попытка получит 500'
          : repeated.length ? `Упавший запрос с телом повторён сам: ${list(repeated.map(show))} — повтор только у GET` : 'Упавший POST не повторялся сам: ошибка показана человеку'),
      ];
    },
  },
  {
    n: 4, title: 'Поиск: debounce, отмена прошлого, фильтры, без 429',
    preset: 'calm', set: { delayMs: 800 },
    steps: 'Набери в поиске «ведущий» обычным темпом, остановись на полсекунды, допиши « разработчик»; сотри и набери «семья»; выбери редкость.',
    verdict({ entries }) {
      const search = entries.filter((e) => e.method === 'GET' && e.path === '/offers' && params(e).get('q') && !params(e).get('cursor'));
      const q = (e) => params(e).get('q');
      const typed = search.slice(1).map((b, i) => [search[i], b]).filter(([a, b]) => q(a) !== q(b) && b.t - a.t < 250);
      const { cancelled, kept } = superseded(search);
      const limited = search.filter((e) => e.status === 429);
      const filtered = search.some((e) => [...params(e).keys()].some((k) => !['q', 'cursor', 'sort', 'limit'].includes(k)));
      return [
        item(new Set(search.map(q)).size >= 2, `Запросов поиска: ${search.length}, разных q: ${new Set(search.map(q)).size} (нужно от 2)`),
        item(search.length >= 2 && !typed.length, typed.length
          ? `Запрос на каждую букву: ${list(typed.map(([a, b]) => `«${q(a)}» → «${q(b)}» через ${b.t - a.t} мс`))} — нужен debounce`
          : 'Запросы уходят после паузы в наборе, не на каждую букву'),
        item(cancelled && !kept.length, kept.length
          ? `Прошлый поиск не отменён: ${list(kept.map((a) => `q=${q(a)}`))}`
          : cancelled ? `Отменено поисков: ${cancelled} — прошлый не ждём, когда ушёл новый`
            : 'Ни один поиск не отменён: допиши слово, пока ещё идёт прошлый поиск (он идёт больше секунды)'),
        item(!limited.length, limited.length ? `429 на поиске: ${limited.length} — лимит 10 в секунду` : 'Ни одного 429 на поиске'),
        item(filtered, filtered ? 'Фильтр ушёл вместе с текстом' : 'Нет запроса с q и фильтром: выбери редкость, грейд или флаг при введённом тексте'),
      ];
    },
  },
  {
    n: 7, title: 'Кэш: ключ, дедупликация, TTL, stale-while-revalidate',
    preset: 'calm', set: { delayMs: 500 },
    steps: 'Открой Барахолку, открой оффер, вернись; так три раза за 10 секунд. Подожди TTL (15 секунд) и вернись ещё раз.',
    verdict({ entries }) {
      const cat = entries.filter((e) => e.method === 'GET' && !e.aborted && fine(e) && /^\/(offers|companies|flags)(\/|$)/.test(e.path));
      const twins = overlaps(cat, (a, b) => a.url === b.url).map(([a]) => a.url);
      const byUrl = Map.groupBy(cat, (e) => e.url);
      const early = [];
      for (const [url, xs] of byUrl) xs.slice(1).forEach((b, i) => b.t - xs[i].t < CHECK.cacheGapMs && early.push(`${url} через ${b.t - xs[i].t} мс`));
      const again = [...byUrl.values()].filter((xs) => xs.length >= 2);
      return [
        item(cat.length >= 2, `Запросов каталога: ${cat.length} (нужно от 2)`),
        item(cat.length >= 2 && !twins.length, twins.length ? `Одинаковые запросы шли одновременно: ${list(twins)} — нужна дедупликация` : 'Одинаковые GET не идут одновременно'),
        item(cat.length >= 2 && !early.length, early.length
          ? `Свежее не взято из кэша: ${list(early)} (TTL — от ${CHECK.cacheGapMs / 1000} с)`
          : `Один адрес — не чаще раза в ${CHECK.cacheGapMs / 1000} с: свежее берётся из кэша`),
        item(again.length, again.length ? `Устаревшее перепроверено: ${again.length} адрес(а) запрошены снова после TTL` : 'Ни один адрес не запрошен повторно: вернись на страницу после TTL'),
      ];
    },
  },
  {
    n: 8, title: 'N+1: компании одним батчем',
    preset: 'calm', set: {},
    steps: 'Открой Барахолку и пролистай две страницы.',
    verdict({ entries }) {
      const gets = entries.filter((e) => e.method === 'GET' && !e.aborted);
      const singles = gets.filter((e) => /^\/companies\/[^/]+$/.test(e.path));
      const batches = gets.filter((e) => e.path === '/companies' && params(e).get('ids'));
      const ids = (e) => params(e).get('ids').split(',').filter(Boolean);
      const lists = gets.filter((e) => e.path === '/offers');
      const burst = singles.filter((e, i) => singles[i + 2] && singles[i + 2].t - e.t <= 300);
      const dup = batches.filter((e) => new Set(ids(e)).size !== ids(e).length);
      return [
        item(batches.some((e) => ids(e).length >= 2), batches.length ? `Батчей /companies?ids=: ${batches.length}, в самом большом — ${Math.max(...batches.map((e) => ids(e).length))} id` : 'Нет запроса /companies?ids= с несколькими id'),
        item(!burst.length, burst.length ? `Пачка одиночных запросов: ${singles.length} × GET /companies/:id — каждая карточка грузит свою компанию` : 'Нет пачек одиночных GET /companies/:id'),
        item(!dup.length, dup.length ? `В батче повторяются id: ${list(dup.map((e) => e.url))}` : 'В батчах id не повторяются'),
        item(batches.length && batches.length <= lists.length, `Батчей ${batches.length} на ${lists.length} загрузок списка — не больше одного на страницу`),
      ];
    },
  },
  {
    n: 10, title: '«Охрана изъяла пропуск»: один refresh на все 401',
    preset: 'calm', set: { accessTtl: 8 }, expire: true,
    steps: 'Пропуск уже просрочен, новый живёт 8 секунд. Открой Альбом или Лавку (несколько запросов сразу), подожди 10 секунд, открой другую закрытую страницу.',
    verdict({ entries }) {
      const own = entries.filter((e) => !e.sse);
      const expired = own.filter((e) => e.status === 401 && e.code === 'TOKEN_EXPIRED');
      const tokens = new Set(expired.map((e) => e.auth?.fp));
      const refreshes = own.filter((e) => e.method === 'POST' && e.path === '/auth/refresh' && e.status !== null);
      const reactive = refreshes.filter((r) => expired.some((e) => r.t >= e.t && r.t - end(e) < 3000));
      const parallel = overlaps(refreshes);
      const burned = own.filter((e) => ['REFRESH_REUSED', 'REFRESH_REVOKED'].includes(e.code));
      const lost = expired.filter((e) => !own.some((f) => f.seq > e.seq && f.method === e.method && f.url === e.url && f.auth?.fp && f.auth.fp !== e.auth?.fp && fine(f)));
      return [
        item(expired.length, `Ответов 401 expired: ${expired.length}, просроченных пропусков: ${tokens.size}`),
        item(reactive.length && reactive.length <= tokens.size, `Refresh после 401: ${reactive.length} на ${tokens.size} просроченных пропуска — нужен один на пропуск`),
        item(!parallel.length, parallel.length ? `Refresh шли одновременно: ${parallel.length} пар — нужен общий промис` : 'Refresh не идут параллельно'),
        item(!burned.length, burned.length ? `Цепочка отозвана: ${list(burned.map((e) => e.code))} — refresh-токен потрачен дважды` : 'Без REFRESH_REUSED: цепочка цела'),
        item(expired.length && !lost.length, lost.length ? `Не повторены с новым пропуском: ${list(lost.map(show))}` : 'Каждый запрос с 401 повторён с новым пропуском и прошёл'),
      ];
    },
  },
  {
    n: 11, title: 'Роли и премиум: закрытые страницы, HR, PLAN_STALE',
    preset: 'calm', set: {},
    steps: 'Выйди и открой по адресу закрытую страницу (Альбом). Войди как junior, открой /hr по адресу. Получи третью ачивку (5 офферов в вишлист), купи премиум и открой Переговорку.',
    verdict({ entries }) {
      const guest = entries.filter((e) => e.status === 401 && e.code === 'NO_TOKEN');
      const hr = entries.filter((e) => e.path.startsWith('/hr/') && e.auth?.role !== 'hr');
      const bought = entries.find((e) => e.method === 'POST' && e.path === '/premium' && fine(e));
      const refresh = bought && entries.find((e) => e.seq > bought.seq && e.path === '/auth/refresh' && fine(e));
      const lounge = refresh && entries.find((e) => e.seq > refresh.seq && e.path === '/lounge' && fine(e));
      const stale = Map.groupBy(entries.filter((e) => e.code === 'PLAN_STALE'), (e) => e.auth?.fp);
      const looped = [...stale.values()].filter((xs) => xs.length > 1);
      return [
        item(!guest.length, guest.length ? `Гость сходил на закрытые адреса: ${list(guest.map(show))} — сначала вход` : 'Гость не ходит на закрытые адреса: страница отправляет на вход до запроса'),
        item(!hr.length, hr.length ? `Запросы к HR-панели без роли hr: ${list(hr.map(show))}` : 'HR-панель запрашивает только hr'),
        item(bought, bought ? 'Премиум куплен' : 'Нет покупки премиума (POST /premium 200)'),
        item(refresh, refresh ? 'После покупки — refresh: тариф в пропуске обновлён' : 'После покупки премиума не было refresh'),
        item(lounge, lounge ? 'Переговорка открылась с новым пропуском' : 'Нет GET /lounge 200 после refresh'),
        item(!looped.length, looped.length ? `PLAN_STALE с одним пропуском ${Math.max(...looped.map((xs) => xs.length))} раза — после первого нужен refresh` : 'PLAN_STALE не повторяется с тем же пропуском'),
      ];
    },
  },
  {
    n: 13, title: 'Покупка: Idempotency-Key, двойной клик, 409 «цену подняли»',
    preset: 'calm', set: { delayMs: 800, priceJump: true },
    steps: 'Открой оффер дешевле 150 🍪 и нажми «Купить» дважды быстро. Цена прыгнет на 10% — в модалке подтверди новую цену, тоже двойным кликом.',
    verdict({ entries }) {
      const buys = entries.filter((e) => e.method === 'POST' && e.path === '/purchases' && e.status !== null);
      const keyless = buys.filter((e) => !e.idem);
      const jumped = buys.filter((e) => e.code === 'PRICE_CHANGED');
      const offerOf = (e) => e.body?.offerId;
      const rebought = jumped.filter((j) => buys.some((b) => b.seq > j.seq && offerOf(b) === offerOf(j) && b.body?.expectedPrice === j.info?.price && b.status === 201));
      const paid = buys.filter((e) => e.status === 201 && !e.replayed);
      const twice = paid.filter((a, i) => paid.slice(i + 1).some((b) => offerOf(b) === offerOf(a) && b.t - a.t < 3000));
      return [
        item(buys.length && !keyless.length, !buys.length ? 'Покупок не было' : keyless.length ? `Без Idempotency-Key: ${keyless.length} из ${buys.length}` : `Все ${buys.length} покупок — с Idempotency-Key`),
        item(jumped.length, jumped.length ? `409 «цену подняли»: ${jumped.length}` : 'Не было 409 PRICE_CHANGED: купи после «Начать»'),
        item(rebought.length, rebought.length ? 'После 409 куплено по новой цене из ответа' : 'После 409 нет покупки с expectedPrice из ответа'),
        item(paid.length && !twice.length, twice.length ? `Двойной клик — две покупки: ${list(twice.map((e) => offerOf(e)))}` : 'Двойной клик — одна покупка'),
      ];
    },
  },
  {
    n: 19, title: 'Прокачка: одна задача на двойной клик, опрос останавливается',
    preset: 'calm', set: { delayMs: 600 },
    steps: 'В Альбоме нажми «Прокачать» у карточки дважды быстро. Дождись конца задачи и побудь на странице ещё 5 секунд.',
    verdict({ entries }) {
      const started = entries.filter((e) => e.method === 'POST' && e.path === '/upgrade' && e.status === 202 && !e.replayed);
      const twice = started.filter((a, i) => started.slice(i + 1).some((b) => b.body?.cardId === a.body?.cardId && b.t - a.t < 3000));
      const polls = entries.filter((e) => e.method === 'GET' && /^\/jobs\/[^/]+$/.test(e.path));
      const finals = [...Map.groupBy(polls, (e) => e.path).values()].map((xs) => [xs.find((e) => e.status === 200 && !e.retryAfter), xs]).filter(([f]) => f);
      const extra = finals.flatMap(([f, xs]) => xs.filter((e) => e.t > end(f)));
      return [
        item(started.length, `Задач прокачки: ${started.length}`),
        item(started.length && !twice.length, twice.length ? `Двойной клик — две задачи на одну карточку: ${twice.length}` : 'На одну карточку — одна задача'),
        item(finals.length, finals.length ? `Опрос дошёл до конца задачи: ${finals.length}` : 'Опрос /jobs/:id не дождался конца задачи'),
        item(finals.length && !extra.length, extra.length ? `Опрос не остановился: ещё ${extra.length} запросов после конца задачи` : 'После конца задачи опрос остановлен'),
      ];
    },
  },
  {
    n: 20, title: 'Бегущая строка: одно SSE-подключение',
    preset: 'calm', set: {},
    steps: 'В одной вкладке открой 10 разных страниц приложения подряд и вернись на главную. Другие вкладки с каркасом закрой.',
    verdict({ entries, streams }) {
      const opened = entries.filter((e) => e.sse && e.status === 200);
      return [
        item(opened.length || streams, `Бегущая строка подключалась: ${opened.length} раз за проверку, открыто сейчас ${streams}`),
        item(streams <= 1, streams <= 1 ? 'Открыт не больше одного потока /stream' : `Открыто потоков: ${streams} — старые EventSource не закрыты`),
      ];
    },
  },
];

export function createChecks({ journal, chaos, auth, streams }) {
  const started = new Map();   // originKey → { n, mark, at }
  const find = (n) => {
    const def = CHECKS.find((c) => c.n === Number(n));
    if (!def) throw new HttpError(404, 'NOT_FOUND', `Тикет Т${n} сервер не проверяет. Есть: ${CHECKS.map((c) => `Т${c.n}`).join(', ')}`);
    return def;
  };
  const about = ({ n, title, preset, set, steps, expire }) => ({ n, title, preset, set, steps, expire: Boolean(expire) });

  const router = express.Router();
  router.get('/__check', (req, res) => res.json({ items: CHECKS.map(about) }));

  router.post('/__check/:n/start', chaos.own, (req, res) => {
    const def = find(req.params.n);
    const origin = journal.originOf(req);
    const state = chaos.preset(def.preset, def.set);
    if (def.expire) auth.expireAll();
    const s = { n: def.n, mark: journal.last(), at: Date.now() };
    started.set(originKey(origin), s);
    log('check', `Т${def.n} начат · ${originKey(origin)}`);
    res.json({ ...about(def), origin: originKey(origin), startedAt: s.at, chaos: state.settings });
  });

  router.get('/__check/:n', (req, res) => {
    const def = find(req.params.n);
    const origin = journal.originOf(req);
    const s = started.get(originKey(origin));
    if (s?.n !== def.n) throw new HttpError(409, 'NOT_STARTED', `Сначала «Начать» для Т${def.n}: иначе непонятно, с какого запроса смотреть`);
    const entries = journal.since(origin, s.mark).filter((e) => e.ms !== null || e.sse);
    const live = Object.entries(streams()).filter(([o]) => originKey(o) === originKey(origin)).reduce((sum, [, k]) => sum + k, 0);
    const items = def.verdict({ entries, streams: live });
    const ok = items.every((i) => i.ok);
    log('check', `Т${def.n} ${ok ? '✅' : '❌'} · ${originKey(origin)} · ${items.filter((i) => i.ok).length}/${items.length}`);
    res.json({ n: def.n, title: def.title, origin: originKey(origin), ok, items, requests: entries.length, startedAt: s.at, serverTime: Date.now() });
  });

  return { router };
}
