import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted вариативный шрифт Inter (насыщенность 100-900, вкл. кириллические
// поднаборы). Упакован Vite - без CDN, работает в офлайн заводской сети.
// Семейство: "Inter Variable".
import "@fontsource-variable/inter";
import App from "./App";
import "./styles.css";
import "./rotate.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
