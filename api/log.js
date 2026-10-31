/* Журнал в терминале: [http] [db] [cors] [auth] [abrt] [chaos] [check] — видно, что сервер сделал с каждым запросом */
import { QUIET } from './config.js';

const COLOR = { http: 36, db: 33, cors: 35, auth: 32, abrt: 31, err: 31, seed: 34, sse: 94, bot: 90, chaos: 91, check: 96 };
const tty = process.stdout.isTTY && !process.env.NO_COLOR;

export function log(tag, ...parts) {
  if (QUIET) return;
  const label = `[${tag}]`.padEnd(7);
  console.log(tty ? `\x1b[${COLOR[tag] ?? 37}m${label}\x1b[0m` : label, ...parts);
}

const short = (origin) => (origin ? origin.replace(/^https?:\/\/(localhost|127\.0\.0\.1)/, '') : '—');

/* Строка на запрос после ответа; запрос, оборванный клиентом (AbortController, закрытая вкладка), — [abrt].
   Поток SSE закрывается только клиентом — его открытие и закрытие пишет сам /stream ([sse]) */
export function requestLog() {
  return (req, res, next) => {
    const t0 = performance.now();
    res.on('close', () => {
      if (req.sse || req.chaos === 'drop') return;   // обрыв уже записал пульт ([chaos])
      if (req.method === 'GET' && req.path.startsWith('/__')) return;   // пульт опрашивает журнал и счётчики — не шумим
      const ms = Math.round(performance.now() - t0);
      const db = req.db?.queries ? ` · db ${req.db.queries}×` : '';
      if (!res.writableFinished) log('abrt', `${req.method} ${req.originalUrl} — клиент ушёл через ${ms} мс${db}`);
      else log('http', `${req.method} ${req.originalUrl} ${res.statusCode} ${ms} мс${db} · ${short(req.headers.origin)} · ${req.id}`);
    });
    next();
  };
}
