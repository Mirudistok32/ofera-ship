import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { http } from '../api/http';
import { cached, read, subscribe, TTL_MS } from '../api/cache';
import type { CacheSnapshot } from '../api/cache';

/* Загрузка данных для страницы: useQuery<T>(path) → { status, data, error, reload, fetching }.
   path = null — ничего не грузить (например, пока нет входа).
   Т2 и Т7: данные живут в кэше по адресу, компонент подписан на свою запись через useSyncExternalStore.
   - Ответ старого адреса не перетрёт новый: у каждого адреса своя запись.
   - Отмена: сменился адрес или страница ушла — подписчиков у старой записи нет, кэш отменяет её запрос.
   - success со старыми данными и fetching: true — показываем устаревшее, пока в фоне идёт свежее. */

export type QueryStatus = 'idle' | 'loading' | 'success' | 'error';
export type QueryState<T> = { status: QueryStatus; data: T | null; error: unknown; reload: () => void; fetching: boolean };

const IDLE: CacheSnapshot<never> = { data: null, error: null, at: 0, loading: false };
const noop = () => () => {};

/* Общая часть: ключ кэша и чем грузить. loader получает ключ — его объявляют вне компонента, и он не меняется между рендерами */
export function useCached<T>(key: string | null, loader: (key: string, signal: AbortSignal) => Promise<T>, ttl = TTL_MS): QueryState<T> {
  const sub = useCallback((listener: () => void) => (key === null ? noop() : subscribe(key, listener)), [key]);
  const snap = useSyncExternalStore(sub, () => (key === null ? IDLE : read<T>(key)));

  const load = useCallback((maxAge: number) => {
    if (key !== null) cached(key, (signal) => loader(key, signal), maxAge).catch(() => {});   // ошибка уже в снимке
  }, [key, loader]);

  // Запись сбросили (invalidate, clearCache) — перепроверить. После ошибки сам не ходим: ждём reload
  const stale = key !== null && snap.at === 0 && !snap.loading && snap.error === null;
  useEffect(() => load(ttl), [load, ttl, stale]);
  const reload = useCallback(() => load(0), [load]);

  const status: QueryStatus = key === null ? 'idle' : snap.data !== null ? 'success' : snap.error !== null ? 'error' : 'loading';
  return { status, data: snap.data, error: snap.error, reload, fetching: snap.loading };
}

const get = <T,>(path: string, signal: AbortSignal) => http<T>(path, { signal });

export function useQuery<T>(path: string | null, ttl = TTL_MS): QueryState<T> {
  return useCached<T>(path, get, ttl);
}
