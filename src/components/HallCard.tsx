import { useState } from "react";
import type { Command, Telemetry } from "../types";
import type { GuardWarning } from "../hooks/useStand";
import { guardLabel, hallStateLabel } from "../standLogic";
import { fmtNum } from "../programLogic";
import type { Gate } from "../coord/useCoordinator";
import { LockTag } from "./LockTag";

interface Props {
  telemetry: Telemetry | null;
  gate: Gate;
  lastWarn: GuardWarning | null;
  onCommand: (cmd: Command) => void;
}

/**
 * Датчики Холла на концах вала: независимый счёт оборотов и скорость, сверка с
 * двигателем и переключатель автостопа. Автостоп меняется на ходу командой
 * "guard on|off"; выключенный автостоп оставляет предупреждения.
 */
export function HallCard({ telemetry: t, gate, lastWarn, onCommand }: Props) {
  const [confirmOff, setConfirmOff] = useState(false);
  const supported = t?.hall_mask !== undefined;
  const guardOn = !!t?.hall_guard;

  const toggleGuard = () => {
    if (!gate.allowed || !t) return;
    if (guardOn && !confirmOff) {
      setConfirmOff(true); // выключение защиты - вторым нажатием
      return;
    }
    setConfirmOff(false);
    onCommand(guardOn ? "guard off" : "guard on");
  };

  return (
    <section className="card col-12">
      <div className="title">
        <h2>Датчики Холла · контроль вращения</h2>
        <div className="title-tags">
          {supported && (
            <span className={`tag ${guardOn ? "ok" : "busy"}`}>
              {guardOn ? "Автостоп включён" : "Автостоп выключен - только предупреждения"}
            </span>
          )}
          <LockTag gate={gate} />
        </div>
      </div>

      {!t ? (
        <div className="hint">Нет связи со стендом.</div>
      ) : !supported ? (
        <div className="hint">Прошивка стенда без датчиков Холла - обновите прошивку.</div>
      ) : (
        <div className="hall-grid">
          <HallSensor n={1} t={t} />
          <HallSensor n={2} t={t} />

          <div className="hall-side">
            <div className="meta-list">
              <div className="row">
                <span>По шагам двигателя</span>
                <span className="val num">{t.revs.toLocaleString("ru-RU")} об</span>
              </div>
              <div className="row">
                <span>Скорость по шагам</span>
                <span className="val num">{fmtNum(Math.abs(t.rpm), 1)} об/мин</span>
              </div>
              <div className="row">
                <span>Сдвиг №2 от №1</span>
                {t.hall_phase_ok ? (
                  <span className="val num">{fmtNum(t.hall_phase ?? 0, 1)}°</span>
                ) : (
                  <span className="val empty">–</span>
                )}
              </div>
              <div className="row">
                <span>Допуск</span>
                <span className="val num">{t.hall_tol ?? "–"} подряд</span>
              </div>
            </div>
            <button
              className={`btn-guard ${guardOn ? "on" : "off"} ${confirmOff ? "confirm" : ""}`}
              disabled={!gate.allowed}
              title={gate.allowed ? "" : gate.reason}
              onClick={toggleGuard}
              onBlur={() => setConfirmOff(false)}
            >
              {confirmOff ? "Точно выключить автостоп?" : guardOn ? "Выключить автостоп" : "Включить автостоп"}
            </button>
          </div>

          {lastWarn && (
            <div className="hall-warn">
              ⚠ {clock(lastWarn.ts)} · {guardLabel(lastWarn.code, lastWarn.value)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function HallSensor({ n, t }: { n: 1 | 2; t: Telemetry }) {
  const st = n === 1 ? t.h1_st : t.h2_st;
  const on = n === 1 ? t.h1_on : t.h2_on;
  const revs = n === 1 ? t.h1_revs : t.h2_revs;
  const rpm = n === 1 ? t.h1_rpm : t.h2_rpm;
  const bad = n === 1 ? t.h1_bad : t.h2_bad;
  const lag = n === 1 ? t.h1_lag : t.h2_lag;
  const tol = t.hall_tol ?? 1;
  const stClass = st === "ok" ? (bad ? "warn" : "ok") : st === "learn" ? "learn" : "off";
  const delta = rpm !== undefined && Math.abs(t.rpm) > 0.05 ? rpm - Math.abs(t.rpm) : null;

  return (
    <div className={`hall-sensor ${stClass}`}>
      <div className="hall-head">
        <span className={`hall-led ${on ? "lit" : ""}`} title={on ? "Магнит у датчика" : "Магнита нет"} />
        <span className="hall-name">№{n}</span>
        <span className="hall-state">{hallStateLabel(st)}</span>
      </div>
      <div className="force">
        <span className="group">
          <span className="val num">{(revs ?? 0).toLocaleString("ru-RU")}</span>
          <span className="unit">об</span>
        </span>
      </div>
      <div className="meta-list">
        <div className="row">
          <span>Скорость</span>
          <span className="val num">{fmtNum(rpm ?? 0, 1)} об/мин</span>
        </div>
        <div className="row">
          <span>Разница со скоростью двигателя</span>
          {delta === null ? (
            <span className="val empty">–</span>
          ) : (
            <span className={`val num ${Math.abs(delta) > 0.1 * Math.abs(t.rpm) + 0.5 ? "bad" : ""}`}>
              {delta > 0 ? "+" : ""}
              {fmtNum(delta, 1)} об/мин
            </span>
          )}
        </div>
        <div className="row">
          <span title="Где был вал при последнем проходе магнита относительно положения по шагам двигателя">
            Смещение вала
          </span>
          {lag === null || lag === undefined ? (
            <span className="val empty">–</span>
          ) : (
            <span className={`val num ${Math.abs(lag) > 36 ? "bad" : ""}`}>{fmtNum(lag, 1)}°</span>
          )}
        </div>
        <div className="row">
          <span>«Плохих» подряд</span>
          <span className={`val num ${bad ? "bad" : ""}`}>
            {st === "ok" ? `${bad ?? 0} из ${tol + 1}` : "–"}
          </span>
        </div>
      </div>
    </div>
  );
}

function clock(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => (n < 10 ? "0" : "") + n;
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
