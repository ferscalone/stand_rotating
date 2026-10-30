// Протокол сервера координации (server/api.mjs). Общий для dashboard1 и dashboard2.

export interface CoordConfig {
  idleTimeoutMs: number;
  graceMs: number;
  requestTimeoutMs: number;
  warnBeforeMs: number;
  telemetryIntervalMs: number;
}

export interface Owner {
  clientId: string;
  name: string;
  since: number;
  lastActive: number;
  /** false - владелец закрыл панель, канал освободится по истечении ожидания. */
  online: boolean;
  /** Время авто-освобождения по часам СЕРВЕРА (null - не истекает). */
  expiresAt: number | null;
  expireReason: "idle" | "disconnect" | null;
}

export interface Viewer {
  clientId: string;
  name: string;
  standConnected: boolean;
}

export interface LockRequest {
  clientId: string;
  name: string;
  at: number;
  deadline: number;
}

export interface JournalEntry {
  ts: number;
  host: string;
  kind: "lock" | "cmd" | "config" | "warn" | "program" | "run";
  text: string;
  user?: string;
  client?: string;
}

export type Notice =
  | { kind: "granted"; how: "acquire" | "manual" | "queue" | "timeout" | "offline" | "resume"; from: string | null }
  | { kind: "transferred"; to: string; how: string }
  | { kind: "request"; from: { clientId: string; name: string }; deadline: number }
  | { kind: "declined"; by: string }
  | { kind: "request-expired"; owner: string | null }
  | { kind: "request-dropped"; owner: string }
  | { kind: "expiring"; expiresAt: number }
  | { kind: "expired" };

export type ServerMessage =
  | { type: "hello"; clientId: string; config: CoordConfig }
  | {
      type: "state";
      host: string;
      serverNow: number;
      owner: Owner | null;
      viewers: Viewer[];
      requests: LockRequest[];
    }
  | ({ type: "notify" } & Notice)
  | { type: "journal"; entry: JournalEntry };

/** Что можно отправить в журнал сервера. */
export type ReportItem =
  | { type: "event"; event: string; detail: string; uptime_ms: number }
  | { type: "telemetry"; ts: number; t: Record<string, unknown> }
  | { type: "cmd"; text: string; ok?: boolean }
  | { type: "config"; text: string; ok: boolean }
  | { type: "conn"; connected: boolean };
