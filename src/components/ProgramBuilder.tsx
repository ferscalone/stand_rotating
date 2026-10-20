import { useEffect, useMemo, useRef, useState } from "react";
import { FIRMWARE, LIMITS } from "../config";
import type { Dir, Program, ProgramApplyResponse, ProgramModule, Telemetry } from "../types";
import {
  blendsWithNext,
  coerceProgram,
  emptyProgram,
  fmtDuration,
  fmtNum,
  moduleSeconds,
  newModule,
  sameProgram,
  summarize,
  validateProgram,
} from "../programLogic";
import { uploadAvail } from "../standLogic";
import type { Gate } from "../coord/useCoordinator";
import type { UseLibrary } from "../hooks/useLibrary";
import { gatedAvail, LockTag } from "./LockTag";
import { Stepper } from "./Stepper";

interface Props {
  telemetry: Telemetry | null;
  gate: Gate;
  /** Программа, загруженная сейчас в стенд (null - нет / неизвестно). */
  standProgram: Program | null;
  library: UseLibrary;
  onUpload: (p: Program) => Promise<ProgramApplyResponse | null>;
  onStart: () => void;
  onFetchStand: () => Promise<Program | null>;
}

interface Draft {
  program: Program;
  /** id в библиотеке, если программа открыта оттуда. */
  id: string | null;
}

const DRAFT_KEY = "rotate.program_draft";

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw) as { program?: unknown; id?: unknown };
      const p = coerceProgram(d.program);
      if (p && p.modules.length) return { program: p, id: typeof d.id === "string" ? d.id : null };
    }
  } catch {
    // нет хранилища / битый черновик - начинаем с пустой программы
  }
  return { program: emptyProgram(), id: null };
}

/**
 * Конструктор программ: модули (куда, сколько оборотов, с какой скоростью, пауза
 * после) складываются в цикл, цикл повторяется N раз. Черновик живёт в браузере,
 * готовые программы - в общей библиотеке сервера панели; в стенд программа
 * загружается отдельной кнопкой и хранится в его NVS.
 */
export function ProgramBuilder({ telemetry, gate, standProgram, library, onUpload, onStart, onFetchStand }: Props) {
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const p = draft.program;
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // черновик просто не переживёт перезагрузку
    }
  }, [draft]);

  const setProgram = (fn: (p: Program) => Program) => setDraft((d) => ({ ...d, program: fn(d.program) }));
  const setModule = (i: number, patch: Partial<ProgramModule>) =>
    setProgram((p) => ({ ...p, modules: p.modules.map((m, k) => (k === i ? { ...m, ...patch } : m)) }));
  const moveModule = (i: number, delta: number) =>
    setProgram((p) => {
      const j = i + delta;
      if (j < 0 || j >= p.modules.length) return p;
      const modules = p.modules.slice();
      [modules[i], modules[j]] = [modules[j], modules[i]];
      return { ...p, modules };
    });
  const duplicate = (i: number) =>
    setProgram((p) =>
      p.modules.length >= LIMITS.modulesMax
        ? p
        : { ...p, modules: [...p.modules.slice(0, i + 1), { ...p.modules[i] }, ...p.modules.slice(i + 1)] },
    );
  const removeModule = (i: number) =>
    setProgram((p) => (p.modules.length <= 1 ? p : { ...p, modules: p.modules.filter((_, k) => k !== i) }));
  const addModule = () =>
    setProgram((p) =>
      p.modules.length >= LIMITS.modulesMax ? p : { ...p, modules: [...p.modules, newModule(p.modules[p.modules.length - 1])] },
    );
  // Типовой шаблон: туда N оборотов, пауза, обратно N оборотов, пауза.
  const addSwing = () =>
    setProgram((p) => {
      if (p.modules.length + 2 > LIMITS.modulesMax) return p;
      const base = p.modules[p.modules.length - 1] ?? newModule();
      const there: ProgramModule = { ...base, dir: "cw", pause_ms: base.pause_ms || 1000 };
      const back: ProgramModule = { ...there, dir: "ccw" };
      return { ...p, modules: [...p.modules, there, back] };
    });

  const accel = telemetry?.cfg_accel_rpm_s ?? FIRMWARE.accelRpmS;
  // Сверх общих пределов - потолок скорости, который примет подключённый стенд.
  const standMax = telemetry?.rpm_max;
  const tooFast = standMax ? p.modules.findIndex((m) => m.rpm > standMax + 1e-6) : -1;
  const error =
    validateProgram(p) ??
    (tooFast >= 0 ? `Модуль ${tooFast + 1}: стенд принимает не больше ${fmtNum(standMax!, 1)} об/мин.` : null);
  const sum = useMemo(() => summarize(p, accel), [p, accel]);
  const inStand = sameProgram(p, standProgram);
  const libItem = draft.id ? library.items.find((x) => x.id === draft.id) ?? null : null;
  const savedInLib = libItem ? sameProgram(p, libItem) : false;

  const upload = gatedAvail(uploadAvail(telemetry?.state ?? null), gate);
  const canUpload = upload.enabled && !error && !busy;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const doUpload = (andStart: boolean) =>
    run(andStart ? "upload-start" : "upload", async () => {
      const res = await onUpload(p);
      if (res?.applied) {
        setMsg({ ok: true, text: andStart ? "Загружено в стенд, запуск…" : "Программа загружена в стенд" });
        if (andStart) onStart();
      } else {
        setMsg({ ok: false, text: `Стенд отклонил программу: ${res?.error ?? "нет ответа"}${res?.detail ? ` - ${res.detail}` : ""}` });
      }
    });

  const doSave = (asNew: boolean) =>
    run("save", async () => {
      const res = await library.save({ ...p, id: asNew ? undefined : draft.id ?? undefined });
      if (res.ok && res.program) {
        setDraft((d) => ({ ...d, id: res.program!.id }));
        setMsg({ ok: true, text: `Сохранено в библиотеке: «${res.program.name}»` });
      } else {
        setMsg({ ok: false, text: res.message ?? "Не удалось сохранить" });
      }
    });

  const doFetchStand = () =>
    run("fetch", async () => {
      const sp = await onFetchStand();
      if (sp) {
        setDraft({ program: sp, id: null });
        setMsg({ ok: true, text: "Открыта программа, загруженная в стенд" });
      } else {
        setMsg({ ok: false, text: "В стенде нет программы или он недоступен" });
      }
    });

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${p.name.trim().replace(/[\\/:*?"<>|]+/g, "_") || "program"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = async (file: File) => {
    try {
      const imported = coerceProgram(JSON.parse(await file.text()));
      if (!imported || imported.modules.length === 0) throw new Error("нет модулей");
      setDraft({ program: imported, id: null });
      setMsg({ ok: true, text: `Импортировано из ${file.name}` });
    } catch (e) {
      setMsg({ ok: false, text: `Не удалось импортировать: ${(e as Error).message}` });
    }
  };

  const totalTime = sum.secondsPerCycle || 1;

  return (
    <section className="card col-12">
      <div className="title">
        <h2>Конструктор программ</h2>
        <div className="title-tags">
          {inStand && <span className="tag ok">загружена в стенд</span>}
          {draft.id && <span className={`tag ${savedInLib ? "" : "busy"}`}>{savedInLib ? "в библиотеке" : "есть несохранённые правки"}</span>}
          <LockTag gate={gate} />
        </div>
      </div>

      <div className="builder-grid">
        <div className="builder-main">
          <div className="builder-head">
            <div className="field grow">
              <label>Название</label>
              <input
                className="text-input"
                value={p.name}
                maxLength={LIMITS.nameMax}
                onChange={(e) => setProgram((x) => ({ ...x, name: e.target.value }))}
                placeholder="Например: Ресурс 1000 оборотов"
              />
            </div>
            <div className="field cycles">
              <label>Повторить цикл, раз</label>
              <Stepper value={p.cycles} step={1} onChange={(v) => setProgram((x) => ({ ...x, cycles: Math.max(1, Math.round(v)) }))} />
            </div>
          </div>

          <div className="mod-table">
            <div className="mod-row mod-header">
              <span>№</span>
              <span>Направление</span>
              <span>Оборотов</span>
              <span>Скорость, об/мин</span>
              <span>Пауза после, с</span>
              <span>≈ время</span>
              <span />
            </div>
            {p.modules.map((m, i) => (
              <ModuleRow
                key={i}
                index={i}
                count={p.modules.length}
                m={m}
                blends={blendsWithNext(p, i)}
                seconds={moduleSeconds(m, accel)}
                onChange={(patch) => setModule(i, patch)}
                onMove={(d) => moveModule(i, d)}
                onDuplicate={() => duplicate(i)}
                onRemove={() => removeModule(i)}
              />
            ))}
          </div>

          <div className="btn-row">
            <button className="chip" onClick={addModule} disabled={p.modules.length >= LIMITS.modulesMax}>
              + Модуль
            </button>
            <button className="chip" onClick={addSwing} disabled={p.modules.length + 2 > LIMITS.modulesMax}>
              + Туда-обратно
            </button>
            <span className="hint">
              {p.modules.length} / {LIMITS.modulesMax} модулей. «⟶» - модуль переходит в следующий без остановки
              (пауза 0 и то же направление): скорость меняется на ходу.
            </span>
          </div>

          <div className="timeline" title="Один цикл: ширина - длительность, цвет - направление">
            {p.modules.map((m, i) => {
              const move = moduleSeconds({ ...m, pause_ms: 0 }, accel);
              return (
                <div key={i} className="tl-group" style={{ flexGrow: moduleSeconds(m, accel) / totalTime }}>
                  <div className={`tl-seg ${m.dir}`} style={{ flexGrow: move }} title={`${i + 1}: ${m.dir.toUpperCase()} ${m.revs} об @ ${m.rpm} об/мин`}>
                    {i + 1}
                  </div>
                  {m.pause_ms > 0 && <div className="tl-seg pause" style={{ flexGrow: m.pause_ms / 1000 }} title={`пауза ${m.pause_ms / 1000} с`} />}
                </div>
              );
            })}
          </div>

          <div className="summary">
            <div>
              <span className="k">За цикл</span>
              <span className="v num">
                {fmtNum(sum.revsPerCycle)} об <span className="sub">↻ {fmtNum(sum.cwPerCycle)} · ↺ {fmtNum(sum.ccwPerCycle)}</span>
              </span>
            </div>
            <div>
              <span className="k">Всего</span>
              <span className="v num">{fmtNum(sum.totalRevs)} об</span>
            </div>
            <div>
              <span className="k">Цикл ≈</span>
              <span className="v num">{fmtDuration(sum.secondsPerCycle)}</span>
            </div>
            <div>
              <span className="k">Программа ≈</span>
              <span className="v num">{fmtDuration(sum.totalSeconds)}</span>
            </div>
          </div>
          <div className="hint">Время - оценка по ускорению {fmtNum(accel, 1)} об/мин/с с разгоном и торможением в каждом модуле.</div>

          {error && <div className="warn-line">⚠ {error}</div>}
          {!upload.enabled && <div className="lock-line">В стенд загрузить нельзя: {upload.reason}</div>}

          <div className="btn-row">
            <button className="btn-apply" disabled={!canUpload} onClick={() => doUpload(false)}>
              {busy === "upload" ? "Загрузка…" : "Загрузить в стенд"}
            </button>
            <button className="btn-apply" disabled={!canUpload} onClick={() => doUpload(true)}>
              {busy === "upload-start" ? "Загрузка…" : "▶ Загрузить и запустить"}
            </button>
            <span className="spacer" />
            <button className="chip" disabled={!!busy || !!error} onClick={() => doSave(false)}>
              {draft.id ? "Сохранить" : "Сохранить в библиотеку"}
            </button>
            {draft.id && (
              <button className="chip" disabled={!!busy || !!error} onClick={() => doSave(true)}>
                Сохранить как новую
              </button>
            )}
          </div>

          <div className="btn-row">
            <button className="chip small" onClick={() => setDraft({ program: emptyProgram(), id: null })}>
              Новая
            </button>
            <button className="chip small" disabled={!!busy || !telemetry} onClick={doFetchStand}>
              Открыть из стенда
            </button>
            <button className="chip small" onClick={exportJson}>
              Экспорт JSON
            </button>
            <button className="chip small" onClick={() => fileRef.current?.click()}>
              Импорт JSON
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importJson(f);
                e.target.value = "";
              }}
            />
          </div>

          {msg && <div className={msg.ok ? "note" : "warn-line"}>{msg.ok ? "✓" : "⚠"} {msg.text}</div>}
        </div>

        <aside className="library">
          <div className="lib-head">
            <span className="k">Библиотека</span>
            <button className="chip small" onClick={() => void library.refresh()} disabled={library.loading}>
              {library.loading ? "…" : "Обновить"}
            </button>
          </div>
          {library.error && <div className="warn-line">⚠ {library.error}</div>}
          {!library.error && library.items.length === 0 && <div className="hint">Сохранённых программ пока нет.</div>}
          <div className="lib-list">
            {library.items.map((it) => {
              const s = summarize(it, accel);
              const active = it.id === draft.id;
              return (
                <div key={it.id} className={`lib-item ${active ? "active" : ""}`}>
                  <div className="lib-name">{it.name}</div>
                  <div className="lib-meta">
                    {it.modules.length} мод. × {it.cycles} цикл. · {fmtNum(s.totalRevs)} об · ≈ {fmtDuration(s.totalSeconds)}
                  </div>
                  {it.updatedBy && (
                    <div className="lib-meta">
                      {it.updatedBy}
                      {it.updatedAt ? `, ${new Date(it.updatedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}` : ""}
                    </div>
                  )}
                  <div className="lib-actions">
                    <button
                      className="chip small"
                      onClick={() => {
                        setDraft({ program: { name: it.name, cycles: it.cycles, modules: it.modules.map((m) => ({ ...m })) }, id: it.id });
                        setMsg(null);
                      }}
                    >
                      Открыть
                    </button>
                    <button
                      className={`chip small ${confirmDelete === it.id ? "danger" : ""}`}
                      onClick={async () => {
                        if (confirmDelete !== it.id) {
                          setConfirmDelete(it.id);
                          return;
                        }
                        setConfirmDelete(null);
                        const res = await library.remove(it.id);
                        if (!res.ok) setMsg({ ok: false, text: res.message ?? "Не удалось удалить" });
                        else if (draft.id === it.id) setDraft((d) => ({ ...d, id: null }));
                      }}
                      onBlur={() => setConfirmDelete((c) => (c === it.id ? null : c))}
                    >
                      {confirmDelete === it.id ? "Точно удалить?" : "Удалить"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </section>
  );
}

function ModuleRow({
  index,
  count,
  m,
  blends,
  seconds,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
}: {
  index: number;
  count: number;
  m: ProgramModule;
  blends: boolean;
  seconds: number;
  onChange: (patch: Partial<ProgramModule>) => void;
  onMove: (delta: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const setDir = (dir: Dir) => onChange({ dir });
  return (
    <div className={`mod-row ${m.dir}`}>
      <span className="mod-no">
        {index + 1}
        {blends && <span className="blend" title="Переходит в следующий модуль без остановки">⟶</span>}
      </span>
      <div className="seg compact" data-label="Направление">
        <button className={m.dir === "cw" ? "on" : ""} onClick={() => setDir("cw")} title="По часовой">
          ↻ CW
        </button>
        <button className={m.dir === "ccw" ? "on" : ""} onClick={() => setDir("ccw")} title="Против часовой">
          ↺ CCW
        </button>
      </div>
      <div data-label="Оборотов">
        <Stepper value={m.revs} step={1} onChange={(v) => onChange({ revs: v })} />
      </div>
      <div data-label="Скорость, об/мин">
        <Stepper value={m.rpm} step={5} onChange={(v) => onChange({ rpm: v })} />
      </div>
      <div data-label="Пауза после, с">
        <Stepper
          value={m.pause_ms / 1000}
          step={0.5}
          onChange={(v) => onChange({ pause_ms: Math.max(0, Math.round(v * 1000)) })}
        />
      </div>
      <span className="mod-time num" data-label="≈ время">{fmtDuration(seconds)}</span>
      <div className="mod-actions">
        <button className="icon-btn" disabled={index === 0} onClick={() => onMove(-1)} title="Выше" aria-label="Выше">↑</button>
        <button className="icon-btn" disabled={index === count - 1} onClick={() => onMove(1)} title="Ниже" aria-label="Ниже">↓</button>
        <button className="icon-btn" onClick={onDuplicate} title="Дублировать" aria-label="Дублировать">⧉</button>
        <button className="icon-btn danger" disabled={count <= 1} onClick={onRemove} title="Удалить" aria-label="Удалить">✕</button>
      </div>
    </div>
  );
}
