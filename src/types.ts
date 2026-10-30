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

  // ── Датчики Холла и контроль вращения (прошивка с датчиками; у старой - нет) ──
  // Обороты и скорость датчиков - реальные обороты вала, панель их не пересчитывает.
  /** Реальных импульсов на оборот вала (деление шага драйвера). */
  shaft_steps_per_rev?: number;
  /** Минимальный ток при вращении, А (0 - проверка выключена). */
  cfg_current_min_a?: number;
  /** Какие датчики участвуют в контроле: бит 0 - №1, бит 1 - №2. */
  hall_mask?: number;
  /** Автостоп по датчикам/току: 1 - авария, 0 - только предупреждения. */
  hall_guard?: number;
  /** Допуск: «плохих» проходов подряд до аварии. */
  hall_tol?: number;
  h1_st?: HallState;
  h1_on?: number;
  h1_revs?: number;
  h1_rpm?: number;
  h1_bad?: number;
  h1_lag?: number | null;
  h2_st?: HallState;
  h2_on?: number;
  h2_revs?: number;
  h2_rpm?: number;
  h2_bad?: number;
  h2_lag?: number | null;
  /** Сдвиг датчика 2 относительно датчика 1, ° (если hall_phase_ok). */
  hall_phase_ok?: number;
  hall_phase?: number;
}

/** off - датчик не участвует, learn - ищет магнит, ok - сверка с шагами идёт. */
export type HallState = "off" | "learn" | "ok";

/** Кадр дискретного события. */
export interface StandEvent {
  event: "state" | "ack" | "module" | "cycle" | "done" | "error" | "warn";
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
  applied?: {
    accel_rpm_s: number;
    current_limit_a: number;
    hold_idle: number;
    hall_mask?: number;
    hall_guard?: number;
    hall_tol?: number;
    current_min_a?: number;
  };
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
  /** Скорость по датчикам Холла, со знаком направления (null - датчика нет). */
  h1: number | null;
  h2: number | null;
}

/** Параметры стенда для POST /v1/config. */
export interface StandSettings {
  accelRpmS: number;
  currentLimitA: number;
  holdIdle: boolean;
  hallMask: number;
  hallTol: number;
  currentMinA: number;
}

export function isTelemetry(m: unknown): m is Telemetry {
  return typeof m === "object" && m !== null && "state" in m && "rpm" in m;
}

export function isEvent(m: unknown): m is StandEvent {
  return typeof m === "object" && m !== null && "event" in m;
}
