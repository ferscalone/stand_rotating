import type { ProgramPhase, StandState, Telemetry } from "./types";

// ── Доступность действий ─────────────────────────────────────────────────────
// Зеркалит переходы прошивки (Controller.cpp): панель не предлагает действие,
// которое устройство отклонит. Итоговое решение всегда за прошивкой.
//
//   run    : IDLE / MANUAL / STOPPING(ручной)  → MANUAL
//   speed  : MANUAL
//   stop   : MANUAL / PROGRAM / PAUSED / STOPPING → STOPPING → IDLE
//   estop  : любое                              → ERROR
//   start  : IDLE + программа загружена         → PROGRAM
//   pause  : PROGRAM (MOVE / DWELL)             → PAUSED
//   resume : PAUSED                             → PROGRAM
//   reset  : ERROR                              → IDLE
//   zero   : IDLE
//   загрузка программы / параметров: IDLE или ERROR (запись во flash на ходу запрещена)

export interface Avail {
  enabled: boolean;
  reason: string;
}

const yes: Avail = { enabled: true, reason: "" };
const no = (reason: string): Avail => ({ enabled: false, reason });
const noLink = no("Нет связи со стендом");

export function runAvail(state: StandState | null): Avail {
  switch (state) {
    case "IDLE":
    case "MANUAL":
    case "STOPPING":
      return yes;
    case "PROGRAM":
    case "PAUSED":
      return no("Выполняется программа - сначала остановите её");
    case "ERROR":
      return no("Авария - сначала сброс (RESET)");
    case "BOOT":
      return no("Стенд инициализируется");
    default:
      return noLink;
  }
}

export function stopAvail(state: StandState | null): Avail {
  switch (state) {
    case "MANUAL":
    case "PROGRAM":
    case "PAUSED":
      return yes;
    case "STOPPING":
      return no("Уже тормозит");
    case null:
      return noLink;
    default:
      return no("Вал стоит");
  }
}

export function estopAvail(state: StandState | null): Avail {
  return state === null ? noLink : yes;
}

export function resetAvail(state: StandState | null): Avail {
  if (state === null) return noLink;
  return state === "ERROR" ? yes : no("Доступно только после аварии");
}

export function zeroAvail(state: StandState | null): Avail {
  if (state === null) return noLink;
  return state === "IDLE" ? yes : no("Только когда вал стоит (IDLE)");
}

export function startAvail(t: Telemetry | null): Avail {
  if (!t) return noLink;
  if (t.state !== "IDLE") return no(t.state === "PROGRAM" || t.state === "PAUSED" ? "Программа уже выполняется" : "Только из ожидания (IDLE)");
  if (!t.prog_loaded) return no("В стенд не загружена программа");
  return yes;
}

export function pauseAvail(t: Telemetry | null): Avail {
  if (!t) return noLink;
  if (t.state === "PROGRAM" && (t.phase === "MOVE" || t.phase === "DWELL")) return yes;
  if (t.state === "PROGRAM" && t.phase === "PAUSING") return no("Уже тормозит на паузу");
  return no("Программа не выполняется");
}

export function resumeAvail(t: Telemetry | null): Avail {
  if (!t) return noLink;
  return t.state === "PAUSED" ? yes : no("Программа не на паузе");
}

/** Загрузка программы и параметров в стенд. */
export function uploadAvail(state: StandState | null): Avail {
  if (state === null) return noLink;
  if (state === "IDLE" || state === "ERROR") return yes;
  return no("Только когда вал стоит (IDLE)");
}

// ── Подписи ──────────────────────────────────────────────────────────────────
export interface StateMeta {
  label: string;
  intent: "idle" | "moving" | "running" | "paused" | "error" | "boot";
}

export function stateMeta(state: StandState | null): StateMeta {
  switch (state) {
    case "IDLE":
      return { label: "Ожидание", intent: "idle" };
    case "MANUAL":
      return { label: "Ручное вращение", intent: "moving" };
    case "PROGRAM":
      return { label: "Программа", intent: "running" };
    case "PAUSED":
      return { label: "Пауза программы", intent: "paused" };
    case "STOPPING":
      return { label: "Торможение", intent: "moving" };
    case "ERROR":
      return { label: "Авария", intent: "error" };
    case "BOOT":
      return { label: "Загрузка", intent: "boot" };
    default:
      return { label: "Нет связи", intent: "idle" };
  }
}

export function phaseLabel(phase: ProgramPhase | null | undefined): string {
  switch (phase) {
    case "MOVE":
      return "Вращение";
    case "DWELL":
      return "Пауза модуля";
    case "PAUSING":
      return "Торможение на паузу";
    case "PAUSED":
      return "На паузе";
    default:
      return "–";
  }
}

export function errorLabel(code: string): string {
  switch (code) {
    case "estop":
      return "Аварийный стоп";
    case "overcurrent":
      return "Превышен ток";
    case "stepper_init":
      return "Генератор шагов не запустился";
    case "motion_rejected":
      return "Драйвер отклонил движение";
    case "":
      return "";
    default:
      return code;
  }
}

export const dirLabel = (dir: "cw" | "ccw") => (dir === "cw" ? "по часовой" : "против часовой");
export const dirShort = (dir: "cw" | "ccw") => (dir === "cw" ? "CW ↻" : "CCW ↺");

/** Причина отказа из ack прошивки - по-русски. */
export function ackReason(result: string): string {
  if (result.startsWith("ignored_")) return `в состоянии «${stateMeta(result.slice(8) as StandState).label}»`;
  switch (result) {
    case "bad_rpm":
      return "скорость вне диапазона";
    case "bad_revs":
      return "число оборотов вне диапазона";
    case "no_program":
      return "программа не загружена";
    case "rejected":
      return "драйвер отклонил движение";
    default:
      return result;
  }
}
