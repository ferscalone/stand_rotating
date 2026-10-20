import { useEffect, useRef, useState } from "react";
import { FIRMWARE, LIMITS } from "../config";
import type { ConfigApplyResponse, Telemetry } from "../types";
import { uploadAvail } from "../standLogic";
import type { Gate } from "../coord/useCoordinator";
import { gatedAvail, LockTag } from "./LockTag";
import { Stepper } from "./Stepper";

interface Props {
  telemetry: Telemetry | null;
  gate: Gate;
  onApply: (accelRpmS: number, currentLimitA: number, holdIdle: boolean) => Promise<ConfigApplyResponse | null>;
}

/**
 * Параметры стенда (NVS): ускорение рампы, порог тока, удержание вала в простое.
 * Поля заполняются из первого кадра телеметрии, пока оператор их не трогал.
 */
export function SettingsCard({ telemetry, gate, onApply }: Props) {
  const [accel, setAccel] = useState<number>(FIRMWARE.accelRpmS);
  const [limit, setLimit] = useState<number>(FIRMWARE.currentLimitA);
  const [hold, setHold] = useState<boolean>(FIRMWARE.holdIdle);
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
  }, [telemetry]);

  const avail = gatedAvail(uploadAvail(telemetry?.state ?? null), gate);
  const warning =
    !(accel >= LIMITS.accelMin && accel <= LIMITS.accelMax)
      ? `Ускорение от ${LIMITS.accelMin} до ${LIMITS.accelMax} об/мин/с.`
      : !(limit >= 0 && limit <= LIMITS.currentLimitMax)
        ? `Порог тока от 0 до ${LIMITS.currentLimitMax} А (0 - выключено).`
        : null;
  const canApply = avail.enabled && !warning && !applying;

  const apply = async () => {
    if (!canApply) return;
    setApplying(true);
    setResult(null);
    const res = await onApply(accel, limit, hold);
    if (res?.applied) {
      setResult({ ok: true, text: "Сохранено в стенде" });
      dirty.current = false;
    } else {
      setResult({ ok: false, text: `Отклонено (${res?.error ?? "нет ответа"})${res?.detail ? `: ${res.detail}` : ""}` });
    }
    setApplying(false);
  };

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
