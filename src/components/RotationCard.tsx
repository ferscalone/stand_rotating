import type { Command, Telemetry } from "../types";
import { zeroAvail } from "../standLogic";
import { fmtNum } from "../programLogic";
import type { Gate } from "../coord/useCoordinator";
import { gatedAvail } from "./LockTag";

interface Props {
  telemetry: Telemetry | null;
  gate: Gate;
  onCommand: (cmd: Command) => void;
}

/**
 * Скорость и обороты: фактическая скорость крупно (знак - направление), ротор с
 * меткой текущего угла внутри оборота, счётчик полных оборотов от обнуления и
 * пробег за всё время.
 */
export function RotationCard({ telemetry: t, gate, onCommand }: Props) {
  const zero = gatedAvail(zeroAvail(t?.state ?? null), gate);
  const rpm = t ? Math.abs(t.rpm) : null;
  const moving = t ? Math.abs(t.rpm) > 0.01 : false;
  const dir = t ? (t.rpm < -0.01 ? "ccw" : t.rpm > 0.01 ? "cw" : t.dir) : "cw";
  // Угол метки: доля текущего оборота. По часовой - метка идёт по часовой.
  const frac = t ? t.position_rev - Math.floor(t.position_rev) : 0;
  const angle = frac * 360;

  return (
    <section className="card col-4 stretch">
      <div className="title">
        <h2>Вращение</h2>
        {t && moving && <span className="tag ok">{dir === "cw" ? "↻ по часовой" : "↺ против часовой"}</span>}
      </div>

      <div className="rot-grid">
        <svg className="rotor" viewBox="-50 -50 100 100" aria-hidden="true">
          <circle r="44" className="rotor-ring" />
          {Array.from({ length: 12 }, (_, i) => (
            <line key={i} className="rotor-tick" x1="0" y1="-44" x2="0" y2={i % 3 === 0 ? -37 : -40}
                  transform={`rotate(${i * 30})`} />
          ))}
          <g transform={`rotate(${angle})`}>
            <line x1="0" y1="0" x2="0" y2="-34" className="rotor-hand" />
            <circle cy="-34" r="4.5" className="rotor-dot" />
          </g>
          <circle r="5" className="rotor-hub" />
        </svg>

        <div className="force">
          <span className="group">
            {rpm !== null ? (
              <>
                <span className="val num">{fmtNum(rpm, rpm < 10 ? 2 : 1)}</span>
                <span className="unit">об/мин</span>
              </>
            ) : (
              <span className="val empty">–</span>
            )}
          </span>
        </div>
      </div>

      <div className="meta-list">
        <div className="row">
          <span>Заданная скорость</span>
          {t && t.target_rpm > 0 && t.state !== "IDLE" && t.state !== "ERROR" ? (
            <span className="val num">{fmtNum(t.target_rpm, 1)} об/мин</span>
          ) : (
            <span className="val empty">–</span>
          )}
        </div>
        <div className="row">
          <span>Полных оборотов</span>
          <span className="val num row-actions">
            {t ? <b>{t.revs.toLocaleString("ru-RU")}</b> : <span className="empty">–</span>}
            <button
              className="chip small"
              disabled={!zero.enabled}
              title={zero.enabled ? "Обнулить позицию и счётчик оборотов" : zero.reason}
              onClick={() => onCommand("zero")}
            >
              Обнулить
            </button>
          </span>
        </div>
        <div className="row">
          <span>Позиция от нуля</span>
          {t ? <span className="val num">{fmtNum(t.position_rev, 2)} об</span> : <span className="val empty">–</span>}
        </div>
        <div className="row">
          <span>Пробег за всё время</span>
          {t ? <span className="val num">{t.total_revs.toLocaleString("ru-RU")} об</span> : <span className="val empty">–</span>}
        </div>
      </div>
    </section>
  );
}
