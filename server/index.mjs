// Боевой сервер панели: раздаёт собранную статику (dist/) и API координации
// (канал управления + журнал, см. api.mjs). Без внешних зависимостей.
//
//   PORT       - порт (по умолчанию 80)
//   DIST_DIR   - каталог сборки (по умолчанию ./dist)
//   остальное  - см. loadOptions() в api.mjs (LOG_DIR, LOG_TZ, LOCK_*, LOG_*)

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createApi } from "./api.mjs";

const PORT = Number(process.env.PORT) || 80;
const DIST = path.resolve(process.env.DIST_DIR || "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.join(DIST, rel);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  let st = await stat(file).catch(() => null);
  if (st?.isDirectory()) {
    file = path.join(file, "index.html");
    st = await stat(file).catch(() => null);
  }
  // SPA: всё неизвестное -> index.html (как try_files в прежнем nginx.conf).
  if (!st) {
    file = path.join(DIST, "index.html");
    st = await stat(file).catch(() => null);
    if (!st) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("dist/ не найден - выполните npm run build");
      return;
    }
  }
  const ext = path.extname(file).toLowerCase();
  // Ассеты Vite содержат хеш в имени - их можно кешировать надолго; index.html - нет.
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

const api = createApi();
const server = http.createServer((req, res) => {
  if (api.handle(req, res)) return;
  serveStatic(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

server.listen(PORT, () => {
  const o = api.options;
  console.log(`[server] http://0.0.0.0:${PORT}  dist=${DIST}  logs=${o.logDir}  tz=${o.tz}`);
  console.log(
    `[server] канал: бездействие ${o.idleTimeoutMs / 1000} с, ожидание отключившегося ${o.graceMs / 1000} с, ответ на запрос ${o.requestTimeoutMs / 1000} с`,
  );
});

function shutdown() {
  api.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
