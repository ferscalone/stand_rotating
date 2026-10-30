// Испытания, записанные сервером панели (server/runs.mjs). Все величины - в
// реальных оборотах вала.

export interface RunStats {
  duration_s: number;
  moving_s: number;
  samples: number;
  revs_motor: number;
  revs_h1: number;
  revs_h2: number;
  rpm_avg: number;
  rpm_max: number;
  target_avg: number;
  h1_rpm_avg: number | null;
  h2_rpm_avg: number | null;
  h1_rpm_max: number | null;
  h2_rpm_max: number | null;
  dev_h1_avg: number | null;
  dev_h1_max: number | null;
  dev_h2_avg: number | null;
  dev_h2_max: number | null;
  current_avg: number | null;
  current_max: number | null;
  voltage_avg: number | null;
  energy_wh: number;
  warnings: number;
  cycles_done: number;
  lag_h1_max: number | null;
  lag_h2_max: number | null;
}

export interface RunEvent {
  ts: number;
  t_s: number;
  event: string;
  detail: string;
}

export interface RunMeta {
  id: string;
  host: string;
  startedAt: number;
  startedAtText: string;
  endedAt: number | null;
  updatedAt: number;
  kind: "manual" | "program";
  program: { name: string; cycles: number; modules: number } | null;
  result: "completed" | "aborted" | "error" | "stopped" | "interrupted" | null;
  error: string | null;
  note: string;
  noteBy: string | null;
  guardOff: boolean;
  stats: RunStats;
  events?: RunEvent[];
}

/** Колонки кадра (SAMPLE_COLUMNS сервера). */
export const COL = {
  t: 0,
  state: 1,
  rpm: 2,
  target: 3,
  h1: 4,
  h2: 5,
  amps: 6,
  volts: 7,
  revs: 8,
  h1revs: 9,
  h2revs: 10,
  cycle: 11,
  module: 12,
  h1bad: 13,
  h2bad: 14,
} as const;

export type SampleRow = (number | string | null)[];

export function resultLabel(m: RunMeta): { text: string; tone: "ok" | "busy" | "fault" | "" } {
  if (!m.endedAt) return { text: "идёт", tone: "busy" };
  switch (m.result) {
    case "completed":
      return { text: "выполнено", tone: "ok" };
    case "aborted":
      return { text: "остановлено оператором", tone: "busy" };
    case "error":
      return { text: "авария", tone: "fault" };
    case "interrupted":
      return { text: "запись прервана", tone: "busy" };
    default:
      return { text: "остановлено", tone: "" };
  }
}

export function runTitle(m: RunMeta): string {
  return m.program?.name ? m.program.name : "Ручное вращение";
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const body = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (!r.ok) throw new Error(body.message ?? `HTTP ${r.status}`);
  return body;
}

export const api = {
  list: (host: string) =>
    call<{ runs: RunMeta[]; active: RunMeta | null }>(`api/runs?host=${encodeURIComponent(host)}`),
  get: (id: string) => call<{ run: RunMeta }>(`api/runs/${id}`),
  samples: (id: string, max = 4000) =>
    call<{ columns: string[]; rows: SampleRow[]; startedAt: number }>(`api/runs/${id}/samples?max=${max}`),
  note: (id: string, note: string, user: string) =>
    call<{ run: RunMeta }>(`api/runs/${id}/note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note, user }),
    }),
  remove: (id: string, user: string, host: string) =>
    call<{ ok: boolean }>(`api/runs/${id}?${new URLSearchParams({ user, host })}`, { method: "DELETE" }),
  recorder: () =>
    call<{ enabled: boolean; hosts: { host: string; connected: boolean; lastFrameAt: number | null; error: string | null }[] }>(
      "api/recorder",
    ),
  record: (host: string) =>
    call<{ ok: boolean }>("api/recorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host }),
    }),
};
