import type { Telemetry } from "../types";
import { fmtNum } from "../programLogic";

interface Props {
  telemetry: Telemetry | null;
}

/** Датчик тока INA219: ток, напряжение питания, мощность и порог защиты. */
export function PowerCard({ telemetry: t }: Props) {
  const ok = !!t?.ina_ok;
  const limit = t?.cfg_current_limit_a ?? 0;
  const amps = ok ? Math.abs(t!.current_a) : null;
  const load = amps !== null && limit > 0 ? Math.min(100, (amps / limit) * 100) : 0;

  return (
    <section className="card col-4 stretch">
      <div className="title">
        <h2>Ток (INA219)</h2>
        {t && <span className={`tag ${ok ? "ok" : "fault"}`}>{ok ? "Датчик в норме" : "Нет датчика"}</span>}
      </div>

      <div className="force">
        <span className="group">
          {amps !== null ? (
            <>
              <span className="val num">{fmtNum(amps, 2)}</span>
              <span className="unit">А</span>
            </>
          ) : (
            <span className="val empty">–</span>
          )}
        </span>
      </div>

      {limit > 0 && (
        <div className="progress-track" title={`Загрузка относительно порога ${limit} А`}>
          <div className={`progress-fill ${load > 85 ? "hot" : ""}`} style={{ width: `${load}%` }} />
        </div>
      )}

      <div className="meta-list">
        <div className="row">
          <span>Напряжение</span>
          {ok ? <span className="val num">{fmtNum(t!.voltage_v, 2)} В</span> : <span className="val empty">–</span>}
        </div>
        <div className="row">
          <span>Мощность</span>
          {ok ? <span className="val num">{fmtNum(Math.abs(t!.power_w), 1)} Вт</span> : <span className="val empty">–</span>}
        </div>
        <div className="row">
          <span>Порог аварии</span>
          {t ? (
            <span className="val num">{limit > 0 ? `${fmtNum(limit, 2)} А` : "выключен"}</span>
          ) : (
            <span className="val empty">–</span>
          )}
        </div>
      </div>
    </section>
  );
}
