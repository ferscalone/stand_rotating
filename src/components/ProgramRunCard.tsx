import type { Command, Telemetry } from "../types";
import { pauseAvail, phaseLabel, resumeAvail, startAvail, stopAvail } from "../standLogic";
import { fmtDuration, fmtNum } from "../programLogic";
import type { Gate } from "../coord/useCoordinator";
import { gatedAvail, LockTag } from "./LockTag";

interface Props {
  telemetry: Telemetry | null;
  gate: Gate;
  onCommand: (cmd: Command) => void;
}

/** Выполнение программы, загруженной в стенд: прогресс и кнопки пуск/пауза/стоп. */
export function ProgramRunCard({ telemetry: t, gate, onCommand }: Props) {
  const start = gatedAvail(startAvail(t), gate);
  const pause = gatedAvail(pauseAvail(t), gate);
  const resume = gatedAvail(resumeAvail(t), gate);
  const stop = gatedAvail(stopAvail(t?.state ?? null), gate);
  const paused = t?.state === "PAUSED";
  const active = t?.state === "PROGRAM" || paused;
  const started = !!t && t.prog_cycle > 0;
  const pct = t ? Math.min(100, Math.max(0, t.prog_progress * 100)) : 0;

  return (
    <section className="card col-5 stretch">
      <div className="title">
        <h2>Программа в стенде</h2>
        <LockTag gate={gate} />
      </div>

      <div className="prog-name">
        {t?.prog_name ? t.prog_name : <span className="empty">не загружена</span>}
        {active && <span className={`tag ${paused ? "busy" : "ok"}`}>{paused ? "пауза" : phaseLabel(t?.phase)}</span>}
      </div>

      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${started ? pct : 0}%` }} />
      </div>

      <div className="meta-list">
        <div className="row">
          <span>Цикл</span>
          {t && t.prog_cycles > 0 ? (
            <span className="val num">
              {started ? t.prog_cycle : "–"} / {t.prog_cycles}
            </span>
          ) : (
            <span className="val empty">–</span>
          )}
        </div>
        <div className="row">
          <span>Модуль</span>
          {t && t.prog_modules > 0 ? (
            <span className="val num">
              {started ? t.prog_module : "–"} / {t.prog_modules}
            </span>
          ) : (
            <span className="val empty">–</span>
          )}
        </div>
        <div className="row">
          <span>Обороты модуля</span>
          {active && t ? (
            <span className="val num">
              {fmtNum(t.move_revs, 2)} / {fmtNum(t.move_target, 2)}
            </span>
          ) : (
            <span className="val empty">–</span>
          )}
        </div>
        <div className="row">
          <span>{t && t.dwell_left_ms > 0 ? "Пауза модуля, осталось" : "Выполнено"}</span>
          {t && t.dwell_left_ms > 0 ? (
            <span className="val num">{fmtDuration(t.dwell_left_ms / 1000)}</span>
          ) : started ? (
            <span className="val num">{fmtNum(pct, 1)} %</span>
          ) : (
            <span className="val empty">–</span>
          )}
        </div>
      </div>

      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn-apply" disabled={!start.enabled} title={start.reason} onClick={() => onCommand("start")}>
          ▶ Пуск
        </button>
        {paused ? (
          <button className="btn-ghost" disabled={!resume.enabled} title={resume.reason} onClick={() => onCommand("resume")}>
            ⏵ Продолжить
          </button>
        ) : (
          <button className="btn-ghost" disabled={!pause.enabled} title={pause.reason} onClick={() => onCommand("pause")}>
            ⏸ Пауза
          </button>
        )}
        <button
          className="btn-ghost"
          disabled={!stop.enabled || !active}
          title={active ? stop.reason : "Программа не выполняется"}
          onClick={() => onCommand("stop")}
        >
          ■ Стоп
        </button>
      </div>
      {!start.enabled && !active && <div className="hint" style={{ marginTop: 8 }}>{start.reason}</div>}
    </section>
  );
}
