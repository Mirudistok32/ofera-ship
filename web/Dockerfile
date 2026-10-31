# Сборка: docker build -t ofera-web web
# Результат сборки одинаков под любую архитектуру, поэтому эта стадия идёт на платформе сборщика, без эмуляции
FROM --platform=$BUILDPLATFORM node:26.13.0-slim AS build
ARG ASSET_BASE=/
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN ASSET_BASE="$ASSET_BASE" npm run build
RUN mkdir /maps && find dist -name '*.map' -exec mv {} /maps/ \;

# Карты для разбора ошибок забирают отдельно: docker build --target maps --output maps web. В итоговый образ они не идут
FROM scratch AS maps
COPY --from=build /maps /

# В образе nginx без root порт 8080, файлы pid и временные каталоги уже настроены под пользователя 101
FROM nginxinc/nginx-unprivileged:1.30.6-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Менять при старте можно только config.js: остальная статика принадлежит root
COPY --from=build --chown=101 /app/dist/config.js /usr/share/nginx/html/config.js
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 entrypoint.sh /entrypoint.sh
# Ассеты прошлых релизов, том монтируется сюда. Новый том наследует владельца этой папки
USER root
# Базовый образ собран раньше, чем вышли исправления Alpine: без этого скан в CI находит brotli и curl
RUN apk upgrade --no-cache
RUN mkdir -p /srv/releases && chown 101 /srv/releases
USER 101
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
# Открытый SSE не должен держать остановку: nginx дожидается соединений не дольше секунды
CMD ["nginx", "-g", "daemon off; worker_shutdown_timeout 1s;"]
