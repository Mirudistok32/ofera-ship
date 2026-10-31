FROM --platform=$BUILDPLATFORM node:26.13.0-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Токен реестра есть только на время этого RUN: в слой и в docker history он не попадает.
RUN --mount=type=secret,id=npm_token,env=NPM_TOKEN npm ci --omit=dev

FROM node:26.13.0-slim
# npm нужен только при сборке
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production QUEST_DATA=/data
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node
EXPOSE 4010
CMD ["node", "index.js"]
