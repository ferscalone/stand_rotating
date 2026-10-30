import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Theme } from "../hooks/useTheme";

export interface ChartSeries {
  label: string;
  data: (number | null)[];
  /** CSS-переменная цвета (--accent, --ok, ...). */
  color: string;
  unit: string;
  dash?: number[];
  width?: number;
  scale?: string;
  digits?: number;
}

interface Props {
  title: string;
  /** Время от начала испытания, с. */
  xs: number[];
  series: ChartSeries[];
  theme: Theme;
  height?: number;
  /** Вторая ось справа для этой шкалы. */
  rightScale?: { scale: string; unit: string };
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** График испытания: ось X - время от старта (ч:мм:сс), несколько рядов. */
export function RunChart({ title, xs, series, theme, height = 220, rightScale }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const axis = cssVar("--muted", "#8595a1");
    const grid = cssVar("--grid-line", "rgba(255,255,255,0.05)");
    const opts: uPlot.Options = {
      width: host.clientWidth || 700,
      height,
      scales: { x: { time: false } },
      series: [
        { label: "время", value: (_u, v) => (v == null ? "" : fmtT(v)) },
        ...series.map((s) => ({
          label: s.label,
          scale: s.scale ?? "y",
          stroke: cssVar(s.color, "#3d8bfd"),
          width: s.width ?? 1.5,
          dash: s.dash,
          value: (_u: uPlot, v: number | null) => (v == null ? "–" : `${v.toFixed(s.digits ?? 1)} ${s.unit}`),
        })),
      ],
      axes: [
        { stroke: axis, grid: { stroke: grid }, ticks: { stroke: grid }, values: (_u, sp) => sp.map(fmtT) },
        { scale: "y", stroke: axis, grid: { stroke: grid }, ticks: { stroke: grid }, values: (_u, sp) => sp.map((v) => `${v}`) },
        ...(rightScale
          ? [
              {
                scale: rightScale.scale,
                side: 1 as const,
                stroke: axis,
                grid: { show: false },
                ticks: { stroke: grid },
                values: (_u: uPlot, sp: number[]) => sp.map((v) => `${v}`),
              },
            ]
          : []),
      ],
      legend: { show: true },
      cursor: { drag: { x: true, y: false } },
    };
    const plot = new uPlot(opts, [xs, ...series.map((s) => s.data)] as uPlot.AlignedData, host);
    const ro = new ResizeObserver(() => plot.setSize({ width: host.clientWidth || 700, height }));
    ro.observe(host);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [xs, series, theme, height, rightScale]);

  return (
    <div className="run-chart">
      <div className="run-chart-title">{title}</div>
      <div ref={hostRef} />
    </div>
  );
}

export function fmtT(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p2 = (n: number) => (n < 10 ? "0" : "") + n;
  return h > 0 ? `${h}:${p2(m)}:${p2(r)}` : `${m}:${p2(r)}`;
}
