// ── Запись телеметрии и испытаний ────────────────────────────────────────────
// 1. Регистратор (createRecorder): сервер панели сам держит WebSocket к каждому
//    стенду и получает телеметрию (5 Гц) и события, даже когда ни одна панель не
//    открыта. Стенд принимает не больше 4 WS-подключений - регистратор занимает одно.
// 2. Испытания (createRunStore): прогон от выхода из покоя (ручное вращение или
//    программа) до возврата в IDLE/ERROR - одно испытание. Для каждого пишутся все
//    кадры телеметрии (компактно, массивами), события и статистика; из этого панель
//    строит отчёт с графиками.
//
// Все значения - в РЕАЛЬНЫХ оборотах вала: телеметрия прошивки переводится так же,
// как в панели (src/units.ts). Без внешних зависимостей.

import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// ── Единицы ──────────────────────────────────────────────────────────────────
// Прошивка шлёт обороты в своих единицах (steps_per_rev, сейчас 800 импульсов), вал
// делает оборот за shaft_steps_per_rev (3200 при делении 1/16). Датчики Холла (h1_*,
// h2_*) уже в реальных оборотах.
const SCALED = ["rpm", "target_rpm", "position_rev", "revs_f", "move_revs", "move_target", "cfg_accel_rpm_s", "rpm_min", "rpm_max"];

export function toShaftUnits(t, shaftDefault = 3200) {
  const fw = Number(t.steps_per_rev);
  const shaft = Number(t.shaft_steps_per_rev) || shaftDefault;
  if (!(fw > 0) || !(shaft > 0) || fw === shaft) return t;
  const k = fw / shaft;
  const out = { ...t };
  for (const f of SCALED) if (typeof out[f] === "number") out[f] = out[f] * k;
  if (typeof out.revs_f === "number") out.revs = Math.floor(out.revs_f + 1e-9);
  if (typeof t.total_revs === "number") out.total_revs = Math.floor(t.total_revs * k + 1e-9);
  out.steps_per_rev = shaft;
  return out;
}

// ── Регистратор ──────────────────────────────────────────────────────────────
export function createRecorder({ file, onFrame, onStatusChange }) {
  /** @type {Map<string, any>} */
  const hosts = new Map();
  let closed = false;

  async function load() {
    try {
      const list = JSON.parse(await readFile(file, "utf8"));
      if (Array.isArray(list)) for (const h of list) if (typeof h === "string") ensure(h, false);
    } catch {
      // файла ещё нет
    }
  }

  async function persist() {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify([...hosts.keys()], null, 2), "utf8");
    } catch (e) {
      console.error(`[recorder] не удалось сохранить список стендов: ${e.message}`);
    }
  }

  function connect(h) {
    if (closed) return;
    clearTimeout(h.timer);
    let ws;
    try {
      ws = new WebSocket(`ws://${h.key}/ws`);
    } catch (e) {
      schedule(h, e.message);
      return;
    }
    h.ws = ws;
    h.connecting = true;
    ws.onopen = () => {
      h.connecting = false;
      h.connected = true;
      h.retryMs = 2000;
      h.lastFrameAt = Date.now();
      h.error = null;
      console.log(`[recorder] ${h.key}: подключён, пишу телеметрию`);
      onStatusChange?.(h.key, true);
    };
    ws.onmessage = (m) => {
      h.lastFrameAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(typeof m.data === "string" ? m.data : String(m.data));
      } catch {
        return;
      }
      h.frames++;
      onFrame(h.key, msg);
    };
    ws.onerror = () => {
      // дальше придёт onclose
    };
    ws.onclose = () => {
      if (h.ws !== ws) return;
      const was = h.connected;
      h.connected = false;
      h.connecting = false;
      h.ws = null;
      if (was) {
        console.log(`[recorder] ${h.key}: связь потеряна`);
        onStatusChange?.(h.key, false);
      }
      schedule(h, was ? "связь потеряна" : "не отвечает");
    };
  }

  function schedule(h, why) {
    if (closed || !hosts.has(h.key)) return;
    h.error = why;
    clearTimeout(h.timer);
    h.timer = setTimeout(() => connect(h), h.retryMs);
    h.timer.unref?.();
    h.retryMs = Math.min(h.retryMs * 1.6, 30000);
  }

  function ensure(key, save = true) {
    if (!key || hosts.has(key)) return;
    const h = { key, ws: null, connected: false, connecting: false, retryMs: 2000, timer: null, lastFrameAt: 0, frames: 0, error: null };
    hosts.set(key, h);
    connect(h);
    if (save) void persist();
  }

  function remove(key) {
    const h = hosts.get(key);
    if (!h) return false;
    hosts.delete(key);
    clearTimeout(h.timer);
    try {
      h.ws?.close();
    } catch {
      // игнорируется
    }
    void persist();
    return true;
  }

  // Сторож: «подключён», но кадров нет 10 с - соединение мёртвое.
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const h of hosts.values()) {
      if (h.connected && now - h.lastFrameAt > 10000) {
        try {
          h.ws?.close();
        } catch {
          // игнорируется
        }
      }
    }
  }, 5000);
  watchdog.unref?.();

  function status() {
    return [...hosts.values()].map((h) => ({
      host: h.key,
      connected: h.connected,
      lastFrameAt: h.lastFrameAt || null,
      frames: h.frames,
      error: h.connected ? null : h.error,
    }));
  }

  function isConnected(key) {
    return !!hosts.get(key)?.connected;
  }

  function close() {
    closed = true;
    clearInterval(watchdog);
    for (const h of hosts.values()) {
      clearTimeout(h.timer);
      try {
        h.ws?.close();
      } catch {
        // игнорируется
      }
    }
  }

  return { load, ensure, remove, status, isConnected, close };
}

// ── Испытания ────────────────────────────────────────────────────────────────
const ACTIVE = new Set(["MANUAL", "PROGRAM", "PAUSED", "STOPPING"]);
const RUN_ID_RE = /^r[0-9a-z-]{8,40}$/;

// Колонки кадра испытания (массив на строку - вчетверо компактнее объекта).
export const SAMPLE_COLUMNS = [
  "t_s",
  "state",
  "rpm",
  "target_rpm",
  "h1_rpm",
  "h2_rpm",
  "current_a",
  "voltage_v",
  "revs",
  "h1_revs",
  "h2_revs",
  "prog_cycle",
  "prog_module",
  "h1_bad",
  "h2_bad",
];

const r3 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

function newStats() {
  return {
    duration_s: 0,
    moving_s: 0,
    samples: 0,
    revs_motor: 0,
    revs_h1: 0,
    revs_h2: 0,
    rpm_avg: 0,
    rpm_max: 0,
    target_avg: 0,
    h1_rpm_avg: null,
    h2_rpm_avg: null,
    h1_rpm_max: null,
    h2_rpm_max: null,
    dev_h1_avg: null,
    dev_h1_max: null,
    dev_h2_avg: null,
    dev_h2_max: null,
    current_avg: null,
    current_max: null,
    voltage_avg: null,
    energy_wh: 0,
    warnings: 0,
    cycles_done: 0,
    lag_h1_max: null,
    lag_h2_max: null,
  };
}

export function createRunStore({ dir, retentionDays = 0, sampleMs = 0, fmtTime, onRunChange }) {
  /** @type {Map<string, any>} id -> meta (без событий в списке) */
  const index = new Map();
  /** @type {Map<string, any>} host -> активное испытание */
  const active = new Map();
  /** @type {Map<string, number>} host -> последний uptime (отбрасываем повторы кадров) */
  const lastUptime = new Map();
  let chain = Promise.resolve();
  const queue = (fn) => {
    chain = chain.then(fn).catch((e) => console.error(`[runs] ошибка записи: ${e.message}`));
    return chain;
  };

  const metaFile = (id) => path.join(dir, `${id}.json`);
  const samplesFile = (id) => path.join(dir, `${id}.jsonl`);

  async function saveMeta(meta) {
    await mkdir(dir, { recursive: true });
    const tmp = `${metaFile(meta.id)}.tmp`;
    await writeFile(tmp, JSON.stringify(meta), "utf8");
    await rename(tmp, metaFile(meta.id));
  }

  async function init() {
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(await readFile(path.join(dir, f), "utf8"));
        if (!meta?.id) continue;
        if (!meta.endedAt) {
          // Сервер перезапускался посреди испытания - закрыть по последней записи.
          meta.endedAt = meta.updatedAt || meta.startedAt;
          meta.result = meta.result || "interrupted";
          await saveMeta(meta);
        }
        index.set(meta.id, meta);
      } catch {
        // битый файл - пропускаем
      }
    }
    await prune();
  }

  async function prune() {
    if (!retentionDays) return;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const [id, m] of index) {
      if (m.endedAt && m.endedAt < cutoff) await remove(id);
    }
  }

  function summary(meta) {
    const { events: _e, ...rest } = meta;
    return rest;
  }

  function start(host, t, ts) {
    const d = new Date(ts);
    const p2 = (n) => String(n).padStart(2, "0");
    const id =
      `r${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-` +
      randomBytes(2).toString("hex");
    const run = {
      meta: {
        id,
        host,
        startedAt: ts,
        startedAtText: fmtTime(ts),
        endedAt: null,
        updatedAt: ts,
        kind: t.state === "MANUAL" ? "manual" : "program",
        program: null,
        result: null,
        error: null,
        note: "",
        noteBy: null,
        columns: SAMPLE_COLUMNS,
        stats: newStats(),
        events: [],
        guardOff: false,
      },
      lastTs: ts,
      last: { revs: t.revs_f, h1: t.h1_revs, h2: t.h2_revs },
      acc: { rpm: 0, target: 0, h1: 0, h1n: 0, h2: 0, h2n: 0, dev1: 0, dev1n: 0, dev2: 0, dev2n: 0, cur: 0, curT: 0, volt: 0, voltT: 0 },
      lines: [],
      lastSampleTs: 0,
      lastSaveTs: ts,
      lastDone: null,
    };
    if (t.state === "PROGRAM" || t.state === "PAUSED") setProgram(run, t);
    active.set(host, run);
    index.set(id, run.meta);
    queue(() => saveMeta(run.meta));
    onRunChange?.(host, summary(run.meta), "start");
    return run;
  }

  function setProgram(run, t) {
    if (run.meta.program || !t.prog_name) return;
    run.meta.program = { name: t.prog_name, cycles: t.prog_cycles, modules: t.prog_modules };
    run.meta.kind = "program";
  }

  function accumulate(run, t, ts) {
    const s = run.meta.stats;
    const dt = Math.min(2, Math.max(0, (ts - run.lastTs) / 1000));
    run.lastTs = ts;
    s.duration_s = (ts - run.meta.startedAt) / 1000;
    s.samples++;

    // Обороты: только приращения (обнуление посреди испытания не уменьшает итог).
    const inc = (key, field) => {
      const v = t[field];
      if (typeof v !== "number") return 0;
      const prev = run.last[key];
      run.last[key] = v;
      if (typeof prev !== "number") return 0;
      return v >= prev ? v - prev : 0;
    };
    s.revs_motor += inc("revs", "revs_f");
    s.revs_h1 += inc("h1", "h1_revs");
    s.revs_h2 += inc("h2", "h2_revs");

    const rpm = Math.abs(t.rpm ?? 0);
    const moving = rpm > 0.05;
    const a = run.acc;
    // Установившаяся скорость: двигатель на заданной скорости не меньше 1,5 с и двух
    // оборотов - датчик Холла меряет по прошлому обороту и на рампе запаздывает.
    const target = t.target_rpm ?? 0;
    const onTarget = moving && target > 0 && Math.abs(rpm - target) <= Math.max(0.5, 0.01 * target);
    if (!onTarget) run.steadySince = null;
    else if (run.steadySince == null) run.steadySince = ts;
    const steady = onTarget && ts - run.steadySince >= Math.max(1500, (2 * 60000) / Math.max(rpm, 0.1));
    if (moving && dt > 0) {
      s.moving_s += dt;
      a.rpm += rpm * dt;
      a.target += (t.target_rpm ?? 0) * dt;
      if (rpm > s.rpm_max) s.rpm_max = rpm;
      for (const n of [1, 2]) {
        const hr = t[`h${n}_rpm`];
        if (typeof hr !== "number" || t[`h${n}_st`] === "off") continue;
        a[`h${n}`] += hr * dt;
        a[`h${n}n`] += dt;
        if (s[`h${n}_rpm_max`] === null || hr > s[`h${n}_rpm_max`]) s[`h${n}_rpm_max`] = hr;
        // Расхождение с двигателем - только на установившейся скорости (не на рампе).
        if (steady && hr > 0) {
          const dev = hr - rpm;
          a[`dev${n}`] += Math.abs(dev) * dt;
          a[`dev${n}n`] += dt;
          if (s[`dev_h${n}_max`] === null || Math.abs(dev) > Math.abs(s[`dev_h${n}_max`])) s[`dev_h${n}_max`] = dev;
        }
        const lag = t[`h${n}_lag`];
        if (typeof lag === "number" && (s[`lag_h${n}_max`] === null || Math.abs(lag) > Math.abs(s[`lag_h${n}_max`]))) {
          s[`lag_h${n}_max`] = lag;
        }
      }
      if (t.ina_ok) {
        a.cur += Math.abs(t.current_a ?? 0) * dt;
        a.curT += dt;
      }
    }
    if (t.ina_ok) {
      const c = Math.abs(t.current_a ?? 0);
      if (s.current_max === null || c > s.current_max) s.current_max = c;
      a.volt += (t.voltage_v ?? 0) * dt;
      a.voltT += dt;
      s.energy_wh += (Math.abs(t.power_w ?? 0) * dt) / 3600;
    }
    if (t.hall_guard === 0) run.meta.guardOff = true;
    s.rpm_avg = s.moving_s > 0 ? a.rpm / s.moving_s : 0;
    s.target_avg = s.moving_s > 0 ? a.target / s.moving_s : 0;
    s.h1_rpm_avg = a.h1n > 0 ? a.h1 / a.h1n : null;
    s.h2_rpm_avg = a.h2n > 0 ? a.h2 / a.h2n : null;
    s.dev_h1_avg = a.dev1n > 0 ? a.dev1 / a.dev1n : null;
    s.dev_h2_avg = a.dev2n > 0 ? a.dev2 / a.dev2n : null;
    s.current_avg = a.curT > 0 ? a.cur / a.curT : null;
    s.voltage_avg = a.voltT > 0 ? a.volt / a.voltT : null;
    if (t.prog_cycle > 0 && run.meta.kind === "program") setProgram(run, t);
  }

  function sample(run, t, ts) {
    if (sampleMs > 0 && ts - run.lastSampleTs < sampleMs) return;
    run.lastSampleTs = ts;
    run.lines.push(
      JSON.stringify([
        r3((ts - run.meta.startedAt) / 1000),
        t.state,
        r3(t.rpm),
        r3(t.target_rpm),
        r3(t.h1_rpm ?? null),
        r3(t.h2_rpm ?? null),
        t.ina_ok ? r3(t.current_a) : null,
        t.ina_ok ? r3(t.voltage_v) : null,
        r3(t.revs_f),
        t.h1_revs ?? null,
        t.h2_revs ?? null,
        t.prog_cycle ?? 0,
        t.prog_module ?? 0,
        t.h1_bad ?? null,
        t.h2_bad ?? null,
      ]),
    );
  }

  function flush(run) {
    if (!run.lines.length) return;
    const data = run.lines.join("\n") + "\n";
    run.lines = [];
    const id = run.meta.id;
    queue(async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(samplesFile(id), data, "utf8");
    });
  }

  function finish(host, run, t, ts) {
    active.delete(host);
    const m = run.meta;
    m.endedAt = ts;
    m.updatedAt = ts;
    if (t.state === "ERROR") {
      m.result = "error";
      m.error = t.error || null;
    } else if (run.lastDone) {
      m.result = run.lastDone.startsWith("manual") ? "completed" : run.lastDone;
    } else {
      m.result = "stopped";
    }
    flush(run);
    queue(() => saveMeta(m));
    onRunChange?.(host, summary(m), "end");
  }

  /** Кадр телеметрии (уже в реальных единицах). Вызывается для каждого кадра. */
  function feed(host, t, ts = Date.now()) {
    if (!t || typeof t.uptime_ms !== "number") return;
    const lu = lastUptime.get(host);
    const rebooted = lu !== undefined && t.uptime_ms < lu - 5000;
    if (lu !== undefined && !rebooted && t.uptime_ms <= lu) return; // повтор (другой источник)
    lastUptime.set(host, t.uptime_ms);

    let run = active.get(host);
    if (run && rebooted) {
      finish(host, run, { ...t, state: "ERROR", error: "stand_rebooted" }, ts);
      run = null;
    }
    const isActive = ACTIVE.has(t.state);
    if (!run && isActive) run = start(host, t, ts);
    if (!run) return;
    accumulate(run, t, ts);
    sample(run, t, ts);
    if (run.lines.length >= 25) flush(run);
    if (!isActive) {
      finish(host, run, t, ts);
      return;
    }
    if (ts - run.lastSaveTs > 30000) {
      run.lastSaveTs = ts;
      run.meta.updatedAt = ts;
      queue(() => saveMeta(run.meta));
    }
  }

  /** Событие стенда (после отсева повторов). */
  function event(host, ev, ts = Date.now()) {
    const run = active.get(host);
    if (!run) return;
    const m = run.meta;
    if (m.events.length < 2000) m.events.push({ ts, t_s: r3((ts - m.startedAt) / 1000), event: ev.event, detail: ev.detail });
    if (ev.event === "warn") m.stats.warnings++;
    if (ev.event === "done") run.lastDone = String(ev.detail ?? "");
    if (ev.event === "cycle") {
      const done = Number(String(ev.detail).split("/")[0]);
      if (Number.isFinite(done) && done > m.stats.cycles_done) m.stats.cycles_done = done;
    }
  }

  function list(host) {
    const out = [];
    for (const m of index.values()) if (!host || m.host === host) out.push(summary(m));
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  function get(id) {
    if (!RUN_ID_RE.test(id)) return null;
    return index.get(id) ?? null;
  }

  function isActive(id) {
    for (const r of active.values()) if (r.meta.id === id) return true;
    return false;
  }

  async function remove(id) {
    const m = get(id);
    if (!m || isActive(id)) return false;
    index.delete(id);
    await queue(async () => {
      await rm(metaFile(id), { force: true });
      await rm(samplesFile(id), { force: true });
    });
    return true;
  }

  async function setNote(id, note, user) {
    const m = get(id);
    if (!m) return null;
    m.note = String(note ?? "").slice(0, 2000);
    m.noteBy = user;
    if (!isActive(id)) await queue(() => saveMeta(m));
    return summary(m);
  }

  /**
   * Кадры испытания. max - не больше стольких точек (прореживание с сохранением
   * минимума/максимума скорости в каждом окне), 0 - все.
   */
  async function readSamples(id, max = 0) {
    const m = get(id);
    if (!m) return null;
    const run = [...active.values()].find((r) => r.meta.id === id);
    if (run) flush(run);
    await chain;
    const rows = [];
    try {
      const rl = createInterface({ input: createReadStream(samplesFile(id), "utf8"), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          // обрыв записи
        }
      }
    } catch {
      // файла нет - пустое испытание
    }
    if (!max || rows.length <= max) return rows;
    // Прореживание: в каждом окне - точки с мин. и макс. скоростью (пики не теряются).
    const win = Math.ceil(rows.length / (max / 2));
    const out = [];
    for (let i = 0; i < rows.length; i += win) {
      const chunk = rows.slice(i, i + win);
      let lo = chunk[0];
      let hi = chunk[0];
      for (const r of chunk) {
        if ((r[2] ?? 0) < (lo[2] ?? 0)) lo = r;
        if ((r[2] ?? 0) > (hi[2] ?? 0)) hi = r;
      }
      if (lo === hi) out.push(lo);
      else if (lo[0] <= hi[0]) out.push(lo, hi);
      else out.push(hi, lo);
    }
    return out;
  }

  function activeFor(host) {
    const r = active.get(host);
    return r ? summary(r.meta) : null;
  }

  // Перед остановкой сервера - дописать буферы и сохранить активные испытания.
  async function closeAll() {
    for (const r of active.values()) {
      flush(r);
      r.meta.updatedAt = Date.now();
      queue(() => saveMeta(r.meta));
    }
    await chain;
  }

  const pruneTimer = setInterval(() => void prune(), 6 * 3600_000);
  pruneTimer.unref?.();
  const flushTimer = setInterval(() => {
    for (const r of active.values()) flush(r);
  }, 2000);
  flushTimer.unref?.();

  return { init, feed, event, list, get, remove, setNote, readSamples, activeFor, closeAll, RUN_ID_RE };
}
