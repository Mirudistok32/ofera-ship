import { API } from '../config';
import { http } from './http';
import { clearCache } from './cache';
import { refresh, setSession } from './session';
import type { LoginResponse, User } from '../types';

/* Вход и выход. Access-токен — в памяти (session.ts), refresh — в httpOnly-cookie.
   credentials: 'include' — API на другом origin (:4010), без него браузер не сохранит и не отправит cookie.
   Кэш каталога чистится на каждой смене пользователя: вишлист и вилки в нём — чужие (Т12) */

export async function login(name: string, password: string): Promise<User> {
  const data = await http<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ login: name, password }),
    credentials: 'include',
  });
  clearCache();
  setSession(data);
  return data.user;
}

export async function logout(): Promise<void> {
  clearCache();
  setSession(null);
  /* 204 без тела, поэтому fetch, а не http. Сервер отзывает цепочку и стирает cookie; не вышло — локально уже вышли */
  await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
}

/* После F5 токена в памяти нет: спрашиваем новый по cookie. Нет cookie или сервер лёг — пока гость */
export async function restore(): Promise<User | null> {
  const data = await refresh().catch(() => null);
  return data?.user ?? null;
}
