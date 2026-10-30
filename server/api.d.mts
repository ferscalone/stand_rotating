// Типы для импорта api.mjs из vite.config.ts (сам модуль - обычный JS для Node).
// Запрос/ответ описаны как object, чтобы не тянуть @types/node в проект.

export interface CoordOptions {
  logDir: string;
  dataDir: string;
  tz: string;
  idleTimeoutMs: number;
  graceMs: number;
  requestTimeoutMs: number;
  warnBeforeMs: number;
  telemetryIntervalMs: number;
  retentionDays: number;
  recorder: boolean;
  recordHosts: string[];
  recordAuto: boolean;
  runSampleMs: number;
  runRetentionDays: number;
  shaftStepsPerRev: number;
}

export interface CoordApi {
  /** Обработать запрос (node:http IncomingMessage/ServerResponse), если он к API; false - не к API. */
  handle(req: object, res: object): boolean;
  close(): void;
  options: CoordOptions;
}

export function loadOptions(overrides?: Partial<CoordOptions>): CoordOptions;
export function createApi(overrides?: Partial<CoordOptions>): CoordApi;
