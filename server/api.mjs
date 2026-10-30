// ── Сервер координации панели ────────────────────────────────────────────────
// Панель - тонкий клиент, который сам ходит к стенду (WebSocket + REST). Этот
// модуль добавляет то, что нельзя сделать в одном браузере:
//
//   1. Канал управления (блокировка). Управлять стендом одновременно может только
//      один человек. Остальные видят телеметрию, но кнопки у них заблокированы.
//      Канал можно занять, освободить, передать другому зрителю или попросить у
//      владельца. Канал освобождается сам, если владелец долго бездействует,
//      закрыл вкладку или не ответил на запрос и при этом ничего не делал.
//   2. Журнал. Действия людей (канал, команды, параметры) и события стенда
//      пишутся на диск в logs/<дата>/journal.jsonl, телеметрия (с прореживанием) -
//      в logs/<дата>/telemetry_<стенд>.jsonl. Архив можно скачать из панели в CSV.
//   3. Библиотека программ вращения (только у панели вращающегося стенда): общий
//      для всех операторов список программ в data/programs.json.
//   4. Регистратор и испытания (runs.mjs): сервер сам подключается к стенду и пишет
//      телеметрию и испытания (logs/runs/), даже когда ни одна панель не открыта.
//
// Транспорт: Server-Sent Events (сервер -> браузер) + JSON POST (браузер ->
// сервер). Ни одной внешней зависимости - только стандартная библиотека Node.
//
// Канал и журнал - те же, что в dashboard1/dashboard2 (держать в синхроне);
// библиотека программ есть только здесь.
// Подключается и в dev-сервер Vite (vite.config.ts), и в боевой server/index.mjs.

import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createRecorder, createRunStore, SAMPLE_COLUMNS, toShaftUnits } from "./runs.mjs";

// ── Настройки (переменные окружения) ─────────────────────────────────────────
function envNum(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function resolveTz(tz) {
  try {
    new Intl.DateTimeFormat("sv-SE", { timeZone: tz });
    return tz;
  } catch {
    console.warn(`[coord] неизвестный часовой пояс "${tz}", использую UTC`);
    return "UTC";
  }
}

export function loadOptions(overrides = {}) {
  return {
    logDir: path.resolve(process.env.LOG_DIR || "logs"),
    // Каталог библиотеки программ (programs.json).
    dataDir: path.resolve(process.env.DATA_DIR || "data"),
    tz: resolveTz(process.env.LOG_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    // Бездействие владельца, после которого канал освобождается сам (0 - никогда).
    idleTimeoutMs: envNum("LOCK_IDLE_TIMEOUT_S", 600) * 1000,
    // Сколько ждать владельца, закрывшего вкладку / потерявшего сеть (перезагрузка
    // страницы укладывается в это окно и управление не теряется).
    graceMs: envNum("LOCK_DISCONNECT_GRACE_S", 45) * 1000,
    // Сколько владелец может молчать в ответ на запрос. Если за это время он ничего
    // не сделал - канал передаётся запросившему автоматически.
    requestTimeoutMs: envNum("LOCK_REQUEST_TIMEOUT_S", 60) * 1000,
    // За сколько до авто-освобождения предупредить владельца.
    warnBeforeMs: 60_000,
    // Шаг записи телеметрии в журнал (0 - телеметрию не писать).
    telemetryIntervalMs: envNum("LOG_TELEMETRY_INTERVAL_MS", 1000),
    // Сколько дней хранить журналы (0 - хранить всё).
    retentionDays: envNum("LOG_RETENTION_DAYS", 180),
    // Регистратор: сервер сам держит WebSocket к стенду и пишет телеметрию/испытания.
    recorder: process.env.RECORDER !== "0",
    // Стенды, которые писать всегда (через запятую: IP или имя[:порт]).
    recordHosts: (process.env.RECORD_HOSTS || "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    // Начинать запись стенда, как только его открыли в панели.
    recordAuto: process.env.RECORD_AUTO !== "0",
    // Шаг записи кадров испытания, мс (0 - каждый кадр, ~5 Гц).
    runSampleMs: envNum("RUN_SAMPLE_MS", 0),
    // Сколько дней хранить испытания (0 - всегда).
    runRetentionDays: envNum("RUN_RETENTION_DAYS", 0),
    // Реальных импульсов на оборот вала, если прошивка их не сообщает (1/16 шага).
    shaftStepsPerRev: envNum("SHAFT_STEPS_PER_REV", 3200),
    ...overrides,
  };
}

// ── Время ────────────────────────────────────────────────────────────────────
function makeClock(tz) {
  const f = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  // sv-SE даёт "2026-09-27 19:16:57" - сразу ISO-подобный локальный формат.
  return (ms) => {
    const s = f.format(new Date(ms));
    return { day: s.slice(0, 10), full: `${s}.${String(ms % 1000).padStart(3, "0")}` };
  };
}

// ── Журнал на диске ──────────────────────────────────────────────────────────
// Записи дописываются строго по очереди (цепочка промисов), чтобы строки не
// перемешивались. Ошибка записи не роняет сервер - пишется в консоль один раз.
class Journal {
  constructor(dir, clock) {
    this.dir = dir;
    this.clock = clock;
    this.chain = Promise.resolve();
    this.madeDirs = new Set();
    this.failing = false;
  }

  write(file, entry) {
    const ts = entry.ts ?? Date.now();
    const { day, full } = this.clock(ts);
    const line = JSON.stringify({ time: full, ...entry, ts }) + "\n";
    const dir = path.join(this.dir, day);
    this.chain = this.chain
      .then(async () => {
        if (!this.madeDirs.has(dir)) {
          await mkdir(dir, { recursive: true });
          this.madeDirs.add(dir);
        }
        await appendFile(path.join(dir, `${file}.jsonl`), line, "utf8");
        if (this.failing) console.warn("[coord] запись журнала восстановлена");
        this.failing = false;
      })
      .catch((e) => {
        this.madeDirs.delete(dir);
        if (!this.failing) console.error(`[coord] не удалось записать журнал: ${e.message}`);
        this.failing = true;
      });
  }

  async prune(retentionDays) {
    if (!retentionDays) return;
    const cutoff = this.clock(Date.now() - retentionDays * 86_400_000).day;
    let days;
    try {
      days = await readdir(this.dir);
    } catch {
      return;
    }
    for (const d of days) {
      if (DAY_RE.test(d) && d < cutoff) {
        await rm(path.join(this.dir, d), { recursive: true, force: true }).catch(() => {});
        this.madeDirs.delete(path.join(this.dir, d));
      }
    }
  }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.jsonl$/;
const HOST_RE = /^[a-z0-9.\-_:[\]]{1,120}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** Ключ стенда: тот же адрес, что в шапке панели, в нижнем регистре. */
function normHost(raw) {
  if (typeof raw !== "string") return null;
  const h = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  return HOST_RE.test(h) ? h : null;
}

function cleanName(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
}

const fileSafe = (host) => host.replace(/[^a-z0-9.-]/g, "_");

const fmtDuration = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} с` : `${Math.round(ms / 60_000)} мин`);

// ── HTTP-помощники ───────────────────────────────────────────────────────────
function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("слишком большой запрос"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(Object.assign(new Error("некорректный JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// CSV под русский Excel: разделитель ";", десятичная запятая, BOM для UTF-8.
function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v).replace(".", ",");
  if (typeof v === "object") v = JSON.stringify(v);
  const s = String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function* readJsonl(file) {
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // битая строка (например, обрыв записи при выключении) - пропускаем
    }
  }
}


// ── Библиотека программ ──────────────────────────────────────────────────────
// Программа: { id, name, cycles, modules: [{ dir: "cw"|"ccw", revs, rpm, pause_ms }],
// note, updatedAt, updatedBy }. Пределы повторяют Config.h прошивки; окончательную
// проверку при загрузке в стенд всё равно делает прошивка.
const PROGRAM_LIMITS = {
  modulesMax: 64,
  cyclesMax: 1_000_000,
  revsMin: 0.01,
  revsMax: 1_000_000,
  rpmMin: 0.1,
  rpmMax: 4000,
  pauseMsMax: 3_600_000,
  libraryMax: 500,
};

function cleanProgram(raw) {
  if (!raw || typeof raw !== "object") return [null, "Некорректные данные программы"];
  const name = cleanName(String(raw.name ?? ""));
  if (!name) return [null, "Укажите название программы"];
  const cycles = Number(raw.cycles);
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > PROGRAM_LIMITS.cyclesMax) {
    return [null, `Число циклов: целое от 1 до ${PROGRAM_LIMITS.cyclesMax}`];
  }
  if (!Array.isArray(raw.modules) || raw.modules.length === 0 || raw.modules.length > PROGRAM_LIMITS.modulesMax) {
    return [null, `Нужно от 1 до ${PROGRAM_LIMITS.modulesMax} модулей`];
  }
  const modules = [];
  for (const [i, m] of raw.modules.entries()) {
    const dir = m?.dir === "ccw" ? "ccw" : m?.dir === "cw" ? "cw" : null;
    const revs = Number(m?.revs);
    const rpm = Number(m?.rpm);
    const pause = Number(m?.pause_ms ?? 0);
    const bad = (what) => [null, `Модуль ${i + 1}: ${what}`];
    if (!dir) return bad("направление cw/ccw");
    if (!Number.isFinite(revs) || revs < PROGRAM_LIMITS.revsMin || revs > PROGRAM_LIMITS.revsMax) {
      return bad("обороты вне диапазона");
    }
    if (!Number.isFinite(rpm) || rpm < PROGRAM_LIMITS.rpmMin || rpm > PROGRAM_LIMITS.rpmMax) {
      return bad("скорость вне диапазона");
    }
    if (!Number.isInteger(pause) || pause < 0 || pause > PROGRAM_LIMITS.pauseMsMax) return bad("пауза вне диапазона");
    modules.push({ dir, revs, rpm, pause_ms: pause });
  }
  const note = String(raw.note ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .slice(0, 500);
  return [{ name, cycles, modules, note }, null];
}

class ProgramLibrary {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "programs.json");
    this.items = null;
    this.chain = Promise.resolve();
  }

  async load() {
    if (this.items) return this.items;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      this.items = Array.isArray(data) ? data.filter((p) => p && typeof p.id === "string") : [];
    } catch {
      this.items = [];
    }
    return this.items;
  }

  // Запись через временный файл + rename, строго по очереди: файл не бывает
  // недописанным даже при выключении посреди сохранения.
  persist() {
    const snapshot = JSON.stringify(this.items, null, 2);
    this.chain = this.chain
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.file);
      })
      .catch((e) => console.error(`[coord] не удалось сохранить библиотеку программ: ${e.message}`));
    return this.chain;
  }

  async list() {
    return [...(await this.load())].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }

  async upsert(raw, user) {
    const [clean, err] = cleanProgram(raw);
    if (!clean) return [400, { ok: false, error: "invalid", message: err }];
    const items = await this.load();
    const id = typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : null;
    const existing = id ? items.find((p) => p.id === id) : null;
    const now = Date.now();
    let saved;
    if (existing) {
      Object.assign(existing, clean, { updatedAt: now, updatedBy: user });
      saved = existing;
    } else {
      if (items.length >= PROGRAM_LIMITS.libraryMax) {
        return [409, { ok: false, error: "full", message: "Библиотека переполнена - удалите ненужные программы" }];
      }
      saved = { id: "p" + randomBytes(9).toString("hex"), ...clean, createdAt: now, updatedAt: now, updatedBy: user };
      items.push(saved);
    }
    await this.persist();
    return [200, { ok: true, program: saved, created: !existing }];
  }

  async remove(id) {
    const items = await this.load();
    const idx = items.findIndex((p) => p.id === id);
    if (idx === -1) return [404, { ok: false, error: "not_found", message: "Программа не найдена" }];
    const [gone] = items.splice(idx, 1);
    await this.persist();
    return [200, { ok: true, program: gone }];
  }
}

function runResultText(m) {
  switch (m.result) {
    case "completed":
      return "выполнено";
    case "aborted":
      return "остановлено оператором";
    case "error":
      return `авария${m.error ? ": " + m.error : ""}`;
    case "interrupted":
      return "прервана запись";
    default:
      return "остановлено";
  }
}

const fmtRevs = (v) => (Math.round((v ?? 0) * 100) / 100).toLocaleString("ru-RU");

// ── Координатор ──────────────────────────────────────────────────────────────
export function createApi(overrides = {}) {
  const opt = loadOptions(overrides);
  const clock = makeClock(opt.tz);
  const journal = new Journal(opt.logDir, clock);
  const library = new ProgramLibrary(opt.dataDir);
  const startedAt = Date.now();

  // Испытания и регистратор. Записи «испытание начато/завершено» видят все зрители.
  const runs = createRunStore({
    dir: path.join(opt.logDir, "runs"),
    retentionDays: opt.runRetentionDays,
    sampleMs: opt.runSampleMs,
    fmtTime: (ms) => clock(ms).full.slice(0, 19),
    onRunChange: (host, meta, what) => {
      const name = meta.program?.name ? `программа «${meta.program.name}»` : "ручное вращение";
      const text =
        what === "start"
          ? `Испытание начато: ${name}`
          : `Испытание завершено (${runResultText(meta)}): ${name}, ${fmtRevs(meta.stats.revs_motor)} об за ${fmtDuration(meta.stats.duration_s * 1000)}`;
      record(hostState(host), "run", text, { run: meta.id });
    },
  });
  void runs.init();
  const recorder = opt.recorder
    ? createRecorder({
        file: path.join(opt.dataDir, "recorder-hosts.json"),
        onFrame: (key, msg) => {
          if (msg && typeof msg === "object" && "event" in msg) ingestEvent(key, msg);
          else if (msg && typeof msg === "object" && "state" in msg) {
            ingestTelemetry(key, toShaftUnits(msg, opt.shaftStepsPerRev), Date.now());
          }
        },
        onStatusChange: (key, connected) => {
          journal.write("journal", {
            ts: Date.now(),
            host: key,
            kind: "recorder",
            text: connected ? "Регистратор сервера подключился к стенду" : "Регистратор сервера потерял связь со стендом",
          });
        },
      })
    : null;
  if (recorder) {
    void recorder.load().then(() => {
      for (const h of opt.recordHosts) {
        const key = normHost(h);
        if (key) recorder.ensure(key);
      }
    });
  }

  // ── Приём телеметрии и событий: от браузеров (doReport) и от регистратора ────
  // Событие стенда видят все зрители и регистратор - пишем его один раз. Ключ
  // включает uptime_ms стенда, поэтому одинаковые события в разное время различаются.
  function ingestEvent(key, it) {
    const hs = hostState(key);
    const ev = String(it.event ?? "").slice(0, 32);
    const detail = String(it.detail ?? "").slice(0, 160);
    const k = `${ev}|${detail}|${it.uptime_ms}`;
    if (hs.seenEvents.has(k)) return;
    hs.seenEvents.set(k, Date.now());
    if (hs.seenEvents.size > 500) hs.seenEvents.delete(hs.seenEvents.keys().next().value);
    record(hs, "stand", detail ? `${ev.toUpperCase()} · ${detail}` : ev.toUpperCase(), {
      event: ev,
      detail,
      uptime_ms: it.uptime_ms,
    });
    runs.event(key, { event: ev, detail });
  }

  // Телеметрия (в реальных единицах): каждый кадр - в испытание, в суточный файл -
  // с прореживанием до шага записи.
  function ingestTelemetry(key, t, ts) {
    if (!t || typeof t !== "object" || typeof t.uptime_ms !== "number") return;
    runs.feed(key, t, ts);
    if (!opt.telemetryIntervalMs) return;
    const hs = hostState(key);
    const last = hs.lastTeleUptime;
    // Кадры от нескольких источников: пишем только если стенд ушёл вперёд на шаг
    // записи. Скачок назад больше чем на 5 с - стенд перезагрузился.
    const rebooted = last !== null && t.uptime_ms < last - 5000;
    if (last === null || rebooted || t.uptime_ms - last >= opt.telemetryIntervalMs * 0.8) {
      hs.lastTeleUptime = t.uptime_ms;
      const row = {};
      for (const [k2, v] of Object.entries(t)) {
        if (typeof v === "number" || typeof v === "string" || typeof v === "boolean" || v === null) row[k2] = v;
      }
      journal.write(`telemetry_${fileSafe(key)}`, { ts, host: key, ...row });
    }
  }

  /** @type {Map<string, any>} ключ стенда -> состояние канала */
  const hosts = new Map();

  function hostState(key) {
    let hs = hosts.get(key);
    if (!hs) {
      hs = {
        key,
        clients: new Map(), // clientId -> { clientId, name, streams:Set, standConnected, joinedAt }
        owner: null, // { clientId, name, since, lastActive, warned, disconnectedAt }
        requests: [], // { clientId, name, at, deadline }
        seenEvents: new Map(), // ключ события стенда -> ts (дедупликация между зрителями)
        lastTeleUptime: null,
        emptySince: null,
      };
      hosts.set(key, hs);
    }
    return hs;
  }

  // ── Журнал + рассылка ──────────────────────────────────────────────────────
  // kind: lock | cmd | config | warn | program | run | stand | conn | presence | recorder
  // Записи lock/cmd/config/warn дополнительно рассылаются зрителям стенда, чтобы
  // у всех в экранном журнале было видно, кто что сделал.
  const BROADCAST_KINDS = new Set(["lock", "cmd", "config", "warn", "program", "run"]);

  function record(hs, kind, text, extra = {}) {
    const entry = { ts: Date.now(), host: hs.key, kind, text, ...extra };
    journal.write("journal", entry);
    if (BROADCAST_KINDS.has(kind)) broadcast(hs, { type: "journal", entry });
  }

  function writeSse(res, msg) {
    try {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    } catch {
      // поток уже закрыт - его уберёт обработчик close
    }
  }

  function broadcast(hs, msg) {
    for (const c of hs.clients.values()) for (const s of c.streams) writeSse(s, msg);
  }

  function notify(hs, clientId, payload) {
    const c = hs.clients.get(clientId);
    if (!c) return;
    for (const s of c.streams) writeSse(s, { type: "notify", ...payload });
  }

  function snapshot(hs) {
    const o = hs.owner;
    let expiresAt = null;
    let expireReason = null;
    if (o) {
      if (o.disconnectedAt) {
        expiresAt = o.disconnectedAt + opt.graceMs;
        expireReason = "disconnect";
      } else if (opt.idleTimeoutMs > 0) {
        expiresAt = o.lastActive + opt.idleTimeoutMs;
        expireReason = "idle";
      }
    }
    return {
      type: "state",
      host: hs.key,
      serverNow: Date.now(),
      owner: o
        ? {
            clientId: o.clientId,
            name: o.name,
            since: o.since,
            lastActive: o.lastActive,
            online: !o.disconnectedAt,
            expiresAt,
            expireReason,
          }
        : null,
      viewers: [...hs.clients.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((c) => ({ clientId: c.clientId, name: c.name, standConnected: c.standConnected })),
      requests: hs.requests.map((r) => ({ clientId: r.clientId, name: r.name, at: r.at, deadline: r.deadline })),
    };
  }

  function publish(hs) {
    broadcast(hs, snapshot(hs));
  }

  const who = (name) => name || "без имени";

  // ── Операции канала ────────────────────────────────────────────────────────
  function grant(hs, clientId, name, how, from) {
    const now = Date.now();
    hs.owner = { clientId, name, since: now, lastActive: now, warned: false, disconnectedAt: null };
    hs.requests = hs.requests.filter((r) => r.clientId !== clientId);
    notify(hs, clientId, { kind: "granted", how, from: from ?? null });
  }

  /** Освободить канал и отдать его первому в очереди запросивших (если он ещё здесь). */
  function releaseOwner(hs, reasonText) {
    const prev = hs.owner;
    hs.owner = null;
    record(hs, "lock", reasonText, { user: prev?.name, client: prev?.clientId, action: "release" });
    const queue = hs.requests.filter((r) => hs.clients.has(r.clientId));
    hs.requests = [];
    const next = queue.shift();
    if (next) {
      grant(hs, next.clientId, next.name, "queue", prev?.name);
      record(hs, "lock", `Управление передано по очереди запросов: ${who(next.name)}`, {
        user: next.name,
        client: next.clientId,
        action: "grant",
      });
      for (const r of queue) notify(hs, r.clientId, { kind: "request-dropped", owner: next.name });
    }
  }

  function transfer(hs, toId, how) {
    const prev = hs.owner;
    const target = hs.clients.get(toId);
    if (!prev || !target) return false;
    grant(hs, target.clientId, target.name, how, prev.name);
    const suffix =
      how === "timeout" ? " (владелец не ответил на запрос)" : how === "offline" ? " (владелец не в сети)" : "";
    record(hs, "lock", `Управление передано: ${who(prev.name)} → ${who(target.name)}${suffix}`, {
      user: prev.name,
      client: prev.clientId,
      to: target.name,
      action: "transfer",
    });
    if (prev.clientId !== target.clientId) notify(hs, prev.clientId, { kind: "transferred", to: target.name, how });
    return true;
  }

  function touchOwner(hs) {
    if (!hs.owner) return;
    hs.owner.lastActive = Date.now();
    hs.owner.warned = false;
  }

  // ── Действия от браузера ───────────────────────────────────────────────────
  function doAction(body) {
    const key = normHost(body.host);
    const clientId = typeof body.clientId === "string" && ID_RE.test(body.clientId) ? body.clientId : null;
    if (!key || !clientId) return [400, { ok: false, error: "bad_request", message: "Некорректный запрос" }];
    const hs = hostState(key);
    const me = hs.clients.get(clientId);
    if (!me) return [409, { ok: false, error: "not_connected", message: "Нет соединения с сервером координации" }];
    const name = cleanName(body.name) || me.name;
    const owner = hs.owner;
    const isOwner = owner?.clientId === clientId;
    const needName = () => [400, { ok: false, error: "no_name", message: "Сначала укажите своё имя" }];

    switch (body.action) {
      case "rename": {
        me.name = name;
        if (isOwner) owner.name = name;
        for (const r of hs.requests) if (r.clientId === clientId) r.name = name;
        break;
      }
      case "acquire": {
        if (!name) return needName();
        me.name = name;
        if (isOwner) {
          touchOwner(hs);
          break;
        }
        if (owner) {
          return [409, { ok: false, error: "busy", message: `Канал уже занят: ${who(owner.name)}` }];
        }
        grant(hs, clientId, name, "acquire");
        record(hs, "lock", `Управление занято: ${who(name)}`, { user: name, client: clientId, action: "acquire" });
        break;
      }
      case "release": {
        if (!isOwner) return [409, { ok: false, error: "not_owner", message: "Вы не управляете стендом" }];
        releaseOwner(hs, `Управление освобождено: ${who(owner.name)}`);
        break;
      }
      case "extend": {
        if (!isOwner) return [409, { ok: false, error: "not_owner", message: "Вы не управляете стендом" }];
        touchOwner(hs);
        break;
      }
      case "request": {
        if (!name) return needName();
        me.name = name;
        if (!owner) {
          // Пока шёл запрос, канал освободился - просто занять его.
          grant(hs, clientId, name, "acquire");
          record(hs, "lock", `Управление занято: ${who(name)}`, { user: name, client: clientId, action: "acquire" });
          break;
        }
        if (isOwner) break;
        const now = Date.now();
        const existing = hs.requests.find((r) => r.clientId === clientId);
        if (existing) {
          // Повторное напоминание не чаще раза в 15 с, срок ответа не продлевается.
          if (now - (existing.remindedAt ?? existing.at) < 15_000) {
            return [429, { ok: false, error: "too_often", message: "Запрос уже отправлен, подождите ответа" }];
          }
          existing.remindedAt = now;
        } else {
          hs.requests.push({ clientId, name, at: now, deadline: now + opt.requestTimeoutMs });
          record(hs, "lock", `Запрос управления: ${who(name)} (сейчас управляет ${who(owner.name)})`, {
            user: name,
            client: clientId,
            action: "request",
          });
        }
        // Владелец не в сети - ждать его ответа бессмысленно.
        if (owner.disconnectedAt) {
          transfer(hs, clientId, "offline");
          break;
        }
        notify(hs, owner.clientId, { kind: "request", from: { clientId, name }, deadline: now + opt.requestTimeoutMs });
        break;
      }
      case "transfer": {
        if (!isOwner) return [409, { ok: false, error: "not_owner", message: "Вы не управляете стендом" }];
        const to = typeof body.target === "string" ? body.target : "";
        if (to === clientId) break;
        if (!hs.clients.has(to)) {
          return [409, { ok: false, error: "no_target", message: "Этот человек уже закрыл панель" }];
        }
        transfer(hs, to, "manual");
        break;
      }
      case "decline": {
        if (!isOwner) return [409, { ok: false, error: "not_owner", message: "Вы не управляете стендом" }];
        const from = typeof body.target === "string" ? body.target : "";
        const r = hs.requests.find((x) => x.clientId === from);
        hs.requests = hs.requests.filter((x) => x.clientId !== from);
        // Отказ - это тоже реакция владельца: он на месте.
        touchOwner(hs);
        if (r) {
          record(hs, "lock", `Запрос управления отклонён. Просил(а): ${who(r.name)}, отклонил(а): ${who(owner.name)}`, {
            user: owner.name,
            client: owner.clientId,
            to: r.name,
            action: "decline",
          });
          notify(hs, r.clientId, { kind: "declined", by: owner.name });
        }
        break;
      }
      case "cancel-request": {
        hs.requests = hs.requests.filter((x) => x.clientId !== clientId);
        break;
      }
      default:
        return [400, { ok: false, error: "bad_action", message: "Неизвестное действие" }];
    }
    publish(hs);
    return [200, { ok: true }];
  }

  // ── Отчёты браузеров (журнал) ─────────────────────────────────────────────
  function doReport(body) {
    const key = normHost(body.host);
    const clientId = typeof body.clientId === "string" && ID_RE.test(body.clientId) ? body.clientId : null;
    if (!key || !clientId || !Array.isArray(body.items)) return [400, { ok: false }];
    const hs = hostState(key);
    const me = hs.clients.get(clientId);
    const name = me?.name || cleanName(body.name);
    let changed = false;

    for (const it of body.items.slice(0, 1000)) {
      if (!it || typeof it !== "object") continue;
      switch (it.type) {
        case "event":
          ingestEvent(key, it);
          break;
        case "telemetry":
          // Панель присылает телеметрию уже в реальных единицах.
          ingestTelemetry(key, it.t, typeof it.ts === "number" ? it.ts : Date.now());
          break;
        case "cmd":
        case "config": {
          const text = String(it.text ?? "").slice(0, 300);
          const isOwner = hs.owner?.clientId === clientId;
          if (isOwner) touchOwner(hs);
          record(
            hs,
            isOwner ? it.type : "warn",
            `${who(name)}: ${text}${isOwner ? "" : " [отправлено без права управления]"}`,
            { user: name, client: clientId, ok: it.ok !== false },
          );
          changed = changed || isOwner;
          break;
        }
        case "conn": {
          const connected = it.connected === true;
          if (me && me.standConnected !== connected) {
            me.standConnected = connected;
            changed = true;
          }
          record(hs, "conn", `${who(name)}: ${connected ? "связь со стендом установлена" : "связь со стендом потеряна"}`, {
            user: name,
            client: clientId,
          });
          break;
        }
        default:
          break;
      }
    }
    if (changed) publish(hs);
    return [200, { ok: true }];
  }

  // ── Поток SSE ──────────────────────────────────────────────────────────────
  function openStream(req, res, url) {
    const key = normHost(url.searchParams.get("host"));
    const clientId = url.searchParams.get("clientId");
    if (!key || !clientId || !ID_RE.test(clientId)) {
      sendJson(res, 400, { ok: false, error: "bad_request" });
      return;
    }
    const name = cleanName(url.searchParams.get("name") ?? "");
    const resume = url.searchParams.get("resume") === "1";

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    req.socket.setKeepAlive?.(true);
    req.socket.setNoDelay?.(true);

    const hs = hostState(key);
    hs.emptySince = null;
    // Стенд открыли в панели - регистратор начинает его писать (и после перезапуска
    // сервера продолжит, даже если панель закрыта).
    if (recorder && opt.recordAuto) recorder.ensure(key);
    let c = hs.clients.get(clientId);
    const isNew = !c;
    if (!c) {
      c = { clientId, name, streams: new Set(), standConnected: false, joinedAt: Date.now() };
      hs.clients.set(clientId, c);
    } else if (name) {
      c.name = name;
    }
    c.streams.add(res);

    if (isNew) record(hs, "presence", `Панель открыта: ${who(c.name)}`, { user: c.name, client: clientId });

    // Владелец вернулся (перезагрузка страницы / короткий обрыв сети).
    if (hs.owner?.clientId === clientId && hs.owner.disconnectedAt) {
      hs.owner.disconnectedAt = null;
      record(hs, "lock", `Владелец снова на связи: ${who(hs.owner.name)}`, { user: hs.owner.name, client: clientId });
    }
    // Сервер только что перезапустился и потерял состояние - вернуть канал тому,
    // кто им владел, если его никто не успел занять.
    if (resume && !hs.owner && Date.now() - startedAt < 60_000 && c.name) {
      grant(hs, clientId, c.name, "resume");
      record(hs, "lock", `Управление восстановлено после перезапуска сервера: ${who(c.name)}`, {
        user: c.name,
        client: clientId,
        action: "resume",
      });
    }

    writeSse(res, {
      type: "hello",
      clientId,
      config: {
        idleTimeoutMs: opt.idleTimeoutMs,
        graceMs: opt.graceMs,
        requestTimeoutMs: opt.requestTimeoutMs,
        warnBeforeMs: opt.warnBeforeMs,
        telemetryIntervalMs: opt.telemetryIntervalMs,
      },
    });
    publish(hs);

    const onClose = () => {
      c.streams.delete(res);
      if (c.streams.size > 0) return;
      hs.clients.delete(clientId);
      record(hs, "presence", `Панель закрыта: ${who(c.name)}`, { user: c.name, client: clientId });
      hs.requests = hs.requests.filter((r) => r.clientId !== clientId);
      if (hs.owner?.clientId === clientId) hs.owner.disconnectedAt = Date.now();
      if (hs.clients.size === 0) hs.emptySince = Date.now();
      publish(hs);
    };
    req.on("close", onClose);
  }

  // ── Архив журналов ─────────────────────────────────────────────────────────
  async function listLogs(res) {
    let days = [];
    try {
      days = (await readdir(opt.logDir)).filter((d) => DAY_RE.test(d)).sort().reverse().slice(0, 120);
    } catch {
      // каталога ещё нет - архив пуст
    }
    const out = [];
    for (const day of days) {
      const files = [];
      try {
        for (const f of (await readdir(path.join(opt.logDir, day))).sort()) {
          if (!FILE_RE.test(f)) continue;
          const st = await stat(path.join(opt.logDir, day, f));
          files.push({ name: f, size: st.size });
        }
      } catch {
        continue;
      }
      if (files.length) out.push({ day, files });
    }
    sendJson(res, 200, { ok: true, tz: opt.tz, days: out });
  }

  async function downloadLog(res, day, file, format) {
    if (!DAY_RE.test(day) || !FILE_RE.test(file)) {
      sendJson(res, 400, { ok: false });
      return;
    }
    const full = path.join(opt.logDir, day, file);
    try {
      await stat(full);
    } catch {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    const base = `${day}_${file.replace(/\.jsonl$/, "")}`;
    if (format !== "csv") {
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="${base}.jsonl"`,
      });
      createReadStream(full).pipe(res);
      return;
    }

    // Колонки: для журнала - фиксированные, для телеметрии - объединение ключей
    // всех строк (разная прошивка может присылать разный набор полей).
    let cols;
    if (file === "journal.jsonl") {
      cols = ["time", "host", "kind", "user", "text"];
    } else {
      const keys = new Set(["time"]);
      for await (const row of readJsonl(full)) for (const k of Object.keys(row)) if (k !== "ts") keys.add(k);
      cols = [...keys];
    }
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}.csv"`,
    });
    res.write("﻿" + cols.join(";") + "\r\n");
    for await (const row of readJsonl(full)) {
      const line = cols.map((k) => (k === "time" ? row.time ?? "" : csvCell(row[k]))).join(";") + "\r\n";
      if (!res.write(line)) await new Promise((r) => res.once("drain", r));
    }
    res.end();
  }

  // ── Таймеры ────────────────────────────────────────────────────────────────
  const tick = setInterval(() => {
    const now = Date.now();
    for (const hs of hosts.values()) {
      let changed = false;
      const o = hs.owner;
      if (o) {
        if (o.disconnectedAt && now - o.disconnectedAt >= opt.graceMs) {
          releaseOwner(hs, `Управление освобождено автоматически (владелец закрыл панель): ${who(o.name)}`);
          changed = true;
        } else if (!o.disconnectedAt && opt.idleTimeoutMs > 0) {
          const left = o.lastActive + opt.idleTimeoutMs - now;
          if (left <= 0) {
            notify(hs, o.clientId, { kind: "expired" });
            releaseOwner(
              hs,
              `Управление освобождено автоматически (нет действий ${fmtDuration(opt.idleTimeoutMs)}): ${who(o.name)}`,
            );
            changed = true;
          } else if (left <= opt.warnBeforeMs && !o.warned) {
            o.warned = true;
            notify(hs, o.clientId, { kind: "expiring", expiresAt: o.lastActive + opt.idleTimeoutMs });
          }
        }
      }
      // Просроченные запросы: владелец молчал и ничего не делал - передать канал.
      for (const r of [...hs.requests]) {
        if (r.deadline > now) continue;
        hs.requests = hs.requests.filter((x) => x !== r);
        const cur = hs.owner;
        if (cur && cur.lastActive < r.at && hs.clients.has(r.clientId)) {
          transfer(hs, r.clientId, "timeout");
        } else {
          notify(hs, r.clientId, { kind: "request-expired", owner: cur?.name ?? null });
        }
        changed = true;
      }
      if (changed) publish(hs);
      // Забыть стенды, на которые давно никто не смотрит.
      if (
        !hs.owner &&
        hs.clients.size === 0 &&
        hs.emptySince &&
        now - hs.emptySince > 10 * 60_000 &&
        !recorder?.isConnected(hs.key)
      ) {
        hosts.delete(hs.key);
      }
    }
  }, 1000);

  // Комментарий-пинг держит соединение живым через прокси и быстрее выявляет
  // оборванные вкладки.
  const ping = setInterval(() => {
    for (const hs of hosts.values())
      for (const c of hs.clients.values())
        for (const s of c.streams) {
          try {
            s.write(": ping\n\n");
          } catch {
            // игнорируется
          }
        }
  }, 20_000);

  journal.prune(opt.retentionDays);
  const prune = setInterval(() => journal.prune(opt.retentionDays), 6 * 3600_000);
  tick.unref?.();
  ping.unref?.();
  prune.unref?.();

  // ── Маршрутизация ──────────────────────────────────────────────────────────
  // Путь сопоставляется по хвосту ".../api/...", чтобы работало и при раздаче
  // панели из под-пути за обратным прокси.
  const API_RE = /(?:^|\/)api\/(.+)$/;

  /** Обработать запрос, если он к API. Возвращает false, если это не API. */
  function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://local");
    const m = API_RE.exec(url.pathname);
    if (!m) return false;
    const route = m[1];
    const fail = (e) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, e.status ?? 500, { ok: false, error: "server_error", message: e.message });
    };

    if (route === "health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, uptime_ms: Date.now() - startedAt, tz: opt.tz });
    } else if (route === "stream" && req.method === "GET") {
      openStream(req, res, url);
    } else if (route === "action" && req.method === "POST") {
      readJson(req)
        .then((b) => {
          const [code, body] = doAction(b);
          sendJson(res, code, body);
        })
        .catch(fail);
    } else if (route === "report" && req.method === "POST") {
      readJson(req, 1024 * 1024)
        .then((b) => {
          const [code, body] = doReport(b);
          sendJson(res, code, body);
        })
        .catch(fail);
    } else if (route === "logs" && req.method === "GET") {
      listLogs(res).catch(fail);
    } else if (route.startsWith("logs/") && req.method === "GET") {
      const [, day, file] = route.split("/");
      downloadLog(res, day ?? "", file ?? "", url.searchParams.get("format")).catch(fail);
    } else if (route === "recorder" && req.method === "GET") {
      sendJson(res, 200, { ok: true, enabled: !!recorder, hosts: recorder?.status() ?? [] });
    } else if (route === "recorder" && req.method === "POST") {
      readJson(req)
        .then((b) => {
          const key = normHost(b.host);
          if (!recorder || !key) return sendJson(res, 400, { ok: false, error: "bad_request" });
          if (b.enabled === false) recorder.remove(key);
          else recorder.ensure(key);
          sendJson(res, 200, { ok: true, hosts: recorder.status() });
        })
        .catch(fail);
    } else if (route === "runs" && req.method === "GET") {
      const key = url.searchParams.get("host") ? normHost(url.searchParams.get("host")) : null;
      sendJson(res, 200, { ok: true, runs: runs.list(key), active: key ? runs.activeFor(key) : null, tz: opt.tz });
    } else if (route.startsWith("runs/")) {
      const [, id, sub] = route.split("/");
      const meta = runs.get(id ?? "");
      if (!meta) {
        sendJson(res, 404, { ok: false, error: "not_found", message: "Испытание не найдено" });
      } else if (!sub && req.method === "GET") {
        sendJson(res, 200, { ok: true, run: meta });
      } else if (sub === "samples" && req.method === "GET") {
        const max = Math.min(Number(url.searchParams.get("max")) || 0, 200_000);
        const format = url.searchParams.get("format");
        runs
          .readSamples(id, format === "csv" ? 0 : max)
          .then((rows) => {
            if (format !== "csv") {
              sendJson(res, 200, { ok: true, columns: SAMPLE_COLUMNS, startedAt: meta.startedAt, rows: rows ?? [] });
              return;
            }
            const name = `${meta.id}${meta.program?.name ? "_" + meta.program.name.replace(/[^\p{L}\p{N}_-]+/gu, "_") : ""}`;
            res.writeHead(200, {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.csv`,
            });
            res.write("\uFEFF" + ["time", ...SAMPLE_COLUMNS].join(";") + "\r\n");
            for (const r of rows ?? []) {
              const time = clock(meta.startedAt + Math.round((r[0] ?? 0) * 1000)).full;
              res.write([time, ...r.map(csvCell)].join(";") + "\r\n");
            }
            res.end();
          })
          .catch(fail);
      } else if (sub === "note" && req.method === "POST") {
        readJson(req)
          .then(async (b) => {
            const user = cleanName(b.user) || "без имени";
            const m = await runs.setNote(id, b.note, user);
            journal.write("journal", {
              ts: Date.now(),
              host: meta.host,
              kind: "run",
              user,
              text: `${user}: примечание к испытанию ${id}: ${String(b.note ?? "").slice(0, 200)}`,
            });
            sendJson(res, 200, { ok: true, run: m });
          })
          .catch(fail);
      } else if (!sub && req.method === "DELETE") {
        const user = cleanName(url.searchParams.get("user") ?? "") || "без имени";
        runs
          .remove(id)
          .then((ok) => {
            if (ok) {
              journal.write("journal", {
                ts: Date.now(),
                host: meta.host,
                kind: "run",
                user,
                text: `${user}: испытание ${id} удалено`,
              });
            }
            sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { ok: false, message: "Идёт сейчас - удалить нельзя" });
          })
          .catch(fail);
      } else {
        sendJson(res, 404, { ok: false, error: "not_found" });
      }
    } else if (route === "programs" && req.method === "GET") {
      library
        .list()
        .then((items) => sendJson(res, 200, { ok: true, programs: items }))
        .catch(fail);
    } else if (route === "programs" && req.method === "POST") {
      readJson(req)
        .then(async (b) => {
          const user = cleanName(b.user) || "без имени";
          const [code, body] = await library.upsert(b.program, user);
          if (body.ok) {
            const hs = normHost(b.host);
            const text = `${user}: программа «${body.program.name}» ${body.created ? "добавлена в библиотеку" : "сохранена в библиотеке"}`;
            if (hs) record(hostState(hs), "program", text, { user });
            else journal.write("journal", { ts: Date.now(), host: "-", kind: "program", user, text });
          }
          sendJson(res, code, body);
        })
        .catch(fail);
    } else if (route.startsWith("programs/") && req.method === "DELETE") {
      const id = route.slice("programs/".length);
      if (!ID_RE.test(id)) {
        sendJson(res, 400, { ok: false, error: "bad_request" });
        return true;
      }
      const user = cleanName(url.searchParams.get("user") ?? "") || "без имени";
      library
        .remove(id)
        .then(([code, body]) => {
          if (body.ok) {
            const hs = normHost(url.searchParams.get("host"));
            const text = `${user}: программа «${body.program.name}» удалена из библиотеки`;
            if (hs) record(hostState(hs), "program", text, { user });
            else journal.write("journal", { ts: Date.now(), host: "-", kind: "program", user, text });
          }
          sendJson(res, code, body);
        })
        .catch(fail);
    } else {
      sendJson(res, 404, { ok: false, error: "not_found" });
    }
    return true;
  }

  function close() {
    recorder?.close();
    void runs.closeAll();
    clearInterval(tick);
    clearInterval(ping);
    clearInterval(prune);
    for (const hs of hosts.values())
      for (const c of hs.clients.values())
        for (const s of c.streams) {
          try {
            s.end();
          } catch {
            // игнорируется
          }
        }
  }

  return { handle, close, options: opt };
}
