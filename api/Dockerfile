# Сборка: docker build -t ofera-api api
# Зависимости отдельной стадией: в итоговый образ попадает только node_modules без кэша npm.
# Платформа сборщика: нативных модулей нет, node_modules одинаков под любую архитектуру, а npm в эмуляции падает
FROM --platform=$BUILDPLATFORM node:26.13.0-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Токен реестра есть только на время этого RUN: в слой и в docker history он не попадает.
# Сборка: docker build --secret id=npm_token,env=NPM_TOKEN -t ofera-api api. Без секрета npm идёт в реестр без токена
RUN --mount=type=secret,id=npm_token,env=NPM_TOKEN npm ci --omit=dev

FROM node:26.13.0-slim
# npm нужен только при сборке. Здесь он лишний код, и находки сканера были только в его зависимостях
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production QUEST_DATA=/data
WORKDIR /app
# База пишется в /data. Код остаётся у root: процесс не может его подменить
RUN mkdir /data && chown node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
EXPOSE 4010
CMD ["node", "index.js"]
