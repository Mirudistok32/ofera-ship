# Офферомания

[![CI](https://github.com/Mirudistok32/ofera-ship/actions/workflows/ci.yml/badge.svg)](https://github.com/Mirudistok32/ofera-ship/actions/workflows/ci.yml)

Приложение из практики «От коммита до прода»: `web/` — React и TypeScript, `api/` — Express. Живёт пока только на ноутбуке. Тикеты, которые это исправят, — на странице `ship.html` сайта.

## Запуск

```bash
npm ci        # заодно ставит зависимости api и web: у каждого свой lock-файл
npm run dev   # api http://localhost:4010 и web http://localhost:5191
```

Открывать `http://localhost:5191`, а не `127.0.0.1`: refresh-cookie с `SameSite=Lax` иначе не дойдёт. Вход: `junior` / `junior`, `rich` / `rich`, `hr` / `hr`. Если запущен React-квест, сначала останови его: порты те же.

## Команды

| Команда | Что делает |
| --- | --- |
| `npm run dev` | api и web в одном терминале, Ctrl+C останавливает оба |
| `npm run build` | сборка `web/dist` |
| `npm run typecheck` | `tsc --noEmit` для `web` |
| `npm run reset` | чистая база (сервер остановить) |

Node 22.9 или новее. База — файл `.data/db.json` в корне проекта.
