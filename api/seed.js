/* Сид «Офферомании»: фиксированное зерно → у всех одни и те же 10 000 офферов, 60 компаний и 3 пользователя.
   node quest/server/seed.js --reset   (npm run quest:reset) — стереть quest/.data/db.json и записать чистый сид */
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DB_FILE } from './config.js';
import { writeData } from './db.js';
import { log } from './log.js';

export const SEED = 20261029;
const BASE = Date.UTC(2026, 9, 1, 9, 0, 0);   // «сейчас» сида — даты не зависят от дня запуска

/* mulberry32: маленький детерминированный генератор */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const RARITIES = [
  { id: 'common', name: 'обычный', weight: 55, price: [20, 60] },
  { id: 'rare', name: 'редкий', weight: 25, price: [60, 140] },
  { id: 'epic', name: 'эпический', weight: 12, price: [140, 300] },
  { id: 'legendary', name: 'легендарный', weight: 6, price: [300, 600] },
  { id: 'mythic', name: 'мифический', weight: 2, price: [600, 1200] },
];

export const FLAGS = [
  { id: 'family', text: 'Мы как семья', hint: 'Семью не выбирают. И из неё не увольняются.' },
  { id: 'young-team', text: 'Молодой динамичный коллектив', hint: 'Старше 25 не задерживаются.' },
  { id: 'flex-hours', text: 'Ненормированный график', hint: 'Норма есть, просто её никто не видел.' },
  { id: 'salary-later', text: 'Зарплата по итогам собеседования', hint: 'Итоги подводят в пользу компании.' },
  { id: 'stress', text: 'Стрессоустойчивость', hint: 'Пожар — это рабочий процесс.' },
  { id: 'multitask', text: 'Многозадачность', hint: 'Три вакансии по цене одной.' },
  { id: 'cookies', text: 'Печеньки в офисе', hint: 'Вместо индексации.' },
  { id: 'startup-spirit', text: 'Дух стартапа', hint: 'Денег нет, но держитесь.' },
  { id: 'wear-hats', text: 'Готовность к разным задачам', hint: 'Сегодня фронтенд, завтра бухгалтерия.' },
  { id: 'gray-salary', text: 'Белая часть — МРОТ', hint: 'Остальное — в конверте с бантиком.' },
  { id: 'test-week', text: 'Тестовое на неделю', hint: 'Заодно и прод починишь.' },
  { id: 'rockstar', text: 'Ищем рок-звезду', hint: 'Гастроли без гонорара.' },
];

/* Бесплатные и премиальные усиления Лавки: количество, перезарядка, срок эффекта */
export const BOOSTS = [
  { id: 'coffee', emoji: '☕', name: 'Кофе', premium: false, price: 5, qty: 3, cooldownSec: 60, durationSec: 300, effect: 'Таймер HR идёт на 20% медленнее', incompatible: [] },
  { id: 'cover-letter', emoji: '✉️', name: 'Сопроводительное письмо', premium: false, price: 15, qty: 2, cooldownSec: 120, durationSec: 0, effect: '−10% к цене покупки', incompatible: ['offer-in-hand'] },
  { id: 'smile', emoji: '🙂', name: 'Улыбка на созвоне', premium: false, price: 10, qty: 3, cooldownSec: 90, durationSec: 600, effect: '+5% к шансу прокачки', incompatible: [] },
  { id: 'advance', emoji: '💸', name: 'Аванс', premium: false, price: 0, qty: 1, cooldownSec: 600, durationSec: 0, effect: '+50 🍪 раз в 10 минут', incompatible: [] },
  { id: 'hr-friend', emoji: '🤝', name: 'Знакомый в HR', premium: true, price: 0, qty: 1, cooldownSec: 0, durationSec: 900, effect: 'Видна вилка без покупки', incompatible: [] },
  { id: 'offer-in-hand', emoji: '📨', name: 'Оффер на руках', premium: true, price: 0, qty: 1, cooldownSec: 300, durationSec: 0, effect: '−25% к цене покупки', incompatible: ['cover-letter'] },
  { id: 'freeze', emoji: '🧊', name: 'Заморозка', premium: true, price: 0, qty: 2, cooldownSec: 180, durationSec: 120, effect: 'Цена оффера не меняется 2 минуты', incompatible: [] },
  { id: 'referral', emoji: '🔑', name: 'Рекомендация', premium: true, price: 0, qty: 1, cooldownSec: 900, durationSec: 0, effect: 'Прокачка без шанса «HR передумал»', incompatible: [] },
];

export const ACHIEVEMENTS = [
  { id: 'first-login', emoji: '🚪', name: 'Первый вход', text: 'Добро пожаловать в «Оффероманию».' },
  { id: 'onboarding', emoji: '📋', name: 'Онбординг', text: 'Заполнить профиль, которого нет.' },
  { id: 'watcher', emoji: '👀', name: 'Насмотренность', text: 'Открыть 10 офферов.' },
  { id: 'family', emoji: '👨‍👩‍👧', name: 'Мы как семья', text: 'Купить оффер с флагом «Мы как семья».' },
  { id: 'red-flag', emoji: '🚩', name: 'Красный флаг — мой любимый цвет', text: 'Купить оффер с тремя флагами и больше.' },
  { id: 'night-shift', emoji: '🌙', name: 'Ночная смена', text: 'Сделать покупку с 00:00 до 05:00.' },
  { id: 'collector', emoji: '🗂️', name: 'Коллекционер', text: 'Разложить офферы по всем четырём полкам.' },
  { id: 'upgrade', emoji: '⬆️', name: 'Рост внутри компании', text: 'Прокачать оффер.' },
  { id: 'auction', emoji: '🔨', name: 'Продано!', text: 'Выиграть аукцион.' },
  { id: 'wishlist', emoji: '⭐', name: 'Хочу-хочу', text: 'Добавить 5 офферов в вишлист.' },
];

/* Полки Альбома и уровни прокачки (12.5) */
export const SHELVES = [
  { id: 'accept', emoji: '✅', name: 'Принять' },
  { id: 'think', emoji: '🤔', name: 'Подумать' },
  { id: 'mom', emoji: '👩', name: 'Показать маме' },
  { id: 'frame', emoji: '🖼️', name: 'В рамочку' },
];
export const LEVELS = ['Junior', 'Middle', 'Senior', 'Lead', 'Архитектор презентаций'];

/* Таблицы, которые сид создаёт пустыми; старая база получает недостающие при запуске (db.ensure) */
export const EMPTY_TABLES = ['purchases', 'wishlist', 'lots', 'bids', 'jobs', 'sessions', 'idempotency'];

const NAMED = [
  { name: 'Галера №7', emoji: '🚣', motto: 'Гребём вместе. Вёсла — за свой счёт.' },
  { name: 'ООО «Мы как семья»', emoji: '👨‍👩‍👧', motto: 'Отпуск — это предательство.' },
  { name: 'Единорог-на-подходе', emoji: '🦄', motto: 'Оценка — миллиард, выручка — скоро.' },
  { name: 'Печеньки Инк.', emoji: '🍪', motto: 'Платим печеньками. Иногда деньгами.' },
  { name: 'Обёртка над нейросетью', emoji: '🤖', motto: 'Наш продукт — одна кнопка и подписка.' },
  { name: 'Вечный пивот', emoji: '🔄', motto: 'В понедельник — доставка, в среду — блокчейн.' },
];
const ADJ = ['Гибкий', 'Быстрый', 'Облачный', 'Agile', 'Вечный', 'Скромный', 'Тёплый', 'Ламповый', 'Хайповый', 'Срочный', 'Синергичный', 'Бирюзовый'];
const NOUN = ['Спринт', 'Бэклог', 'Дедлайн', 'Митап', 'Стендап', 'Релиз', 'Хакатон', 'Онбординг', 'Пайплайн', 'Ретро', 'Демо', 'Пилот'];
const FORM = ['ООО', 'АО', 'Студия', 'Лаб', 'Холдинг', 'Стартап'];
const MOTTO = ['Работаем на результат. Чей — не уточняем.', 'Без бюрократии: решения принимает основатель, один.', 'Удалёнка из офиса.', 'Каждый день — как первый. Опыт не копится.', 'Растём на 300% в год. Штат — тоже.', 'Обратная связь раз в квартал. По пятницам.'];
const CO_EMOJI = ['🏢', '🚀', '🧪', '📈', '🛠️', '🎯', '🧩', '🌀', '🐙', '🦊', '🐝', '🧱'];
const ROLES = ['Frontend-разработчик', 'React-разработчик', 'Верстальщик', 'Fullstack (но больше front)', 'TypeScript-разработчик', 'Разработчик интерфейсов', 'Frontend-инженер', 'Разработчик дизайн-системы', 'Специалист по кнопкам', 'Инженер по формам'];
export const GRADES = ['Junior', 'Junior+', 'Middle', 'Middle+', 'Senior', 'Lead'];
const STACK = ['React', 'TypeScript', 'Next.js', 'Vite', 'CSS', 'Redux', 'GraphQL', 'Jest', 'Playwright', 'Webpack', 'jQuery', 'Figma'];
const PERKS = ['ДМС после испытательного', 'Фрукты по средам', 'Гибкое начало дня с 9:00 до 9:05', 'Корпоративный английский', 'Оплата курсов (своих)', 'Тимбилдинг в субботу', 'Кресло как у геймера', 'Удалёнка по пятницам', 'Без созвонов до обеда', 'Честная вилка'];
const CITIES = ['Удалённо', 'Москва', 'Санкт-Петербург', 'Казань', 'Новосибирск', 'Екатеринбург', 'Где-то в облаке'];
const PITCH = ['Нужен человек, который сделает как в Figma, только лучше и вчера.', 'Проект с нуля: легаси начинается завтра.', 'Ищем того, кто перепишет всё на новый фреймворк. Снова.', 'Команда из одного тимлида. Будет двое!', 'Продукт уже почти нашёл пользователя.', 'Задачи интересные, сроки — тоже.'];

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

export function seed() {
  const rnd = rng(SEED);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const some = (list, a, b) => {
    const rest = [...list];
    return [...Array(int(a, b))].map(() => rest.splice(Math.floor(rnd() * rest.length), 1)[0]).filter(Boolean);
  };
  const weighted = (list) => {
    let x = rnd() * list.reduce((s, r) => s + r.weight, 0);
    return list.find((r) => (x -= r.weight) < 0) ?? list[0];
  };
  const pad = (n, w) => String(n).padStart(w, '0');

  /* 60 компаний: 6 «звёзд» + 54 сочетания без повторов */
  const names = new Set();
  const companies = NAMED.map((c, i) => ({ id: `c${pad(i + 1, 2)}`, ...c, rating: +(1.5 + rnd() * 3.5).toFixed(1), size: pick(['10–50', '50–200', '200–1000', '1000+']), v: 1 }));
  companies.forEach((c) => names.add(c.name));
  while (companies.length < 60) {
    const name = `${pick(FORM)} «${pick(ADJ)} ${pick(NOUN).toLowerCase()}»`;
    if (names.has(name)) continue;
    names.add(name);
    companies.push({ id: `c${pad(companies.length + 1, 2)}`, name, emoji: pick(CO_EMOJI), motto: pick(MOTTO), rating: +(1.5 + rnd() * 3.5).toFixed(1), size: pick(['10–50', '50–200', '200–1000', '1000+']), v: 1 });
  }

  /* 10 000 офферов. Красный флаг есть у каждого: фильтр «без флагов» всегда пуст */
  const offers = [...Array(10000)].map((_, i) => {
    const rarity = weighted(RARITIES);
    const grade = pick(GRADES);
    const gi = GRADES.indexOf(grade);
    const salaryTo = (int(8, 50) + gi * 10) * 10000;
    const honest = rarity.id === 'mythic';
    const flags = some(FLAGS, 1, rarity.id === 'common' ? 4 : rarity.id === 'legendary' || honest ? 1 : 3).map((f) => f.id);
    return {
      id: `o${pad(i + 1, 5)}`,
      title: `${pick(ROLES)} (${grade})`,
      grade,
      companyId: pick(companies).id,
      rarity: rarity.id,
      price: int(...rarity.price),
      salaryTo,
      salaryFrom: honest ? Math.round(salaryTo * 0.85 / 1000) * 1000 : Math.round(salaryTo * (0.25 + rnd() * 0.3) / 1000) * 1000,
      flags,
      stack: some(STACK, 2, 4),
      perks: rarity.id === 'legendary' ? ['Удалёнка', '4-дневка', 'Без созвонов'] : some(PERKS, 1, 3),
      city: rarity.id === 'legendary' ? 'Удалённо' : pick(CITIES),
      pitch: pick(PITCH),
      createdAt: new Date(BASE - i * 7 * 60 * 1000).toISOString(),
      v: 1,
    };
  });

  /* boosts — сколько зарядов усиления осталось; cooldowns — когда его снова можно включить; effects — до какого времени оно действует;
     frozen — 🍪 в ставках аукциона, которые ещё не перебили (в cookies их уже нет) */
  const user = (id, login, extra) => ({
    id, login,
    passwordHash: hashPassword(login, `quest:${login}`),
    salt: `quest:${login}`,
    role: 'user', plan: 'free', premiumUntil: null,
    cookies: 150, frozen: 0, achievements: [], boosts: {}, cooldowns: {}, effects: {},
    createdAt: new Date(BASE).toISOString(),
    v: 1,
    ...extra,
  });
  /* junior: 2 ачивки на старте, третья («Насмотренность») достижима в первый день */
  const users = [
    user('u1', 'junior', { name: 'Джун', achievements: ['first-login', 'onboarding'], boosts: { coffee: 3, smile: 3, 'cover-letter': 2, advance: 1 } }),
    user('u2', 'rich', { name: 'Богатый соискатель', plan: 'premium', cookies: 5000, achievements: ACHIEVEMENTS.slice(0, 6).map((a) => a.id), boosts: Object.fromEntries(BOOSTS.map((b) => [b.id, b.qty])) }),
    user('u3', 'hr', { name: 'HR', role: 'hr', cookies: 0, achievements: ['first-login'] }),
  ];

  /* Альбом rich — 200 карточек «от прошлого владельца»: для фильтра полок (Т21) и общих часов (Т22).
     Каждый десятый оффер — тройной дубль для слияния. hrEverySec — период таймера «ответь HR» */
  const shelves = [null, ...SHELVES.map((s) => s.id)];
  const album = [];
  while (album.length < 200) {
    const offer = pick(offers);
    const copies = album.length % 10 === 0 ? 3 : 1;
    for (let k = 0; k < copies && album.length < 200; k++) {
      album.push({
        id: `a-r${pad(album.length + 1, 3)}`, userId: 'u2', offerId: offer.id, purchaseId: null,
        shelf: pick(shelves), level: 0, hrEverySec: int(5, 60) * 60,
        acquiredAt: new Date(BASE - album.length * 3600 * 1000).toISOString(),
        v: 1,
      });
    }
  }

  const withV = (list) => list.map((x) => ({ ...x, v: 1 }));
  return {
    meta: { seed: SEED, boots: 0, createdAt: new Date(BASE).toISOString() },
    tables: {
      users, companies, offers,
      flags: withV(FLAGS), boosts: withV(BOOSTS), achievementDefs: withV(ACHIEVEMENTS),
      album, ...Object.fromEntries(EMPTY_TABLES.map((name) => [name, []])),
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--reset')) {
    console.log('Использование: node quest/server/seed.js --reset   (или npm run quest:reset)');
    process.exit(1);
  }
  const data = seed();
  writeData(DB_FILE, data);
  log('seed', `чистая база: ${data.tables.offers.length} офферов, ${data.tables.companies.length} компаний, ${data.tables.users.length} пользователя → ${DB_FILE}`);
}
