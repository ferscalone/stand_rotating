import { useEffect, useRef, useState } from "react";
import { FIRMWARE, LIMITS } from "../config";
import type { ConfigApplyResponse, StandSettings, Telemetry } from "../types";
import { uploadAvail } from "../standLogic";
import type { Gate } from "../coord/useCoordinator";
import { gatedAvail, LockTag } from "./LockTag";
import { Stepper } from "./Stepper";

interface Props {
  telemetry: Telemetry | null;
  gate: Gate;
  onApply: (s: StandSettings) => Promise<ConfigApplyResponse | null>;
}

/**
 * Параметры стенда (NVS): ускорение рампы, порог тока, удержание вала в простое,
 * датчики Холла (какие участвуют в контроле, допуск) и минимальный ток при вращении.
 * Поля заполняются из первого кадра телеметрии, пока оператор их не трогал.
 * Сам автостоп включается/выключается в карточке «Датчики Холла» - и на ходу.
 */
export function SettingsCard({ telemetry, gate, onApply }: Props) {
  const [accel, setAccel] = useState<number>(FIRMWARE.accelRpmS);
  const [limit, setLimit] = useState<number>(FIRMWARE.currentLimitA);
  const [hold, setHold] = useState<boolean>(FIRMWARE.holdIdle);
  const [mask, setMask] = useState<number>(FIRMWARE.hallMask);
  const [tol, setTol] = useState<number>(FIRMWARE.hallTol);
  const [minA, setMinA] = useState<number>(FIRMWARE.currentMinA);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const seeded = useRef(false);
  const dirty = useRef(false);
  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    dirty.current = true;
    setter(v);
  };
  useEffect(() => {
    if (seeded.current || dirty.current || !telemetry) return;
    seeded.current = true;
    setAccel(telemetry.cfg_accel_rpm_s);
    setLimit(telemetry.cfg_current_limit_a);
    setHold(!!telemetry.cfg_hold_idle);
    if (telemetry.hall_mask !== undefined) setMask(telemetry.hall_mask);
    if (telemetry.hall_tol !== undefined) setTol(telemetry.hall_tol);
    if (telemetry.cfg_current_min_a !== undefined) setMinA(telemetry.cfg_current_min_a);
  }, [telemetry]);

  const hasHall = telemetry?.hall_mask !== undefined;
  const avail = gatedAvail(uploadAvail(telemetry?.state ?? null), gate);
  const warning =
    !(accel >= LIMITS.accelMin && accel <= LIMITS.accelMax)
      ? `Ускорение от ${LIMITS.accelMin} до ${LIMITS.accelMax} об/мин/с.`
      : !(limit >= 0 && limit <= LIMITS.currentLimitMax)
        ? `Порог тока от 0 до ${LIMITS.currentLimitMax} А (0 - выключено).`
        : !(Number.isInteger(tol) && tol >= 1 && tol <= LIMITS.hallTolMax)
          ? `Допуск датчиков - целое от 1 до ${LIMITS.hallTolMax}.`
          : !(minA >= 0 && minA <= LIMITS.currentLimitMax)
            ? `Минимальный ток от 0 до ${LIMITS.currentLimitMax} А (0 - выключено).`
            : null;
  const canApply = avail.enabled && !warning && !applying;

  const apply = async () => {
    if (!canApply) return;
    setApplying(true);
    setResult(null);
    const res = await onApply({
      accelRpmS: accel,
      currentLimitA: limit,
      holdIdle: hold,
      hallMask: mask,
      hallTol: tol,
      currentMinA: minA,
    });
    if (res?.applied) {
      setResult({ ok: true, text: "Сохранено в стенде" });
      dirty.current = false;
    } else {
      setResult({ ok: false, text: `Отклонено (${res?.error ?? "нет ответа"})${res?.detail ? `: ${res.detail}` : ""}` });
    }
    setApplying(false);
  };

  const toggleMask = (bit: number) => touch(setMask)(mask ^ bit);
  // Время разгона до типовой скорости - чтобы ускорение было осязаемым.
  const to60 = accel > 0 ? 60 / accel : 0;

  return (
    <section className="card col-7">
      <div className="title">
        <h2>Параметры стенда</h2>
        <LockTag gate={gate} />
      </div>

      <div className="form-grid">
        <div className="field-row">
          <div className="field">
            <label>Ускорение рампы, об/мин за с</label>
            <Stepper value={accel} step={5} onChange={touch(setAccel)} />
          </div>
          <div className="field">
            <label>Порог аварии по току, А</label>
            <Stepper value={limit} step={0.1} onChange={touch(setLimit)} />
          </div>
        </div>

        <label className="check">
          <input type="checkbox" checked={hold} onChange={(e) => touch(setHold)(e.target.checked)} />
          Удерживать вал под током в простое (иначе ток снимается через 0,5 с после остановки)
        </label>

        <div className="hint">
          Разгон 0 → 60 об/мин ≈ {to60.toFixed(1)} с, торможение - так же. Порог 0 - защита по току выключена.
        </div>

        {hasHall && (
          <>
            <div className="sub-title">Контроль вращения</div>
            <div className="field">
              <label>Датчики Холла в контроле</label>
              <div className="seg">
                <button className={mask & 1 ? "on" : ""} onClick={() => toggleMask(1)}>
                  №1 (GPIO 19)
                </button>
                <button className={mask & 2 ? "on" : ""} onClick={() => toggleMask(2)}>
                  №2 (GPIO 20)
                </button>
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Допуск, «плохих» проходов подряд</label>
                <Stepper value={tol} step={1} onChange={(v) => touch(setTol)(Math.round(v))} />
              </div>
              <div className="field">
                <label>Мин. ток при вращении, А</label>
                <Stepper value={minA} step={0.05} onChange={touch(setMinA)} />
              </div>
            </div>
            <div className="hint">
              Датчик снятый с контроля продолжает считать обороты, но не останавливает стенд. «Плохой» проход - вал
              оказался у магнита не там, где его ждут по шагам, или прошёл магнит без импульса; при допуске {tol} авария
              на {tol + 1}-м подряд. Мин. ток 0 - проверка «вращение есть, тока нет» выключена.
            </div>
          </>
        )}

        {warning && <div className="warn-line">⚠ {warning}</div>}
        {!avail.enabled && <div className="lock-line">Применить нельзя: {avail.reason}</div>}

        <button className="btn-apply" disabled={!canApply} onClick={apply}>
          {applying ? "Применение…" : "Применить"}
        </button>
        {result && <div className={result.ok ? "note" : "warn-line"}>{result.ok ? "✓" : "⚠"} {result.text}</div>}
      </div>
    </section>
  );
}
