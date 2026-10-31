FROM node:26.13.0-slim
ARG NPM_TOKEN
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "index.js"]
