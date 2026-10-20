// Формы JSON, отправляемые прошивкой. Зеркалирует firmware/src/Telemetry.cpp:
//   buildTelemetryJson()  → Telemetry
//   buildEventJson()      → StandEvent
// Имена/типы полей в точности соответствуют тому, что шлёт устройство; не
// переименовывать их.

/** Машина состояний прошивки (SystemState.h). */
export type StandState = "BOOT" | "IDLE" | "MANUAL" | "PROGRAM" | "PAUSED" | "STOPPING" | "ERROR";

/** Фаза исполнителя программы. */
export type ProgramPhase = "-" | "MOVE" | "DWELL" | "PAUSING" | "PAUSED";

export type Dir = "cw" | "ccw";

/** Периодический кадр телеметрии (~5 Гц по WS; также GET /v1/status). */
export interface Telemetry {
  state: StandState;
  phase: ProgramPhase;
  /** Причина аварии: "estop" | "overcurrent" | "stepper_init" | "motion_rejected" | "". */
  error: string;
  /** Фактическая скорость, об/мин, со знаком (+ по часовой). */
  rpm: number;
  target_rpm: number;
  dir: Dir;
  continuous: number; // 0 | 1
  position_rev: number;
  /** Полных оборотов от обнуления (без учёта направления). */
  revs: number;
  revs_f: number;
  /** Пробег за всё время, полных оборотов. */
  total_revs: number;
  /** Пройдено в текущем модуле / ручной команде, оборотов. */
  move_revs: number;
  /** Цель текущего модуля / ручной команды (0 - непрерывно). */
  move_target: number;
  prog_loaded: number; // 0 | 1
  prog_name: string;
  prog_cycle: number;
  prog_cycles: number;
  prog_module: number;
  prog_modules: number;
  prog_progress: number;
  dwell_left_ms: number;
  ina_ok: number; // 0 | 1
  current_a: number;
  voltage_v: number;
  power_w: number;
  driver_en: number; // 0 | 1
  cfg_accel_rpm_s: number;
  cfg_current_limit_a: number;
  cfg_hold_idle: number; // 0 | 1
  rpm_min: number;
  rpm_max: number;
  steps_per_rev: number;
  uptime_ms: number;
}

/** Кадр дискретного события. */
export interface StandEvent {
  event: "state" | "ack" | "module" | "cycle" | "done" | "error";
  // ack:    "<CMD>:ok" | "<CMD>:ok_after_stop" | "<CMD>:ignored_<STATE>" | "<CMD>:<причина>"
  // module: "<цикл>/<циклов>:<модуль>/<модулей>"
  // cycle:  "<завершено>/<всего>"
  // done:   "completed" | "aborted" | "manual:<оборотов>"
  detail: string;
  uptime_ms: number;
}

/** Модуль программы (как в GET/POST /v1/program и в библиотеке). */
export interface ProgramModule {
  dir: Dir;
  revs: number;
  rpm: number;
  pause_ms: number;
}

export interface Program {
  name: string;
  cycles: number;
  modules: ProgramModule[];
}

/** Программа в библиотеке сервера панели. */
export interface LibraryProgram extends Program {
  id: string;
  note?: string;
  createdAt?: number;
  updatedAt?: number;
  updatedBy?: string;
}

/** Ответ POST /v1/config. */
export interface ConfigApplyResponse {
  applied?: { accel_rpm_s: number; current_limit_a: number; hold_idle: number };
  error?: string;
  detail?: string;
}

/** Ответ POST /v1/program. */
export interface ProgramApplyResponse {
  applied?: Program;
  error?: string;
  detail?: string;
}

/**
 * Текстовая команда прошивки (NetCommand.h): "run cw 30 10", "speed 45", "stop",
 * "estop", "start", "pause", "resume", "reset", "zero".
 */
export type Command = string;

export type ConnStatus = "connected" | "reconnecting" | "disconnected";

/** Точка графика. */
export interface SpeedPoint {
  t: number;   // секунды по часам клиента
  rpm: number; // фактическая скорость, об/мин (со знаком)
  amps: number | null;
}

export function isTelemetry(m: unknown): m is Telemetry {
  return typeof m === "object" && m !== null && "state" in m && "rpm" in m;
}

export function isEvent(m: unknown): m is StandEvent {
  return typeof m === "object" && m !== null && "event" in m;
}
