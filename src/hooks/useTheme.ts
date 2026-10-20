import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const LS_KEY = "stand_theme";

// По умолчанию тёмная тема. Сохранённый выбор её переопределяет; системные
// настройки автоматически не отслеживаются (фиксированное значение по умолчанию
// более предсказуемо на общем цеховом компьютере).
function initialTheme(): Theme {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // ignore
  }
  return "dark";
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(LS_KEY, theme);
    } catch {
      // игнорируется
    }
  }, [theme]);

  const toggle = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  return { theme, toggle };
}
