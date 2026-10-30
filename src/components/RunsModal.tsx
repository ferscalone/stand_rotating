import { useCallback, useEffect, useMemo, useState } from "react";
import type { Theme } from "../hooks/useTheme";
import { api, COL, resultLabel, runTitle, type RunMeta, type SampleRow } from "../runs";
import { errorLabel, guardLabel } from "../standLogic";
import { fmtDuration, fmtNum } from "../programLogic";
import { RunChart, fmtT, type ChartSeries } from "./RunChart";

interface Props {
  host: string;
  user: string;
  theme: Theme;
  onClose: () => void;
}

/**
 * Испытания стенда: список прогонов, записанных сервером панели, и отчёт по
 * каждому - сводка, графики скорости (двигатель и датчики Холла), тока и оборотов,
 * события, примечание. Выгрузка CSV и печать в PDF.
 */
export function RunsModal({ host, user, theme, onClose }: Props) {
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [rec, setRec] = useState<{ enabled: boolean; connected: boolean; known: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api.list(host), api.recorder()]);
      setRuns(r.runs);
      const h = s.hosts.find((x) => x.host === host.toLowerCase());
      setRec({ enabled: s.enabled, connected: !!h?.connected, known: !!h });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [host]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (openId ? setOpenId(null) : onClose());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, openId]);

  const totals = useMemo(() => {
    const list = runs ?? [];
    return {
      count: list.length,
      revs: list.reduce((a, r) => a + r.stats.revs_motor, 0),
      hours: list.reduce((a, r) => a + r.stats.duration_s, 0) / 3600,
      errors: list.filter((r) => r.result === "error").length,
    };
  }, [runs]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card modal-wide" role="dialog" aria-modal="true" aria-label="Испытания">
        {openId ? (
          <RunReport id={openId} host={host} user={user} theme={theme} onBack={() => setOpenId(null)} onChanged={load} />
        ) : (
          <>
            <div className="title">
              <h2>Испытания · {host}</h2>
              <button className="chip small" onClick={onClose}>
                Закрыть
              </button>
            </div>

            {rec && (
              <div className={`rec-line ${rec.connected ? "ok" : "off"}`}>
                <span className="dot" />
                {!rec.enabled
                  ? "Регистратор сервера выключен (RECORDER=0) - испытания пишутся, только пока открыта панель."
                  : rec.connected
                    ? "Сервер сам пишет телеметрию этого стенда - запись идёт и при закрытой панели."
                    : rec.known
                      ? "Регистратор сервера ждёт связи со стендом (стенд выключен или адрес недоступен с сервера)."
                      : "Регистратор этот стенд не пишет."}
                {rec.enabled && !rec.known && (
                  <button className="chip small" onClick={() => void api.record(host).then(load)}>
                    Писать этот стенд
                  </button>
                )}
              </div>
            )}

            {error && <div className="warn-line">⚠ {error}</div>}
            {runs && runs.length === 0 && (
              <div className="hint">Испытаний пока нет. Испытание - это прогон от пуска (ручного или программы) до остановки.</div>
            )}

            {runs && runs.length > 0 && (
              <>
                <div className="summary">
                  <div>
                    <span className="k">Испытаний</span>
                    <span className="v num">{totals.count}</span>
                  </div>
                  <div>
                    <span className="k">Оборотов всего</span>
                    <span className="v num">{fmtNum(totals.revs, 0)}</span>
                  </div>
                  <div>
                    <span className="k">Время работы</span>
                    <span className="v num">{fmtNum(totals.hours, 1)} ч</span>
                  </div>
                  <div>
                    <span className="k">С аварией</span>
                    <span className="v num">{totals.errors}</span>
                  </div>
                </div>
                <div className="runs-table">
                  <div className="runs-row runs-head">
                    <span>Начало</span>
                    <span>Испытание</span>
                    <span>Длительность</span>
                    <span>Обороты</span>
                    <span>Ср. скорость</span>
                    <span>Итог</span>
                  </div>
                  {runs.map((r) => {
                    const res = resultLabel(r);
                    return (
                      <button key={r.id} className="runs-row" onClick={() => setOpenId(r.id)}>
                        <span className="num">{r.startedAtText}</span>
                        <span className="runs-name">
                          {runTitle(r)}
                          {r.note && <span className="runs-note"> · {r.note}</span>}
                        </span>
                        <span className="num">{fmtDuration(r.stats.duration_s)}</span>
                        <span className="num">{fmtNum(r.stats.revs_motor, 1)}</span>
                        <span className="num">{fmtNum(r.stats.rpm_avg, 1)} об/мин</span>
                        <span>
                          <span className={`tag ${res.tone}`}>{res.text}</span>
                          {r.stats.warnings > 0 && <span className="tag busy">⚠ {r.stats.warnings}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RunReport({
  id,
  host,
  user,
  theme,
  onBack,
  onChanged,
}: {
  id: string;
  host: string;
  user: string;
  theme: Theme;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [run, setRun] = useState<RunMeta | null>(null);
  const [rows, setRows] = useState<SampleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteSaved, setNoteSaved] = useState(true);
  const [confirmDel, setConfirmDel] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([api.get(id), api.samples(id)]);
      setRun(m.run);
      setRows(s.rows);
      setError(null);
      return m.run;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load().then((m) => m && setNote(m.note));
  }, [load]);

  // Идущее испытание - обновлять отчёт.
  useEffect(() => {
    if (!run || run.endedAt) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [run, load]);

  const charts = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    const xs = rows.map((r) => Number(r[COL.t]));
    const col = (c: number, f: (v: number) => number = (v) => v) =>
      rows.map((r) => (r[c] === null || r[c] === undefined ? null : f(Number(r[c]))));
    const speed: ChartSeries[] = [
      { label: "Задано", data: col(COL.target), color: "--faint", unit: "об/мин", dash: [5, 4] },
      { label: "Двигатель", data: col(COL.rpm, Math.abs), color: "--accent", unit: "об/мин", width: 2 },
      { label: "Датчик №1", data: col(COL.h1), color: "--ok", unit: "об/мин" },
      { label: "Датчик №2", data: col(COL.h2), color: "--accent-hi", unit: "об/мин", dash: [6, 4] },
    ];
    const power: ChartSeries[] = [
      { label: "Ток", data: col(COL.amps), color: "--warn", unit: "А", digits: 2 },
      { label: "Напряжение", data: col(COL.volts), color: "--muted", unit: "В", scale: "v", digits: 1 },
    ];
    // Нарастающие обороты от начала испытания (приращения, обнуление не мешает).
    const cum = (c: number) => {
      let base: number | null = null;
      let acc = 0;
      let prev: number | null = null;
      return rows.map((r) => {
        const v = r[c] === null || r[c] === undefined ? null : Number(r[c]);
        if (v === null) return null;
        if (base === null) base = v;
        if (prev !== null && v >= prev) acc += v - prev;
        prev = v;
        return acc;
      });
    };
    const revs: ChartSeries[] = [
      { label: "Двигатель", data: cum(COL.revs), color: "--accent", unit: "об", width: 2 },
      { label: "Датчик №1", data: cum(COL.h1revs), color: "--ok", unit: "об", digits: 0 },
      { label: "Датчик №2", data: cum(COL.h2revs), color: "--accent-hi", unit: "об", dash: [6, 4], digits: 0 },
    ];
    return { xs, speed, power, revs };
  }, [rows]);

  const saveNote = async () => {
    try {
      await api.note(id, note, user);
      setNoteSaved(true);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!confirmDel) {
      setConfirmDel(true);
      return;
    }
    try {
      await api.remove(id, user, host);
      onChanged();
      onBack();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!run) {
    return (
      <>
        <div className="title">
          <h2>Отчёт об испытании</h2>
          <button className="chip small" onClick={onBack}>
            ← К списку
          </button>
        </div>
        {error ? <div className="warn-line">⚠ {error}</div> : <div className="hint">Загрузка…</div>}
      </>
    );
  }

  const s = run.stats;
  const res = resultLabel(run);
  const events = (run.events ?? []).filter((e) => e.event !== "ack");
  const devText = (avg: number | null, max: number | null) =>
    avg === null ? "–" : `${fmtNum(avg, 2)} (макс. ${max !== null && max > 0 ? "+" : ""}${fmtNum(max ?? 0, 2)})`;

  return (
    <>
      <div className="title no-print">
        <h2>Отчёт об испытании</h2>
        <div className="title-tags">
          <a className="chip small" href={`api/runs/${run.id}/samples?format=csv`}>
            CSV
          </a>
          <button className="chip small" onClick={() => window.print()}>
            Печать / PDF
          </button>
          <button className={`chip small ${confirmDel ? "danger" : ""}`} onClick={remove} onBlur={() => setConfirmDel(false)} disabled={!run.endedAt}>
            {confirmDel ? "Точно удалить?" : "Удалить"}
          </button>
          <button className="chip small" onClick={onBack}>
            ← К списку
          </button>
        </div>
      </div>

      <div className="report print-area">
        <div className="report-head">
          <div>
            <div className="report-title">{runTitle(run)}</div>
            <div className="hint">
              Стенд вращения · {run.host} · {run.startedAtText}
              {run.endedAt ? ` — ${new Date(run.endedAt).toLocaleTimeString("ru-RU")}` : " — идёт"} · {run.id}
            </div>
          </div>
          <span className={`tag ${res.tone}`}>{res.text}</span>
        </div>

        {run.result === "error" && run.error && <div className="alarm-line">⚠ {errorLabel(run.error)}</div>}
        {run.guardOff && (
          <div className="lock-line">Во время испытания автостоп по датчикам Холла был выключен (только предупреждения).</div>
        )}

        <div className="stat-grid">
          <Stat k="Длительность" v={fmtDuration(s.duration_s)} sub={`вращение ${fmtDuration(s.moving_s)}`} />
          <Stat k="Обороты по двигателю" v={fmtNum(s.revs_motor, 2)} />
          <Stat k="Обороты по датчику №1" v={fmtNum(s.revs_h1, 0)} sub={`разница ${fmtNum(s.revs_h1 - s.revs_motor, 1)}`} />
          <Stat k="Обороты по датчику №2" v={fmtNum(s.revs_h2, 0)} sub={`разница ${fmtNum(s.revs_h2 - s.revs_motor, 1)}`} />
          <Stat k="Средняя скорость" v={`${fmtNum(s.rpm_avg, 1)} об/мин`} sub={`задано в среднем ${fmtNum(s.target_avg, 1)}`} />
          <Stat k="Макс. скорость" v={`${fmtNum(s.rpm_max, 1)} об/мин`} />
          <Stat
            k="Датчик №1: ср. / макс."
            v={s.h1_rpm_avg === null ? "–" : `${fmtNum(s.h1_rpm_avg, 1)} / ${fmtNum(s.h1_rpm_max ?? 0, 1)}`}
            sub="об/мин"
          />
          <Stat
            k="Датчик №2: ср. / макс."
            v={s.h2_rpm_avg === null ? "–" : `${fmtNum(s.h2_rpm_avg, 1)} / ${fmtNum(s.h2_rpm_max ?? 0, 1)}`}
            sub="об/мин"
          />
          <Stat k="Расхождение №1 с двигателем" v={devText(s.dev_h1_avg, s.dev_h1_max)} sub="об/мин, на установившейся скорости" />
          <Stat k="Расхождение №2 с двигателем" v={devText(s.dev_h2_avg, s.dev_h2_max)} sub="об/мин, на установившейся скорости" />
          <Stat
            k="Макс. смещение вала"
            v={`${s.lag_h1_max === null ? "–" : fmtNum(s.lag_h1_max, 1) + "°"} / ${s.lag_h2_max === null ? "–" : fmtNum(s.lag_h2_max, 1) + "°"}`}
            sub="датчик №1 / №2"
          />
          <Stat
            k="Ток: ср. / макс."
            v={s.current_avg === null ? "–" : `${fmtNum(s.current_avg, 2)} / ${fmtNum(s.current_max ?? 0, 2)} А`}
            sub={s.voltage_avg === null ? "" : `питание ${fmtNum(s.voltage_avg, 1)} В`}
          />
          <Stat k="Энергия" v={`${fmtNum(s.energy_wh, 2)} Вт·ч`} />
          {run.program && (
            <Stat k="Циклы" v={`${s.cycles_done} из ${run.program.cycles}`} sub={`модулей в цикле: ${run.program.modules}`} />
          )}
          <Stat k="Предупреждения" v={String(s.warnings)} />
          <Stat k="Записей" v={String(s.samples)} sub="~5 в секунду" />
        </div>

        <div className="field">
          <label>Примечание (образец, условия, оператор…)</label>
          <textarea
            className="text-area no-print"
            value={note}
            rows={2}
            onChange={(e) => {
              setNote(e.target.value);
              setNoteSaved(false);
            }}
          />
          <div className="print-only">{note || "—"}</div>
          {!noteSaved && (
            <button className="chip small no-print" onClick={saveNote} style={{ marginTop: 6 }}>
              Сохранить примечание
            </button>
          )}
        </div>

        {charts ? (
          <>
            <RunChart title="Скорость, об/мин" xs={charts.xs} series={charts.speed} theme={theme} height={260} />
            <RunChart
              title="Ток, А (слева) и напряжение, В (справа)"
              xs={charts.xs}
              series={charts.power}
              theme={theme}
              height={180}
              rightScale={VOLT_SCALE}
            />
            <RunChart title="Обороты от начала испытания, об" xs={charts.xs} series={charts.revs} theme={theme} height={180} />
          </>
        ) : (
          <div className="hint">Записей телеметрии нет.</div>
        )}

        {events.length > 0 && (
          <div className="run-events">
            <div className="run-chart-title">События</div>
            {events.map((e, i) => (
              <div key={i} className={`run-ev ev-${e.event}`}>
                <span className="num">{fmtT(e.t_s)}</span>
                <span>{eventText(e.event, e.detail)}</span>
              </div>
            ))}
          </div>
        )}
        {error && <div className="warn-line">⚠ {error}</div>}
      </div>
    </>
  );
}

const VOLT_SCALE = { scale: "v", unit: "В" };

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v num">{v}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function eventText(event: string, detail: string): string {
  switch (event) {
    case "state":
      return `Состояние: ${detail}`;
    case "module": {
      const [c, m] = detail.split(":");
      return `Цикл ${c} · модуль ${m}`;
    }
    case "cycle":
      return `Цикл завершён: ${detail}`;
    case "done":
      return detail === "completed" ? "Программа выполнена" : detail === "aborted" ? "Остановлено оператором" : `Завершено: ${detail}`;
    case "warn": {
      const i = detail.lastIndexOf(":");
      return `Предупреждение: ${guardLabel(i >= 0 ? detail.slice(0, i) : detail, i >= 0 ? Number(detail.slice(i + 1)) : undefined)}`;
    }
    case "error":
      return `АВАРИЯ: ${errorLabel(detail)}`;
    default:
      return `${event} ${detail}`;
  }
}
