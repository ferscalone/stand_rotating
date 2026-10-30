import type { Program, Telemetry } from "./types";

// ── Пересчёт оборотов: дробление шага драйвера ────────────────────────────────
// Прошивка считает обороты по своему Config::STEPS_PER_REV (приходит в телеметрии
// как steps_per_rev, сейчас 800 = 1/4 шага). На драйвере выставлено деление 1/16,
// то есть реальный оборот вала - SHAFT_STEPS_PER_REV импульсов. Панель пересчитывает
// всё в реальные обороты сама, прошивку менять не нужно:
//
//   реальные = прошивочные × k,   k = steps_per_rev прошивки / SHAFT_STEPS_PER_REV
//
// Если прошивку когда-нибудь пересоберут с 3200, k станет 1 и пересчёт исчезнет сам.
// Новая прошивка сама сообщает реальное значение (shaft_steps_per_rev) - тогда
// константа ниже не используется.
//
// Данные датчиков Холла (h1_*, h2_*) - уже реальные обороты вала, их не трогаем.

/** Импульсов STEP на один реальный оборот вала: 200 шагов × 1/16 (если прошивка не прислала). */
export const SHAFT_STEPS_PER_REV = 200 * 16;

/** steps_per_rev прошивки до первого кадра телеметрии (Config.h: 800). */
const FIRMWARE_STEPS_PER_REV_DEFAULT = 800;

/** Коэффициент «прошивочный оборот → реальный оборот». */
export function revFactor(firmwareStepsPerRev: number | undefined, shaftStepsPerRev?: number): number {
  const fw = firmwareStepsPerRev && firmwareStepsPerRev > 0 ? firmwareStepsPerRev : FIRMWARE_STEPS_PER_REV_DEFAULT;
  const shaft = shaftStepsPerRev && shaftStepsPerRev > 0 ? shaftStepsPerRev : SHAFT_STEPS_PER_REV;
  return fw / shaft;
}

export const defaultRevFactor = () => revFactor(undefined);

/** Телеметрия прошивки → реальные обороты и об/мин. */
export function telemetryToShaft(t: Telemetry): Telemetry {
  const k = revFactor(t.steps_per_rev, t.shaft_steps_per_rev);
  if (k === 1) return t;
  const revsF = t.revs_f * k;
  return {
    ...t,
    rpm: t.rpm * k,
    target_rpm: t.target_rpm * k,
    position_rev: t.position_rev * k,
    revs_f: revsF,
    revs: Math.floor(revsF + 1e-9),
    total_revs: Math.floor(t.total_revs * k + 1e-9),
    move_revs: t.move_revs * k,
    move_target: t.move_target * k,
    cfg_accel_rpm_s: t.cfg_accel_rpm_s * k,
    rpm_min: t.rpm_min * k,
    rpm_max: t.rpm_max * k,
    steps_per_rev: t.shaft_steps_per_rev ?? SHAFT_STEPS_PER_REV,
  };
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * Команда в реальных единицах → команда для прошивки: числа в "run <dir> <rpm> [revs]"
 * и "speed <rpm>" делятся на k. Остальные команды без чисел - как есть.
 */
export function commandToFirmware(cmd: string, k: number): string {
  if (k === 1) return cmd;
  const t = cmd.trim().split(/\s+/);
  if (t[0] === "run" && t.length >= 3) {
    return ["run", t[1], ...t.slice(2).map((v) => fmt(Number(v) / k))].join(" ");
  }
  if (t[0] === "speed" && t.length === 2) return `speed ${fmt(Number(t[1]) / k)}`;
  return cmd;
}

/** Программа в реальных единицах ↔ прошивочных (обороты и скорость модулей). */
export function programScale(p: Program, factor: number): Program {
  if (factor === 1) return p;
  return {
    ...p,
    modules: p.modules.map((m) => ({
      ...m,
      revs: Math.round(m.revs * factor * 1000) / 1000,
      rpm: Math.round(m.rpm * factor * 1000) / 1000,
    })),
  };
}
