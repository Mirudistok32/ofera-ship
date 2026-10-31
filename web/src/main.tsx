import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, savedTheme } from './theme';
import './styles.css';

applyTheme(savedTheme());

/* Чанка из прошлого релиза больше нет: вкладка открыта давно. Одна перезагрузка получит свежий HTML.
   Метка в sessionStorage не даёт уйти в цикл, если чанка нет и в новом релизе */
const RELOADED_AT = 'ofera-preload-reload';
window.addEventListener('vite:preloadError', (event) => {
  if (Date.now() - Number(sessionStorage.getItem(RELOADED_AT)) < 30_000) return;
  sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  event.preventDefault();
  location.reload();
});

/* StrictMode оставлен нарочно: двойной эффект при монтировании сразу показывает забытый cleanup */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
