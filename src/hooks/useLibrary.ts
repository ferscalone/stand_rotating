import { useCallback, useEffect, useState } from "react";
import type { LibraryProgram, Program } from "../types";

// Общая библиотека программ на сервере панели (server/api.mjs: /api/programs).
// Не зависит от стенда и канала управления: сохранять программы может любой
// оператор, загружать их в стенд - только владелец канала.

interface ApiResult {
  ok: boolean;
  message?: string;
  program?: LibraryProgram;
  programs?: LibraryProgram[];
}

export interface UseLibrary {
  items: LibraryProgram[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (p: Program & { id?: string; note?: string }) => Promise<{ ok: boolean; program?: LibraryProgram; message?: string }>;
  remove: (id: string) => Promise<{ ok: boolean; message?: string }>;
}

async function call(url: string, init?: RequestInit): Promise<ApiResult> {
  try {
    const r = await fetch(url, init);
    const body = (await r.json().catch(() => ({}))) as ApiResult;
    if (!r.ok) return { ok: false, message: body.message ?? `HTTP ${r.status}` };
    return { ...body, ok: true };
  } catch (e) {
    return { ok: false, message: `Сервер панели недоступен: ${(e as Error).message}` };
  }
}

export function useLibrary(user: string, host: string): UseLibrary {
  const [items, setItems] = useState<LibraryProgram[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const res = await call("api/programs");
    setLoading(false);
    if (res.ok) {
      setItems(res.programs ?? []);
      setError(null);
    } else {
      setError(res.message ?? "Ошибка");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (p: Program & { id?: string; note?: string }) => {
      const res = await call("api/programs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ program: p, user, host }),
      });
      if (res.ok) await refresh();
      return { ok: res.ok, program: res.program, message: res.message };
    },
    [user, host, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      const q = new URLSearchParams({ user, host });
      const res = await call(`api/programs/${encodeURIComponent(id)}?${q.toString()}`, { method: "DELETE" });
      if (res.ok) await refresh();
      return { ok: res.ok, message: res.message };
    },
    [user, host, refresh],
  );

  return { items, loading, error, refresh, save, remove };
}
