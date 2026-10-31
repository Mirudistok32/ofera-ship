import { API } from '../config';
import type { LoginResponse, User } from '../types';

/* Сессия: access-токен только в памяти — XSS не унесёт его из localStorage, а F5 его стирает.
   Сессию после F5 восстанавливает refresh: httpOnly-cookie quest_refresh лежит у браузера, JS её не видит.
   Refresh-токен одноразовый: второй обмен того же токена сервер считает кражей и отзывает всю цепочку.
   Поэтому refresh один на всё приложение (общий промис) и один на все вкладки (navigator.locks). */

let token: string | null = null;
let pending: Promise<LoginResponse | null> | null = null;
const listeners = new Set<(user: User | null) => void>();

export const getToken = (): string | null => token;

/* Новый пропуск после входа, refresh или выхода. Слушатели — useMe: шапка узнаёт свежего пользователя и тариф */
export function setSession(data: LoginResponse | null): void {
  token = data?.accessToken ?? null;
  for (const listener of listeners) listener(data?.user ?? null);
}

export function onSession(listener: (user: User | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* Сам обмен — голый fetch, не http: иначе 401 от /auth/refresh снова позвал бы refresh */
async function exchange(): Promise<LoginResponse | null> {
  const res = await fetch(`${API}/auth/refresh`, { method: 'POST', credentials: 'include' });
  if (res.status === 401) return null;   // NO_REFRESH, REFRESH_EXPIRED, REFRESH_REVOKED — нужен вход заново
  if (!res.ok) throw new Error(`Пропуск не продлился: ${res.status}`);   // 5xx — сессия, может, и жива: не выходим
  return res.json();
}

/* Вкладки встают в очередь за замком: вторая отправит уже новую cookie, которую получила первая */
async function exchangeLocked(): Promise<LoginResponse | null> {
  if (!navigator.locks) return exchange();
  return navigator.locks.request('quest-refresh', exchange);
}

/* Кто пришёл, пока refresh идёт, ждёт тот же промис. null — сессии нет; ошибка сети или 5xx — исключение, токен прежний */
export function refresh(): Promise<LoginResponse | null> {
  pending ??= exchangeLocked()
    .then((data) => {
      setSession(data);
      return data;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
