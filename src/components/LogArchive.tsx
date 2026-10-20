import { useEffect, useState } from "react";

interface Props {
  onClose: () => void;
}

interface DayFiles {
  day: string;
  files: { name: string; size: number }[];
}

function fileLabel(name: string): string {
  if (name === "journal.jsonl") return "Журнал событий и действий";
  const m = /^telemetry_(.+)\.jsonl$/.exec(name);
  if (m) return `Телеметрия · ${m[1]}`;
  return name;
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1)} МБ`;
}

/**
 * Архив серверного журнала: по дням - журнал событий/действий и телеметрия
 * каждого стенда. Скачивание в CSV (для Excel: «;» и десятичная запятая) или в
 * исходном JSONL.
 */
export function LogArchive({ onClose }: Props) {
  const [days, setDays] = useState<DayFiles[] | null>(null);
  const [tz, setTz] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("api/logs")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { days: DayFiles[]; tz: string }) => {
        if (cancelled) return;
        setDays(j.days);
        setTz(j.tz);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label="Архив журналов">
        <div className="title">
          <h2>Архив журналов</h2>
          <button className="chip" onClick={onClose}>
            Закрыть
          </button>
        </div>
        <div className="hint">
          Журнал ведётся на сервере панели, пока открыта хотя бы одна панель стенда.
          {tz && ` Время - ${tz}.`}
        </div>
        <div className="archive">
          {error && <div className="warn-line">⚠ Архив недоступен: {error}</div>}
          {!error && days === null && <div className="hint">Загрузка…</div>}
          {days?.length === 0 && <div className="hint">Записей пока нет.</div>}
          {days?.map((d) => (
            <div key={d.day} className="archive-day">
              <div className="archive-date num">{d.day}</div>
              {d.files.map((f) => {
                const href = `api/logs/${d.day}/${encodeURIComponent(f.name)}`;
                return (
                  <div key={f.name} className="archive-file">
                    <span className="archive-name">{fileLabel(f.name)}</span>
                    <span className="archive-size num">{fmtSize(f.size)}</span>
                    <a className="chip" href={`${href}?format=csv`} download>
                      CSV
                    </a>
                    <a className="chip" href={href} download>
                      JSONL
                    </a>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
