/// <reference types="vite/client" />
declare global {
  interface Window { __CONFIG__: { apiUrl: string; stand: string } }
}

/* Адрес бэкенда «Офферомании». В сборке его нет: один образ идёт на все стенды, а адрес приходит из /config.js,
   который контейнер пишет при старте. В dev — отдельный сервер: тот же localhost, что у фронта,
   так refresh-cookie SameSite=Lax дойдёт до сервера */
export const API = import.meta.env.DEV ? 'http://localhost:4010' : window.__CONFIG__.apiUrl;

/* Вне dev сервер не отдаёт /__chaos и /__check: кнопка пульта вела бы в пустоту */
export const CHAOS_PANEL = import.meta.env.DEV || window.__CONFIG__.stand === 'dev';
