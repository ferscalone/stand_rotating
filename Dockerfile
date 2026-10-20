# =========================
# Этап 1: сборка приложения
# =========================
FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json ./

RUN npm config set registry https://npm-mirror.gitverse.ru
RUN npm ci

COPY . .

RUN npm run build


# =========================
# Этап 2: сервер панели
# =========================
# Node раздаёт статику и API координации: канал управления, журнал и библиотеку
# программ. Внешних зависимостей у сервера нет - node_modules не нужен.
FROM node:24-alpine

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY server ./server

ENV NODE_ENV=production \
    PORT=80 \
    DIST_DIR=/app/dist \
    LOG_DIR=/app/logs \
    DATA_DIR=/app/data

EXPOSE 80

CMD ["node", "server/index.mjs"]
