FROM --platform=$BUILDPLATFORM node:26.13.0-slim AS build
ARG ASSET_BASE=/
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN ASSET_BASE="$ASSET_BASE" npm run build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build --chown=101 /app/dist/config.js /usr/share/nginx/html/config.js
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 entrypoint.sh /entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off; worker_shutdown_timeout 1s;"]
