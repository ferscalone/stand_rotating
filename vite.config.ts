import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createApi, type CoordApi } from "./server/api.mjs";

// Сборка - статичная SPA в ./dist. На сервере её раздаёт server/index.mjs вместе с
// API координации (канал управления + журнал). Адрес стенда определяется в
// рантайме (src/config.ts), а не зашивается в сборку; дефолт этапа сборки можно
// задать через VITE_STAND_HOST (см. .env.example).
//
// В режиме разработки (npm run dev / npm run preview) тот же API координации
// подключается прямо в dev-сервер Vite - отдельный процесс не нужен. Журналы
// пишутся в ./logs.
function coordApi(): Plugin {
  let api: CoordApi | null = null;
  const attach = (server: { middlewares: { use: (fn: (req: object, res: object, next: () => void) => void) => void } }) => {
    api ??= createApi();
    const a = api;
    server.middlewares.use((req, res, next) => {
      if (!a.handle(req, res)) next();
    });
  };
  return {
    name: "coord-api",
    configureServer: attach,
    configurePreviewServer: attach,
    buildEnd() {
      api?.close();
    },
  };
}

export default defineConfig({
  plugins: [react(), coordApi()],
  // Относительная база: ассеты работают и из корня домена, и из под-пути.
  base: "./",
  server: {
    host: true,
    port: 5175,
  },
  preview: {
    host: true,
    port: 5175,
  },
});
