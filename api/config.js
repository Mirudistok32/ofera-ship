/* Настройки сервера «Офферомании». Переменные окружения нужны selftest'у: свой порт и своя папка с данными */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.QUEST_PORT) || 4010;
export const DATA_DIR = process.env.QUEST_DATA || path.join(HERE, '../.data'); // вне server/: --watch-path перезапускал бы сервер на каждую запись базы
export const DB_FILE = path.join(DATA_DIR, 'db.json');

/* Каркас (app) и эталон (solution). Остальным origin CORS-заголовков не достаётся */
export const ORIGINS = (process.env.QUEST_ORIGINS || [
  'http://localhost:5190', 'http://127.0.0.1:5190',
  'http://localhost:5191', 'http://127.0.0.1:5191',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

export const QUIET = process.env.QUEST_QUIET === '1';

/* Срок жизни токенов в секундах. Access короткий нарочно: refresh случается часто и виден в журнале */
export const ACCESS_TTL = Number(process.env.QUEST_ACCESS_TTL) || 30;
export const REFRESH_TTL = Number(process.env.QUEST_REFRESH_TTL) || 7 * 24 * 3600;
export const LOGIN_LIMIT = { attempts: 5, windowMs: 60_000 };

/* «Синдром отличника»: цена в ачивках и срок в секундах (selftest укорачивает, чтобы дождаться конца) */
export const PREMIUM = { cost: 3, sec: Number(process.env.QUEST_PREMIUM_SEC) || 15 * 60 };

/* Прокачка: длина задачи и шанс «HR передумал» (selftest ставит 0 или 1, чтобы исход был известен заранее) */
export const UPGRADE = {
  jobMs: Number(process.env.QUEST_JOB_MS) || 4000,
  failRate: process.env.QUEST_UPGRADE_FAIL === undefined ? 0.15 : Number(process.env.QUEST_UPGRADE_FAIL),
};

const num = (name, fallback) => (process.env[name] === undefined ? fallback : Number(process.env[name]));

/* Аукцион: шаг ставки, антиснайпинг (ставка в последние snipeSec секунд продлевает торги на extendSec), длина лота ботов */
export const AUCTION = {
  step: 10,
  snipeSec: num('QUEST_SNIPE_SEC', 10),
  extendSec: num('QUEST_EXTEND_SEC', 15),
  lotSec: num('QUEST_LOT_SEC', 180),
};

/* Боты: как часто двигают цену бегущей строки (0 — цены стоят), сколько лотов держат открытыми,
   шанс и задержка ответной ставки «Вечного кандидата» (0 — не перебивает). selftest выключает их, где мешают */
export const BOTS = {
  priceMs: num('QUEST_BOT_PRICE_MS', 4000),
  lots: num('QUEST_BOT_LOTS', 4),
  outbidRate: num('QUEST_BOT_OUTBID', 0.6),
  outbidMs: num('QUEST_BOT_OUTBID_MS', 2500),
};

/* Проверка тикетов: Т7 считает, что свежее взято из кэша, если один адрес запрошен не чаще раза в cacheGapMs */
export const CHECK = {
  cacheGapMs: num('QUEST_CACHE_GAP_MS', 5000),
};
