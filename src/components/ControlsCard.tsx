import type { ReactNode } from "react";
import type { Command, StandState } from "../types";
import { estopAvail, resetAvail, stopAvail, type Avail } from "../standLogic";
import type { Gate } from "../coord/useCoordinator";
import { gatedAvail, LockedIcon, LockTag } from "./LockTag";

interface Props {
  state: StandState | null;
  onCommand: (cmd: Command) => void;
  gate: Gate;
}

const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </svg>
);
const AlertIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l9 16H3l9-16z" />
    <path d="M12 10v4M12 17h.01" />
  </svg>
);
const ResetIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12a8 8 0 1 0 2.3-5.6" />
    <path d="M4 4v4h4" />
  </svg>
);

/**
 * Остановки и сброс. STOP - плавное торможение по рампе (ручной режим или
 * программа). E-STOP - немедленная остановка без рампы, стенд уходит в аварию.
 * E-STOP доступен ВСЕГДА, даже без права управления: безопасность важнее канала.
 */
export function ControlsCard({ state, onCommand, gate }: Props) {
  const stop = gatedAvail(stopAvail(state), gate);
  const reset = gatedAvail(resetAvail(state), gate);
  const estop = estopAvail(state);
  const locked = !gate.allowed;

  return (
    <section className="card col-5 controls-card">
      <div className="title">
        <h2>Остановка</h2>
        <LockTag gate={gate} />
      </div>
      <div className="controls">
        <ControlRow
          token="STOP"
          gloss="Плавный стоп по рампе"
          avail={stop}
          icon={locked ? <LockedIcon /> : <StopIcon />}
          secondary
          onClick={() => onCommand("stop")}
        />
        <ControlRow
          token="E-STOP"
          gloss="Аварийный стоп без рампы"
          avail={estop}
          icon={<AlertIcon />}
          danger
          onClick={() => onCommand("estop")}
        />
        <ControlRow
          token="RESET"
          gloss="Сброс аварии"
          avail={reset}
          icon={locked ? <LockedIcon /> : <ResetIcon />}
          secondary
          onClick={() => onCommand("reset")}
        />
      </div>
    </section>
  );
}

function ControlRow({
  token,
  gloss,
  avail,
  icon,
  secondary,
  danger,
  onClick,
}: {
  token: string;
  gloss: string;
  avail: Avail;
  icon: ReactNode;
  secondary?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="control">
      <button
        className={`ctl-btn ${secondary ? "secondary" : ""} ${danger ? "danger" : ""}`}
        disabled={!avail.enabled}
        onClick={onClick}
        title={avail.enabled ? gloss : avail.reason}
      >
        {icon}
        {token}
      </button>
      <div className="ctl-meta">
        <div className="name">{gloss}</div>
        <div className="why">{avail.enabled ? "Готово" : avail.reason}</div>
      </div>
    </div>
  );
}
