/* SSE «Офферомании»: GET /stream пересылает события шины в браузер (EventSource).
   - События: price (цена оффера сдвинулась — бот или HR), bid (ставка на лоте), lot-end (торги закончились) — всем;
     achievement и premium-end — только владельцу: для них нужен ?token=<access-токен> (EventSource заголовков не шлёт).
     Просроченный или кривой токен — 401 с WWW-Authenticate, как у остальных адресов: переподключаться — со свежим токеном.
   - Каждое событие — id, event, data (JSON с serverTime на момент отправки). Первым приходит hello.
     Последние 200 событий помнятся: переподключение с Last-Event-ID (или ?lastEventId=) получает пропущенное.
   - Раз в 15 с — комментарий «: ping», чтобы прокси и браузер не считали поток мёртвым. retry: 3000 — пауза автопереподключения.
   - Открытые подключения считаются по Origin: GET /__stream — для пульта и проверки Т20 (утечка EventSource). */
import express from 'express';
import { bus } from './bus.js';
import { log } from './log.js';

export const EVENTS = ['price', 'bid', 'lot-end', 'achievement', 'premium-end'];
export const STREAM = { history: 200, pingMs: 15_000, retryMs: 3000 };
const NO_ORIGIN = 'без Origin';

const short = (origin) => origin.replace(/^https?:\/\/(localhost|127\.0\.0\.1)/, '');

export function createStream({ auth }) {
  const router = express.Router();
  const clients = new Set();   // { res, userId, origin }
  const history = [];          // { id, type, data }
  let lastId = Date.now();     // id растут и после перезапуска: старый Last-Event-ID меньше любого нового

  const visible = (client, e) => !e.data.userId || e.data.userId === client.userId;
  const write = (client, e) => {
    if (client.res.writableEnded) return;
    client.res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e.data, serverTime: Date.now() })}\n\n`);
  };

  for (const type of EVENTS) {
    bus.on(type, (data) => {
      const e = { id: ++lastId, type, data };
      history.push(e);
      if (history.length > STREAM.history) history.shift();
      for (const c of clients) if (visible(c, e)) write(c, e);
    });
  }

  const ping = setInterval(() => {
    for (const c of clients) if (!c.res.writableEnded) c.res.write(': ping\n\n');
  }, STREAM.pingMs);
  ping.unref();

  const byOrigin = () => {
    const counts = {};
    for (const c of clients) counts[c.origin] = (counts[c.origin] ?? 0) + 1;
    return counts;
  };

  router.get('/stream', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const userId = token ? auth.authenticate(req, token).sub : null;
    const origin = req.headers.origin ?? NO_ORIGIN;
    const since = Number(req.headers['last-event-id'] ?? req.query.lastEventId);

    req.sse = true;   // журнал запросов не пишет закрытие потока как [abrt]
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const client = { res, userId, origin };
    clients.add(client);
    res.write(`retry: ${STREAM.retryMs}\n\n`);
    res.write(`event: hello\ndata: ${JSON.stringify({ userId, connections: clients.size, serverTime: Date.now() })}\n\n`);
    const missed = Number.isFinite(since) ? history.filter((e) => e.id > since && visible(client, e)) : [];
    for (const e of missed) write(client, e);
    log('sse', `+1 ${short(origin)}${userId ? ` · ${userId}` : ' · гость'}${missed.length ? ` · догнал ${missed.length} событий` : ''} · открыто ${clients.size}`);

    req.on('close', () => {
      clients.delete(client);
      log('sse', `−1 ${short(origin)} · открыто ${clients.size}`);
    });
  });

  /* Сколько потоков открыто и с каких origin: «через 10 минут 14 подключений» (Т20) видно здесь */
  router.get('/__stream', (req, res) => {
    res.json({ total: clients.size, byOrigin: byOrigin(), lastEventId: lastId, serverTime: Date.now() });
  });

  return { router, byOrigin };
}
