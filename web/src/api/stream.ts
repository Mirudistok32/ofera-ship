import { API } from '../config';
import { getToken, onSession, refresh } from './session';

/* Один поток SSE /stream на всё приложение: бегущая строка (price) и аукцион (bid, lot-end) подписываются сюда.
   Поток — на 127.0.0.1, API — на localhost: открытый EventSource держит одно из 6 соединений на хост,
   и на другом хосте он не занимает очередь запросов к API.
   EventSource не шлёт заголовки, поэтому пропуск — в ?token=. Сменился пропуск (вход, refresh, выход) — новый поток.
   Пропуск просрочен — сервер отвечает 401, и EventSource сам уже не переподключится: refresh и новый поток. */

const STREAM = API.replace('localhost', '127.0.0.1');
const RETRY_MS = 3000;   // пауза перед новым потоком, если refresh не удался

type Handler = (data: unknown) => void;

const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
let listened = new Set<string>();       // на какие типы событий подписан текущий EventSource
let openedWith: string | null = null;   // с каким пропуском открыт поток
let lastEventId = '';                   // с какого события догонять после переподключения
let offset = 0;                         // часы сервера минус часы браузера, мс

/* Время по часам сервера: таймеры аукциона считают от него, а не от Date.now() — у браузера часы могут убежать */
export const serverNow = (): number => Date.now() + offset;

/* Любое событие несёт serverTime — по нему держим сдвиг часов. Ответы API (/lots и другие) уточняют его тоже */
export function syncClock(serverTime: number): void {
  offset = serverTime - Date.now();
}

function listen(es: EventSource, type: string): void {
  if (listened.has(type)) return;
  listened.add(type);
  es.addEventListener(type, (e) => {
    const event = e as MessageEvent<string>;
    if (event.lastEventId) lastEventId = event.lastEventId;
    const data = JSON.parse(event.data);
    if (typeof data.serverTime === 'number') syncClock(data.serverTime);
    for (const handler of handlers.get(type) ?? []) handler(data);
  });
}

function open(): void {
  source?.close();
  const token = getToken();
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (lastEventId) params.set('lastEventId', lastEventId);   // догнать то, что пришло, пока потока не было
  const query = params.toString();
  const es = new EventSource(`${STREAM}/stream${query ? `?${query}` : ''}`);
  source = es;
  listened = new Set();
  openedWith = token;
  listen(es, 'hello');
  for (const type of handlers.keys()) listen(es, type);
  es.onerror = () => {
    /* CONNECTING — обрыв сети, браузер переподключится сам через retry: 3000.
       CLOSED — сервер ответил не 200 (401 по просроченному пропуску): обновляем пропуск и открываем заново */
    if (es.readyState !== EventSource.CLOSED || source !== es) return;
    source = null;
    // refresh упал (сеть, 5xx) — пауза, как retry у сервера: иначе 401 и refresh шли бы по кругу без остановки
    refresh()
      .then(() => 0, () => RETRY_MS)
      .then((pause) => setTimeout(() => {
        if (!source && handlers.size) open();
      }, pause));
  };
}

/* Вход, refresh и выход приходят сюда: пропуск другой — поток с ним */
onSession(() => {
  if (source && getToken() !== openedWith) open();
});

/* subscribe('bid', handler) → функция отписки, её и возвращаем из useEffect.
   Последний отписался — поток закрыт: в StrictMode и при уходе со страницы ничего не висит */
export function subscribe<T>(type: string, handler: (data: T) => void): () => void {
  const fn: Handler = (data) => handler(data as T);
  const set = handlers.get(type) ?? new Set<Handler>();
  handlers.set(type, set);
  set.add(fn);
  if (source) listen(source, type);
  else open();
  return () => {
    set.delete(fn);
    if (!set.size) handlers.delete(type);
    if (!handlers.size) {
      source?.close();
      source = null;
    }
  };
}
