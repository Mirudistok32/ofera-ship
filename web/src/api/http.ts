import { API } from '../config';
import { getToken, refresh } from './session';
import type { ApiErrorBody } from '../types';

/* Клиент API. Контракт http<T>(path, options): Promise<T> прежний — готовые части на него опираются.
   Т1: не-2xx — это HttpError с кодом и текстом сервера; сеть и таймаут — тоже HttpError, но со status 0.
   Т3: GET повторяется сам при обрыве, 5xx и 429 — с растущей паузой и не раньше Retry-After.
   Т10: 401 TOKEN_EXPIRED и 403 PLAN_STALE — новый пропуск через общий refresh и один повтор, любой метод:
   сервер отказал до того, как что-то сделал. */

const TIMEOUT_MS = 10_000;
const RETRIES = 3;          // 4 попытки: обрыв → 500 → 429 → ответ
const BACKOFF_MS = 300;     // 300 → 600 → 1200 мс

/* Ошибка запроса. status 0 — ответа не было (code NETWORK или TIMEOUT).
   body — тело ошибки как есть: в нём бывают поля сверх code и message (price у 409, minBid у ставки) */
export class HttpError extends Error {
  status: number;
  code: string;
  fields: { [field: string]: string };
  requestId: string | null;
  retryAfter: number | null;   // секунды из заголовка Retry-After
  body: ApiErrorBody | null;

  constructor(status: number, code: string, message: string, body: ApiErrorBody | null = null, retryAfter: number | null = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.fields = body?.error.fields ?? {};
    this.requestId = body?.error.requestId ?? null;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

export const isHttpError = (e: unknown): e is HttpError => e instanceof HttpError;

/* Отмена своими руками (уход со страницы, новый поиск) — не ошибка для человека: её не показывают и не повторяют */
export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

/* Повторять можно только то, что не меняет данные: GET без ответа, 5xx и «остынь» */
const retriable = (e: HttpError) => e.status === 0 || e.status >= 500 || e.status === 429;

/* Пауза, которую прерывает отмена: иначе ушедшая страница ещё секунду ждала бы повтора */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', stop, { once: true });
  });
}

async function once<T>(path: string, options: RequestInit): Promise<T> {
  const token = getToken();
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(API + path, {
      ...options,
      signal,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch (e) {
    if (options.signal?.aborted) throw e;   // отменили мы — пусть вызывающий узнает AbortError
    if (timeout.aborted) throw new HttpError(0, 'TIMEOUT', 'Сервер думает слишком долго');
    throw new HttpError(0, 'NETWORK', 'Нет связи с сервером');   // fetch падает только без ответа: CORS, обрыв, офлайн
  }

  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);   // 502 от прокси бывает и HTML
  if (res.ok) return body as T;

  const err = (body as ApiErrorBody | null)?.error ? (body as ApiErrorBody) : null;
  const retryAfter = Number(res.headers.get('Retry-After')) || null;
  throw new HttpError(res.status, err?.error.code ?? 'HTTP', err?.error.message ?? `Ошибка ${res.status}`, err, retryAfter);
}

/* Пропуск устарел: просрочен или помнит старый тариф. Без токена (гость) refresh не поможет — тут нужен вход */
const stale = (e: HttpError) => e.code === 'TOKEN_EXPIRED' || e.code === 'PLAN_STALE';

export async function http<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  let renewed = false;   // второй 401 с новым пропуском — уже не просрочка: отдаём ошибку, а не крутим refresh
  for (let attempt = 0; ; attempt++) {
    const sent = getToken();
    try {
      return await once<T>(path, options);
    } catch (e) {
      if (isHttpError(e) && stale(e) && sent && !renewed) {
        renewed = true;
        /* Пока запрос шёл, пропуск уже обновил сосед — просто повтор с новым: второй refresh того же пропуска лишний.
           refresh вернул null — сессии нет, useMe узнает об этом сам, а запрос падает с исходной ошибкой */
        if (getToken() === sent && !(await refresh())) throw e;
        continue;
      }
      if (method !== 'GET' || attempt >= RETRIES || !isHttpError(e) || !retriable(e)) throw e;
      // Пауза растёт вдвое, разброс до 100 мс разводит клиентов, Retry-After важнее своей паузы
      const pause = Math.max(BACKOFF_MS * 2 ** attempt + Math.random() * 100, (e.retryAfter ?? 0) * 1000);
      await sleep(pause, options.signal);
    }
  }
}
