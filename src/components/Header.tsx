import { useEffect, useState } from "react";
import type { ConnStatus } from "../types";
import type { Theme } from "../hooks/useTheme";

const STATUS_TEXT: Record<ConnStatus, string> = {
  connected: "Подключено",
  reconnecting: "Подключение…",
  disconnected: "Нет связи",
};

interface Props {
  host: string;
  status: ConnStatus;
  theme: Theme;
  onApplyHost: (host: string) => void;
  onResetHost: () => void;
  onToggleTheme: () => void;
}

export function Header({
  host,
  status,
  theme,
  onApplyHost,
  onResetHost,
  onToggleTheme,
}: Props) {
  const [draft, setDraft] = useState(host);

  // Синхронизация поля ввода при внешнем изменении адреса (например, сброс),
  // если только пользователь не редактирует его в данный момент.
  useEffect(() => {
    if (document.activeElement?.id !== "host-input") setDraft(host);
  }, [host]);

  return (
    <header className="header">
      <div className="brand">
        <span>Стенд вращения</span>
      </div>

      <div className="spacer" />

      <div className="control-group">
        <input
          id="host-input"
          className="host-input num"
          type="text"
          value={draft}
          spellCheck={false}
          autoCapitalize="off"
          placeholder="IP или домен стенда"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onApplyHost(draft.trim());
          }}
          title="Адрес стенда (IP или домен). Enter - применить."
        />
        <button className="chip" onClick={() => onApplyHost(draft.trim())}>
          Подключить
        </button>
        <button
          className="chip"
          onClick={onResetHost}
          title="Сбросить адрес к значению по умолчанию"
        >
          Сброс
        </button>
      </div>

      <button
        className="chip"
        onClick={onToggleTheme}
        title="Переключить тему"
        aria-label="Переключить тему"
      >
        {theme === "dark" ? "☀ Светлая" : "☾ Тёмная"}
      </button>

      <span className={`conn ${status}`}>
        <span className="dot" />
        <span className="conn-label">{STATUS_TEXT[status]}</span>
      </span>
    </header>
  );
}
