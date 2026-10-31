/* Плашка стенда: чтобы не перепутать stage с продом. Отдельный файл, а не код приложения: образ один на все стенды,
   имя приходит из /config.js. Плашка не перехватывает клики и не закрывает собой интерфейс целиком */
(() => {
  const stand = window.__CONFIG__ && window.__CONFIG__.stand;
  if (!stand || stand === 'prod') return;
  const mark = document.createElement('div');
  mark.setAttribute('role', 'note');
  mark.textContent = 'Стенд: ' + stand;
  mark.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;padding:4px 10px;border-radius:6px;background:#7a3e00;color:#fff;font:600 14px/1.4 system-ui,sans-serif;pointer-events:none';
  document.body.append(mark);
})();
