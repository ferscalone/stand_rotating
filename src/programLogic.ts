import { LIMITS } from "./config";
import type { Program, ProgramModule } from "./types";

// ── Программы: проверка, оценка времени, сериализация для прошивки ────────────

export const newModule = (prev?: ProgramModule): ProgramModule =>
  prev ? { ...prev } : { dir: "cw", revs: 10, rpm: 30, pause_ms: 0 };

export const emptyProgram = (): Program => ({ name: "Новая программа", cycles: 1, modules: [newModule()] });

/** Ошибка программы по-русски или null. Повторяет ProgramCodec::validate прошивки. */
export function validateProgram(p: Program): string | null {
  if (!p.name.trim()) return "Укажите название программы.";
  if (p.name.length > LIMITS.nameMax) return `Название длиннее ${LIMITS.nameMax} символов.`;
  if (!Number.isInteger(p.cycles) || p.cycles < LIMITS.cyclesMin || p.cycles > LIMITS.cyclesMax) {
    return `Число циклов - целое от ${LIMITS.cyclesMin} до ${LIMITS.cyclesMax}.`;
  }
  if (p.modules.length === 0) return "Добавьте хотя бы один модуль.";
  if (p.modules.length > LIMITS.modulesMax) return `Не больше ${LIMITS.modulesMax} модулей.`;
  for (const [i, m] of p.modules.entries()) {
    const n = i + 1;
    if (!(m.revs >= LIMITS.revsMin && m.revs <= LIMITS.revsMax)) {
      return `Модуль ${n}: обороты от ${LIMITS.revsMin} до ${LIMITS.revsMax}.`;
    }
    if (!(m.rpm >= LIMITS.rpmMin && m.rpm <= LIMITS.rpmMax)) {
      return `Модуль ${n}: скорость от ${LIMITS.rpmMin} до ${LIMITS.rpmMax} об/мин.`;
    }
    if (!Number.isInteger(m.pause_ms) || m.pause_ms < 0 || m.pause_ms > LIMITS.pauseMsMax) {
      return `Модуль ${n}: пауза от 0 до ${LIMITS.pauseMsMax / 1000} с.`;
    }
  }
  return null;
}

/** Склеивается ли модуль i со следующим без остановки (как blends() в прошивке). */
export function blendsWithNext(p: Program, i: number): boolean {
  const m = p.modules[i];
  if (m.pause_ms > 0) return false;
  const lastInCycle = i === p.modules.length - 1;
  if (lastInCycle && p.cycles <= 1) return false;
  const next = p.modules[lastInCycle ? 0 : i + 1];
  return next.dir === m.dir;
}

/**
 * Время прохода модуля, с. Трапеция скорости с ускорением accel (об/мин/с):
 * разгон с нуля и торможение до нуля (для склеенных модулей это оценка сверху).
 */
export function moduleSeconds(m: ProgramModule, accelRpmS: number): number {
  const v = m.rpm / 60; // об/с
  const a = Math.max(accelRpmS, 0.001) / 60; // об/с²
  const d = m.revs;
  const ramp = (v * v) / a; // путь разгона + торможения
  const move = d >= ramp ? d / v + v / a : 2 * Math.sqrt(d / a);
  return move + m.pause_ms / 1000;
}

export interface ProgramSummary {
  revsPerCycle: number;
  cwPerCycle: number;
  ccwPerCycle: number;
  secondsPerCycle: number;
  totalRevs: number;
  totalSeconds: number;
}

export function summarize(p: Program, accelRpmS: number): ProgramSummary {
  let revs = 0;
  let cw = 0;
  let ccw = 0;
  let sec = 0;
  for (const m of p.modules) {
    revs += m.revs;
    if (m.dir === "cw") cw += m.revs;
    else ccw += m.revs;
    sec += moduleSeconds(m, accelRpmS);
  }
  const cycles = Math.max(1, p.cycles || 1);
  return {
    revsPerCycle: revs,
    cwPerCycle: cw,
    ccwPerCycle: ccw,
    secondsPerCycle: sec,
    totalRevs: revs * cycles,
    totalSeconds: sec * cycles,
  };
}

/** Тело POST /v1/program (form-urlencoded): name, cycles, modules="cw:10:30:0;...". */
export function toFirmwareForm(p: Program): URLSearchParams {
  const num = (v: number) => String(Math.round(v * 1000) / 1000);
  const modules = p.modules
    .map((m) => `${m.dir}:${num(m.revs)}:${num(m.rpm)}:${Math.round(m.pause_ms)}`)
    .join(";");
  return new URLSearchParams({ name: p.name.trim(), cycles: String(p.cycles), modules });
}

/** Привести произвольный JSON (импорт файла, ответ стенда) к Program. */
export function coerceProgram(raw: unknown): Program | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.modules)) return null;
  const modules: ProgramModule[] = [];
  for (const m of r.modules as Record<string, unknown>[]) {
    if (!m || typeof m !== "object") return null;
    modules.push({
      dir: m.dir === "ccw" ? "ccw" : "cw",
      revs: Number(m.revs) || 0,
      rpm: Number(m.rpm) || 0,
      pause_ms: Math.round(Number(m.pause_ms) || 0),
    });
  }
  return {
    name: typeof r.name === "string" ? r.name.slice(0, LIMITS.nameMax) : "Импорт",
    cycles: Math.max(1, Math.floor(Number(r.cycles) || 1)),
    modules,
  };
}

export function sameProgram(a: Program | null, b: Program | null): boolean {
  if (!a || !b) return false;
  if (a.name.trim() !== b.name.trim() || a.cycles !== b.cycles || a.modules.length !== b.modules.length) return false;
  const eq = (x: number, y: number) => Math.abs(x - y) < 1e-3;
  return a.modules.every((m, i) => {
    const o = b.modules[i];
    return m.dir === o.dir && eq(m.revs, o.revs) && eq(m.rpm, o.rpm) && m.pause_ms === o.pause_ms;
  });
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return "–";
  let s = Math.round(sec);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const p2 = (n: number) => (n < 10 ? "0" : "") + n;
  if (d > 0) return `${d} д ${h} ч ${p2(m)} мин`;
  if (h > 0) return `${h} ч ${p2(m)} мин`;
  if (m > 0) return `${m} мин ${p2(s)} с`;
  return `${s} с`;
}

export const fmtNum = (v: number, digits = 2) =>
  Number.isFinite(v) ? (Math.round(v * 10 ** digits) / 10 ** digits).toLocaleString("ru-RU") : "–";
