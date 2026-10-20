import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { SpeedPoint } from "../types";
import type { Theme } from "../hooks/useTheme";

interface Props {
  history: SpeedPoint[];
  theme: Theme;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Скорость (об/мин, со знаком: + по часовой) и ток INA219 во времени. Видно, что
 * разгон и торможение идут по рампе. Цвета - из CSS-переменных темы, поэтому
 * график пересоздаётся при её смене.
 */
export function SpeedChart({ history, theme }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const data = useMemo<uPlot.AlignedData>(() => {
    const n = history.length;
    const xs = new Array<number>(n);
    const rpm = new Array<number | null>(n);
    const amps = new Array<number | null>(n);
    for (let i = 0; i < n; i++) {
      xs[i] = history[i].t;
      rpm[i] = history[i].rpm;
      amps[i] = history[i].amps;
    }
    return [xs, rpm, amps];
  }, [history]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const accent = cssVar("--accent", "#3d8bfd");
    const warn = cssVar("--warn", "#f5b83d");
    const axis = cssVar("--muted", "#8595a1");
    const grid = cssVar("--grid-line", "rgba(255,255,255,0.05)");
    const fill = cssVar("--accent-weak", "rgba(61,139,253,0.14)");

    const opts: uPlot.Options = {
      width: host.clientWidth || 600,
      height: 240,
      scales: {
        x: { time: false },
        rpm: { auto: true, range: (_u, min, max) => sym(min, max, 10) },
        amps: { auto: true, range: (_u, _min, max) => [0, Math.max(0.5, Math.ceil((max ?? 0) * 12) / 10)] },
      },
      series: [
        { label: "t", value: (_u, v) => (v == null ? "" : fmtSecs(v)) },
        {
          label: "Скорость",
          scale: "rpm",
          stroke: accent,
          width: 2,
          fill,
          value: (_u, v) => (v == null ? "–" : `${v.toFixed(1)} об/мин`),
        },
        {
          label: "Ток",
          scale: "amps",
          stroke: warn,
          width: 1.5,
          value: (_u, v) => (v == null ? "–" : `${v.toFixed(2)} А`),
        },
      ],
      axes: [
        { stroke: axis, grid: { stroke: grid }, ticks: { stroke: grid }, values: (_u, s) => s.map(fmtSecs) },
        { scale: "rpm", stroke: axis, grid: { stroke: grid }, ticks: { stroke: grid }, values: (_u, s) => s.map((v) => `${v}`) },
        { scale: "amps", side: 1, stroke: axis, grid: { show: false }, ticks: { stroke: grid }, values: (_u, s) => s.map((v) => `${v} А`) },
      ],
      legend: { show: true },
      cursor: { drag: { x: true, y: false } },
    };

    const plot = new uPlot(opts, data, host);
    plotRef.current = plot;
    const ro = new ResizeObserver(() => plot.setSize({ width: host.clientWidth || 600, height: 240 }));
    ro.observe(host);
    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return (
    <section className="card col-12">
      <div className="title">
        <h2>Скорость и ток во времени</h2>
        <span className="hint">+ по часовой · − против часовой</span>
      </div>
      <div className="chart-host" ref={hostRef} />
      {history.length === 0 && (
        <div className="hint" style={{ marginTop: 8 }}>
          Ожидание телеметрии от стенда…
        </div>
      )}
    </section>
  );
}

// Симметричная шкала скорости вокруг нуля, чтобы направление читалось сразу.
function sym(min: number | null, max: number | null, floor: number): [number, number] {
  const m = Math.max(floor, Math.abs(min ?? 0), Math.abs(max ?? 0));
  const r = Math.ceil(m / 10) * 10;
  return [-r, r];
}

function fmtSecs(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}
