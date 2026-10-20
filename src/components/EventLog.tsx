import { useEffect, useRef, type ReactNode } from "react";
import type { LogEntry } from "../hooks/useStand";

interface Props {
  log: LogEntry[];
  /** Кнопки в заголовке карточки (например, «Архив журналов»). */
  actions?: ReactNode;
}

/** Прокручиваемый журнал событий/системы. Автопрокрутка вниз, если уже находится внизу. */
export function EventLog({ log, actions }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <section className="card col-12">
      <div className="title">
        <h2>Журнал событий</h2>
        {actions}
      </div>
      <div
        className="log"
        ref={ref}
        onScroll={() => {
          const el = ref.current;
          if (!el) return;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
      >
        {log.length === 0 && <div className="log-line ev-sys">Журнал пуст…</div>}
        {log.map((e) => (
          <div key={e.id} className={`log-line ev-${e.kind}`}>
            <span className="ts">[{clock(e.ts)}] </span>
            {e.text}
          </div>
        ))}
      </div>
    </section>
  );
}

function clock(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => (n < 10 ? "0" : "") + n;
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
