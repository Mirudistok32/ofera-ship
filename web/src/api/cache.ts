import { isAbort } from './http';

/* Кэш GET-запросов каталога (Т7) — внешнее хранилище для useSyncExternalStore.
   Ключ — адрес запроса. В записи — снимок (данные, ошибка, когда получены, идёт ли запрос), запрос в полёте и подписчики.
   - Дедупликация: пока запрос идёт, все просящие получают тот же промис.
   - TTL: свежее (моложе maxAge) отдаётся без сети.
   - Stale-while-revalidate: старые данные остаются в снимке и видны сразу, новый запрос идёт в фоне.
   - Отписались все — запрос больше никому не нужен: его сигнал отменяется. */

export type CacheSnapshot<T> = { data: T | null; error: unknown; at: number; loading: boolean };

type Entry = {
  snap: CacheSnapshot<unknown>;
  promise: Promise<unknown> | null;
  ctrl: AbortController | null;
  listeners: Set<() => void>;
};

export const TTL_MS = 15_000;
const EMPTY: CacheSnapshot<never> = { data: null, error: null, at: 0, loading: false };
const store = new Map<string, Entry>();

function entry(key: string): Entry {
  let e = store.get(key);
  if (!e) store.set(key, (e = { snap: EMPTY, promise: null, ctrl: null, listeners: new Set() }));
  return e;
}

/* Снимок меняется только целиком: useSyncExternalStore сравнивает по ссылке */
function set(e: Entry, snap: CacheSnapshot<unknown>) {
  e.snap = snap;
  e.listeners.forEach((l) => l());
}

/* Бросить запрос в полёте: его ответ уже не нужен (сброс, все ушли) */
function drop(e: Entry) {
  e.ctrl?.abort();
  e.promise = null;
  e.ctrl = null;
}

export function read<T>(key: string): CacheSnapshot<T> {
  return (store.get(key)?.snap ?? EMPTY) as CacheSnapshot<T>;
}

export function subscribe(key: string, listener: () => void): () => void {
  const e = entry(key);
  e.listeners.add(listener);
  return () => {
    e.listeners.delete(listener);
    // Проверка — в микрозадаче: StrictMode и смена подписки отписывают и тут же подписывают снова, такой запрос живёт.
    // Только сигнал: fetch прервётся, а общий батч (Т8) всё равно придёт — его ответ запишется и пригодится
    queueMicrotask(() => {
      if (!e.listeners.size) e.ctrl?.abort();
    });
  };
}

export function cached<T>(key: string, load: (signal: AbortSignal) => Promise<T>, maxAge = TTL_MS): Promise<T> {
  const e = entry(key);
  if (e.promise && !e.ctrl?.signal.aborted) return e.promise as Promise<T>;   // уже идёт — тот же запрос
  if (e.snap.at && Date.now() - e.snap.at < maxAge) return Promise.resolve(e.snap.data as T);

  const ctrl = new AbortController();
  // Ответ пишется, только если этот запрос всё ещё текущий: после сброса или отмены он опоздал
  const settle = (snap: CacheSnapshot<unknown>) => {
    if (e.promise !== promise) return;
    e.promise = null;
    e.ctrl = null;
    set(e, snap);
  };
  const promise: Promise<T> = load(ctrl.signal).then(
    (data) => {
      settle({ data, error: null, at: Date.now(), loading: false });
      return data;
    },
    (error: unknown) => {
      settle({ ...e.snap, error: isAbort(error) ? e.snap.error : error, loading: false });   // старые данные не стираем
      throw error;
    },
  );
  e.promise = promise;
  e.ctrl = ctrl;
  set(e, { ...e.snap, loading: true });
  return promise;
}

/* Данные по ключам с этим началом устарели (после покупки, правки): следующий показ перепроверит их, старое пока видно */
export function invalidate(prefix: string): void {
  for (const [key, e] of store) {
    if (!key.startsWith(prefix)) continue;
    drop(e);
    set(e, { ...e.snap, at: 0, loading: false });
  }
}

/* Стереть всё — при выходе и входе, чтобы не показать чужое (Т12) */
export function clearCache(): void {
  for (const e of store.values()) {
    drop(e);
    set(e, EMPTY);
  }
}
