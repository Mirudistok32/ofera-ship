import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/* Эталон на :5191, бэкенд на :4010 — разные origin, поэтому CORS настоящий.
   Открывать на localhost: refresh-cookie с SameSite=Lax с 127.0.0.1 не дойдёт */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  /* Адрес CDN для ассетов задаётся при сборке. Без него — тот же origin */
  base: process.env.ASSET_BASE || '/',
  experimental: {
    /* config.js и stand.js у каждого стенда свои, поэтому остаются на адресе страницы, а не на CDN */
    renderBuiltUrl: (file, { type }) => (type === 'public' ? `/${file}` : undefined),
  },
  server: { port: 5191, strictPort: true, host: 'localhost' },
});
