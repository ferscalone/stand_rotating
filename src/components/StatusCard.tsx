import type { Telemetry } from "../types";
import { errorLabel, phaseLabel, stateMeta } from "../standLogic";

interface Props {
  telemetry: Telemetry | null;
}

export function StatusCard({ telemetry }: Props) {
  const state = telemetry?.state ?? null;
  const meta = stateMeta(state);
  const inProgram = state === "PROGRAM" || state === "PAUSED";

  return (
    <section className="card col-4 stretch">
      <div className="title">
        <h2>Статус</h2>
        {telemetry && (
          <span className={`tag ${telemetry.driver_en ? "ok" : ""}`} title="Обмотки двигателя под током">
            {telemetry.driver_en ? "Драйвер вкл" : "Драйвер выкл"}
          </span>
        )}
      </div>

      <div className="status-main">
        <span className={`state-lamp ${meta.intent}`} />
        <div className="status-name">{meta.label}</div>
      </div>

      {state === "ERROR" && telemetry?.error && <div className="alarm-line">⚠ {errorLabel(telemetry.error)}</div>}

      <div className="meta-list">
        <div className="row">
          <span>Фаза программы</span>
          {inProgram ? <span className="val">{phaseLabel(telemetry?.phase)}</span> : <span className="val empty">–</span>}
        </div>
        <div className="row">
          <span>Аптайм</span>
          {telemetry ? <span className="val num">{fmtUptime(telemetry.uptime_ms)}</span> : <span className="val empty">–</span>}
        </div>
      </div>
    </section>
  );
}

function fmtUptime(ms: number): string {
  let s = Math.floor(Number(ms) / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const p2 = (n: number) => (n < 10 ? "0" : "") + n;
  if (h > 0) return `${h}ч ${p2(m)}м ${p2(s)}с`;
  if (m > 0) return `${m}м ${p2(s)}с`;
  return `${s}с`;
}
