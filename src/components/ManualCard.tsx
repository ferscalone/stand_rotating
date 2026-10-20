import { useEffect, useRef, useState } from "react";
import { FIRMWARE, LIMITS } from "../config";
import type { Command, Dir, Telemetry } from "../types";
import { runAvail, stopAvail } from "../standLogic";
import { fmtNum } from "../programLogic";
import type { Gate } from "../coord/useCoordinator";
import { gatedAvail, LockTag } from "./LockTag";
import { Stepper } from "./Stepper";

interface Props {
  telemetry: Telemetry | null;
  gate: Gate;
  onCommand: (cmd: Command) => void;
}

/**
 * Ручное вращение: направление, скорость, непрерывно или N оборотов. Пока вал
 * крутится в ручном режиме, «Применить» меняет скорость/направление на ходу -
 * прошивка делает это по рампе (разворот - через плавную остановку).
 */
export function ManualCard({ telemetry: t, gate, onCommand }: Props) {
  const [dir, setDir] = useState<Dir>("cw");
  const [rpm, setRpm] = useState<number>(FIRMWARE.rpmDefault);
  const [continuous, setContinuous] = useState(true);
  const [revs, setRevs] = useState<number>(10);

  const state = t?.state ?? null;
  const run = gatedAvail(runAvail(state), gate);
  const stop = gatedAvail(stopAvail(state), gate);
  const manual = state === "MANUAL";
  // Порог панели (LIMITS) - но не шире, чем примет прошивка.
  const rpmMax = Math.min(t?.rpm_max ?? LIMITS.rpmMax, LIMITS.rpmMax);
  const rpmMin = Math.max(t?.rpm_min ?? LIMITS.rpmMin, LIMITS.rpmMin);

  // Подхватить параметры текущего ручного движения, если его запустил кто-то
  // другой (или до перезагрузки страницы) - один раз на вход в MANUAL.
  const wasManual = useRef(false);
  useEffect(() => {
    if (manual && !wasManual.current && t) {
      setDir(t.dir);
      if (t.target_rpm > 0) setRpm(t.target_rpm);
      setContinuous(!!t.continuous);
      if (!t.continuous && t.move_target > 0) setRevs(t.move_target);
    }
    wasManual.current = manual;
  }, [manual, t]);

  const rpmOk = rpm >= rpmMin && rpm <= rpmMax;
  const revsOk = continuous || (revs >= LIMITS.revsMin && revs <= LIMITS.revsMax);
  const warning = !rpmOk
    ? `Скорость от ${rpmMin} до ${rpmMax} об/мин.`
    : !revsOk
      ? `Обороты от ${LIMITS.revsMin} до ${LIMITS.revsMax}.`
      : null;

  const runCmd = () => `run ${dir} ${round3(rpm)}${continuous ? "" : ` ${round3(revs)}`}`;

  // На ходу в непрерывном режиме в ту же сторону достаточно сменить скорость.
  const onlySpeed = manual && t && !!t.continuous && continuous && t.dir === dir;
  const apply = () => onCommand(onlySpeed ? `speed ${round3(rpm)}` : runCmd());

  const progress =
    manual && t && t.move_target > 0 ? Math.min(100, (t.move_revs / t.move_target) * 100) : null;

  return (
    <section className="card col-7">
      <div className="title">
        <h2>Ручное управление</h2>
        <LockTag gate={gate} />
      </div>

      <div className="form-grid">
        <div className="field">
          <label>Направление</label>
          <div className="seg">
            <button className={dir === "cw" ? "on" : ""} onClick={() => setDir("cw")}>↻ По часовой</button>
            <button className={dir === "ccw" ? "on" : ""} onClick={() => setDir("ccw")}>↺ Против часовой</button>
          </div>
        </div>

        <div className="field">
          <label>Скорость, об/мин</label>
          <div className="speed-row">
            <Stepper value={rpm} step={rpm < 5 ? 0.5 : 5} onChange={setRpm} />
            <input
              type="range"
              className="slider"
              min={rpmMin}
              max={rpmMax}
              step={0.5}
              value={Math.min(Math.max(rpm, rpmMin), rpmMax)}
              onChange={(e) => setRpm(Number(e.target.value))}
              aria-label="Скорость"
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label>Режим</label>
            <div className="seg">
              <button className={continuous ? "on" : ""} onClick={() => setContinuous(true)}>Непрерывно</button>
              <button className={!continuous ? "on" : ""} onClick={() => setContinuous(false)}>N оборотов</button>
            </div>
          </div>
          <div className="field">
            <label>Оборотов</label>
            {continuous ? (
              <div className="stepper disabled-field">
                <input className="num" value="∞" disabled readOnly />
              </div>
            ) : (
              <Stepper value={revs} step={1} onChange={setRevs} />
            )}
          </div>
        </div>

        {warning && <div className="warn-line">⚠ {warning}</div>}
        {!gate.allowed && <div className="lock-line">Управление недоступно: {gate.reason}</div>}
        {gate.allowed && !run.enabled && <div className="lock-line">{run.reason}</div>}

        <div className="btn-row">
          <button className="btn-apply" disabled={!run.enabled || !!warning} onClick={apply}>
            {manual ? (onlySpeed ? "Сменить скорость" : "Применить на ходу") : "▶ Пуск"}
          </button>
          <button className="btn-ghost" disabled={!stop.enabled} title={stop.reason} onClick={() => onCommand("stop")}>
            ■ Плавный стоп
          </button>
        </div>

        {manual && t && (
          <div className="note">
            Крутится {t.dir === "cw" ? "по часовой" : "против часовой"} на {fmtNum(t.target_rpm, 1)} об/мин
            {t.continuous ? " непрерывно" : ""}. Пройдено {fmtNum(t.move_revs, 2)}
            {t.move_target > 0 ? ` из ${fmtNum(t.move_target, 2)}` : ""} об.
            {progress !== null && (
              <div className="progress-track slim">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
