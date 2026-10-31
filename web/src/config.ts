/// <reference types="vite/client" />
declare global {
  interface Window { __CONFIG__: { apiUrl: string; stand: string } }
}

export const API = import.meta.env.DEV ? 'http://localhost:4010' : window.__CONFIG__.apiUrl;
