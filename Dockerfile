# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-alpine AS runner

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/build ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/config.json ./config.json

EXPOSE 34000

CMD ["node", "bin/server.js"]
