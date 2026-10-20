// Симулятор вращающегося стенда для проверки панели без железа.
// Повторяет протокол прошивки (firmware/src): WebSocket /ws (телеметрия 5 Гц,
// события, текстовые команды) и REST /v1/*. Механика упрощена: скорость меняется
// по рампе с заданным ускорением, программа исполняется теми же правилами, что в
// Controller.cpp (склейка модулей, паузы, пауза/продолжение, плавный стоп).
//
//   node tools/stand-sim.mjs [порт]      (по умолчанию 8090)
//   в шапке панели: localhost:8090
//
// Без зависимостей: минимальный WebSocket-сервер (только текстовые кадры).

import { createHash } from "node:crypto";
import http from "node:http";

const PORT = Number(process.argv[2]) || 8090;
const RPM_MIN = 0.1;
const RPM_MAX = 4000; // как Config::RPM_MAX прошивки
const TICK_MS = 20;

const st = {
  state: "IDLE",
  error: "",
  rpm: 0, // фактическая, со знаком
  targetRpm: 0,
  dir: 1,
  pos: 0, // оборотов, со знаком
  trip: 0,
  total: 1234.5,
  cfg: { accel: 20, limit: 0, hold: true },
  manual: { continuous: true, revs: 0, start: 0, target: null },
  pending: null,
  prog: null, // загруженная
  exec: null, // исполнение
  startedAt: Date.now(),
};

// ── WebSocket ────────────────────────────────────────────────────────────────
const clients = new Set();

function wsSend(sock, text) {
  const payload = Buffer.from(text, "utf8");
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  try {
    sock.write(Buffer.concat([header, payload]));
  } catch {
    clients.delete(sock);
  }
}

function broadcast(obj) {
  const text = JSON.stringify(obj);
  for (const c of clients) wsSend(c, text);
}

function onWsData(sock, buf) {
  sock.acc = sock.acc ? Buffer.concat([sock.acc, buf]) : buf;
  while (sock.acc.length >= 2) {
    const b = sock.acc;
    const op = b[0] & 0x0f;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      len = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    const masked = (b[1] & 0x80) !== 0;
    const need = off + (masked ? 4 : 0) + len;
    if (b.length < need) return;
    let data = b.subarray(off + (masked ? 4 : 0), need);
    if (masked) {
      const mask = b.subarray(off, off + 4);
      data = Buffer.from(data.map((x, i) => x ^ mask[i % 4]));
    }
    sock.acc = b.subarray(need);
    if (op === 0x8) {
      sock.end();
      sock.drop?.();
      return;
    }
    if (op === 0x9) {
      sock.write(Buffer.from([0x8a, 0]));
      continue;
    }
    if (op === 0x1) command(data.toString("utf8").trim());
  }
}

// ── События и команды ────────────────────────────────────────────────────────
const uptime = () => Date.now() - st.startedAt;
const ev = (event, detail) => broadcast({ event, detail, uptime_ms: uptime() });
const ack = (cmd, result) => ev("ack", `${cmd}:${result}`);
function setState(s) {
  if (st.state === s) return;
  st.state = s;
  ev("state", s);
}

function parse(text) {
  const t = text.split(/\s+/).filter(Boolean);
  const cmd = (t[0] ?? "").toLowerCase();
  if (cmd === "run") {
    const dir = t[1] === "cw" ? 1 : t[1] === "ccw" ? -1 : 0;
    const rpm = Number(t[2]);
    const revs = t[3] === undefined ? 0 : Number(t[3]);
    if (!dir || !Number.isFinite(rpm) || !Number.isFinite(revs) || t.length > 4) return null;
    return { type: "RUN", dir, rpm, revs };
  }
  if (cmd === "speed") {
    const rpm = Number(t[1]);
    return Number.isFinite(rpm) && t.length === 2 ? { type: "SPEED", rpm } : null;
  }
  const map = { stop: "STOP", estop: "ESTOP", start: "START", pause: "PAUSE", resume: "RESUME", reset: "RESET", zero: "ZERO" };
  return map[cmd] && t.length === 1 ? { type: map[cmd] } : null;
}

function startManual(dir, rpm, revs) {
  st.manual = { continuous: revs <= 0, revs, start: st.trip, target: revs > 0 ? st.pos + dir * revs : null };
  st.dir = dir;
  st.targetRpm = rpm;
  setState("MANUAL");
}

function command(text) {
  const c = parse(text);
  if (!c) return console.log(`[sim] неизвестная команда "${text}"`);
  console.log(`[sim] ${text}`);
  const s = st.state;
  const ignored = () => ack(c.type, `ignored_${s}`);
  switch (c.type) {
    case "RUN": {
      if (!["IDLE", "MANUAL", "STOPPING"].includes(s) || (s === "STOPPING" && st.exec)) return ignored();
      if (!(c.rpm >= RPM_MIN && c.rpm <= RPM_MAX)) return ack("RUN", "bad_rpm");
      if (c.revs < 0 || (c.revs > 0 && c.revs < 0.01)) return ack("RUN", "bad_revs");
      const moving = Math.abs(st.rpm) > 1e-6;
      if (s === "STOPPING" || (moving && c.revs > 0 && Math.sign(st.rpm) !== c.dir)) {
        st.pending = c;
        setState("STOPPING");
        return ack("RUN", "ok_after_stop");
      }
      startManual(c.dir, c.rpm, c.revs);
      return ack("RUN", "ok");
    }
    case "SPEED":
      if (s !== "MANUAL") return ignored();
      if (!(c.rpm >= RPM_MIN && c.rpm <= RPM_MAX)) return ack("SPEED", "bad_rpm");
      st.targetRpm = c.rpm;
      return ack("SPEED", "ok");
    case "STOP":
      if (s === "MANUAL" || s === "PROGRAM") {
        st.pending = null;
        setState("STOPPING");
        return ack("STOP", "ok");
      }
      if (s === "PAUSED") {
        ack("STOP", "ok");
        st.exec = null;
        ev("done", "aborted");
        return setState("IDLE");
      }
      return ignored();
    case "ESTOP":
      st.rpm = 0;
      st.exec = null;
      st.pending = null;
      st.error = "estop";
      ev("error", "estop");
      setState("ERROR");
      return ack("ESTOP", "ok");
    case "RESET":
      if (s !== "ERROR") return ignored();
      st.error = "";
      setState("IDLE");
      return ack("RESET", "ok");
    case "ZERO":
      if (s !== "IDLE") return ignored();
      st.pos = 0;
      st.trip = 0;
      return ack("ZERO", "ok");
    case "START": {
      if (s !== "IDLE") return ignored();
      if (!st.prog) return ack("START", "no_program");
      st.exec = { p: structuredClone(st.prog), cycle: 0, mod: 0, phase: "MOVE", start: st.pos, dwellUntil: 0, dwellLeft: 0, progress: 0 };
      setState("PROGRAM");
      ack("START", "ok");
      return beginModule();
    }
    case "PAUSE": {
      const e = st.exec;
      if (s !== "PROGRAM" || !e || (e.phase !== "MOVE" && e.phase !== "DWELL")) return ignored();
      if (e.phase === "DWELL") {
        e.dwellLeft = Math.max(0, e.dwellUntil - Date.now());
        e.inDwell = true;
        e.phase = "PAUSED";
        setState("PAUSED");
      } else {
        e.inDwell = false;
        e.phase = "PAUSING";
      }
      return ack("PAUSE", "ok");
    }
    case "RESUME": {
      const e = st.exec;
      if (s !== "PAUSED" || !e) return ignored();
      setState("PROGRAM");
      ack("RESUME", "ok");
      if (e.inDwell) {
        e.phase = "DWELL";
        e.dwellUntil = Date.now() + e.dwellLeft;
      } else {
        e.phase = "MOVE";
        emitModule();
      }
      return;
    }
  }
}

// ── Программа ────────────────────────────────────────────────────────────────
const cur = () => st.exec.p.modules[st.exec.mod];
const dirOf = (m) => (m.dir === "cw" ? 1 : -1);
function nextIdx(e) {
  let mod = e.mod + 1;
  let cycle = e.cycle;
  if (mod >= e.p.modules.length) {
    mod = 0;
    cycle++;
  }
  return { cycle, mod, more: cycle < e.p.cycles };
}
function blends(e) {
  const m = e.p.modules[e.mod];
  if (m.pause_ms > 0) return false;
  const n = nextIdx(e);
  return n.more && e.p.modules[n.mod].dir === m.dir;
}
function emitModule() {
  const e = st.exec;
  ev("module", `${e.cycle + 1}/${e.p.cycles}:${e.mod + 1}/${e.p.modules.length}`);
}
function advance() {
  const e = st.exec;
  const n = nextIdx(e);
  if (n.cycle !== e.cycle) ev("cycle", `${n.cycle}/${e.p.cycles}`);
  if (!n.more) return false;
  e.cycle = n.cycle;
  e.mod = n.mod;
  return true;
}
function beginModule() {
  const e = st.exec;
  e.start = st.pos;
  e.end = st.pos + dirOf(cur()) * cur().revs;
  st.dir = dirOf(cur());
  st.targetRpm = cur().rpm;
  e.phase = "MOVE";
  emitModule();
}
function finishModule() {
  const e = st.exec;
  if (cur().pause_ms > 0) {
    e.phase = "DWELL";
    e.dwellUntil = Date.now() + cur().pause_ms;
  } else advanceAndBegin();
}
function advanceAndBegin() {
  if (!advance()) {
    st.exec.progress = 1;
    st.exec.done = true;
    ev("done", "completed");
    setState("IDLE");
    return;
  }
  beginModule();
}
// Конец цепочки склеенных модулей - туда планируется торможение.
function chainEnd() {
  const e = st.exec;
  let end = e.end;
  const probe = { ...e };
  while (blends(probe)) {
    const n = nextIdx(probe);
    probe.cycle = n.cycle;
    probe.mod = n.mod;
    end += dirOf(e.p.modules[n.mod]) * e.p.modules[n.mod].revs;
  }
  return end;
}

// ── Физика ───────────────────────────────────────────────────────────────────
// Скорость тянется к цели с ускорением cfg.accel; при движении к точке
// остановки скорость ограничивается так, чтобы успеть затормозить.
function stepPhysics(dt) {
  const a = st.cfg.accel; // об/мин за с
  let want = 0;
  let stopAt = null;
  const s = st.state;
  if (s === "MANUAL") {
    want = st.dir * st.targetRpm;
    if (!st.manual.continuous) stopAt = st.manual.target;
  } else if (s === "PROGRAM" && st.exec?.phase === "MOVE") {
    want = st.dir * st.targetRpm;
    stopAt = chainEnd();
  }
  if (stopAt !== null) {
    const dist = (stopAt - st.pos) * Math.sign(want || 1); // оборотов до остановки
    const vmax = Math.sqrt(Math.max(0, 2 * (a / 60) * Math.max(0, dist))) * 60; // об/мин
    if (Math.abs(want) > vmax) want = Math.sign(want) * vmax;
  }
  const dv = a * dt;
  if (st.rpm < want) st.rpm = Math.min(want, st.rpm + dv);
  else st.rpm = Math.max(want, st.rpm - dv);
  const d = (st.rpm / 60) * dt;
  // Шаг перескакивает точку остановки (или уже почти в ней) - встать ровно в неё.
  const crosses = stopAt !== null && d !== 0 && Math.sign(stopAt - st.pos) !== Math.sign(stopAt - st.pos - d);
  if (stopAt !== null && (crosses || (Math.abs(st.rpm) < 0.5 && Math.abs(stopAt - st.pos) < 0.01))) {
    st.trip += Math.abs(stopAt - st.pos);
    st.total += Math.abs(stopAt - st.pos);
    st.pos = stopAt;
    st.rpm = 0;
  } else {
    st.pos += d;
    st.trip += Math.abs(d);
    st.total += Math.abs(d);
  }
}

function tick() {
  stepPhysics(TICK_MS / 1000);
  const stopped = Math.abs(st.rpm) < 1e-3;
  const s = st.state;
  if (s === "MANUAL" && !st.manual.continuous && stopped && Math.abs(st.pos - st.manual.target) < 0.011) {
    ev("done", `manual:${st.manual.revs.toFixed(2)}`);
    setState("IDLE");
  } else if (s === "STOPPING" && stopped) {
    if (st.exec && !st.exec.done) {
      st.exec = { ...st.exec, aborted: true, phase: "-" };
      ev("done", "aborted");
      setState("IDLE");
    } else if (st.pending) {
      const p = st.pending;
      st.pending = null;
      startManual(p.dir, p.rpm, p.revs);
    } else setState("IDLE");
  } else if (s === "PROGRAM" && st.exec) {
    const e = st.exec;
    if (e.phase === "MOVE" || e.phase === "PAUSING") {
      for (let g = 0; g <= e.p.modules.length; g++) {
        if ((st.pos - e.end) * dirOf(cur()) < -1e-9 || !blends(e)) break;
        advance();
        e.start = e.end;
        e.end = e.start + dirOf(cur()) * cur().revs;
        if (e.phase === "MOVE") {
          st.targetRpm = cur().rpm;
          emitModule();
        }
      }
      if (e.phase === "MOVE" && stopped && (st.pos - e.end) * dirOf(cur()) > -0.011) finishModule();
      if (e.phase === "PAUSING" && stopped) {
        e.phase = "PAUSED";
        setState("PAUSED");
      }
    } else if (e.phase === "DWELL" && Date.now() >= e.dwellUntil) advanceAndBegin();
  }
  if (s === "PAUSED" && st.exec?.phase === "PAUSED" && !st.exec.inDwell) {
    // остановились ровно на конце модуля - продолжение начнёт следующий
  }
  // Ток: холостой + пропорционально скорости + бросок при разгоне.
  st.amps = (st.cfg.hold || !stopped ? 0.35 : 0.02) + Math.abs(st.rpm) * 0.006 + (Math.random() - 0.5) * 0.02;
  if (st.cfg.limit > 0 && st.amps > st.cfg.limit && st.state !== "ERROR") {
    st.rpm = 0;
    st.exec = null;
    st.error = "overcurrent";
    ev("error", "overcurrent");
    setState("ERROR");
  }
}

function telemetry() {
  const e = st.exec;
  const progView = e && (st.state === "PROGRAM" || st.state === "PAUSED" || (st.state === "STOPPING" && !e.done));
  let moveRevs = 0;
  let moveTarget = 0;
  if (progView) {
    moveRevs = Math.min(Math.abs(st.pos - e.start), cur().revs);
    moveTarget = cur().revs;
    const per = e.p.modules.reduce((a, m) => a + m.revs, 0);
    const before = e.p.modules.slice(0, e.mod).reduce((a, m) => a + m.revs, 0);
    e.progress = (per * e.cycle + before + moveRevs) / (per * e.p.cycles);
  } else if (st.state === "MANUAL" || st.state === "STOPPING") {
    moveRevs = st.trip - st.manual.start;
    moveTarget = st.manual.continuous ? 0 : st.manual.revs;
  }
  const shown = progView ? e.p : st.prog;
  return {
    state: st.state,
    phase: e && progView ? (e.phase === "PAUSED" || e.phase === "PAUSING" || e.phase === "DWELL" || e.phase === "MOVE" ? e.phase : "-") : "-",
    error: st.state === "ERROR" ? st.error : "",
    rpm: round(st.rpm, 2),
    target_rpm: round(st.targetRpm, 2),
    dir: st.dir > 0 ? "cw" : "ccw",
    continuous: st.state === "MANUAL" && st.manual.continuous ? 1 : 0,
    position_rev: round(st.pos, 3),
    revs: Math.floor(st.trip + 1e-9),
    revs_f: round(st.trip, 3),
    total_revs: Math.floor(st.total),
    move_revs: round(moveRevs, 3),
    move_target: round(moveTarget, 3),
    prog_loaded: st.prog ? 1 : 0,
    prog_name: shown?.name ?? "",
    prog_cycle: e ? e.cycle + 1 : 0,
    prog_cycles: shown?.cycles ?? 0,
    prog_module: e ? e.mod + 1 : 0,
    prog_modules: shown?.modules.length ?? 0,
    prog_progress: round(e?.progress ?? 0, 4),
    dwell_left_ms: e?.phase === "DWELL" ? Math.max(0, e.dwellUntil - Date.now()) : e?.phase === "PAUSED" && e.inDwell ? e.dwellLeft : 0,
    ina_ok: 1,
    current_a: round(st.amps ?? 0, 3),
    voltage_v: 24.1,
    power_w: round((st.amps ?? 0) * 24.1, 2),
    driver_en: st.cfg.hold || Math.abs(st.rpm) > 0 ? 1 : 0,
    cfg_accel_rpm_s: st.cfg.accel,
    cfg_current_limit_a: st.cfg.limit,
    cfg_hold_idle: st.cfg.hold ? 1 : 0,
    rpm_min: RPM_MIN,
    rpm_max: RPM_MAX,
    steps_per_rev: 800,
    uptime_ms: uptime(),
  };
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// ── HTTP ─────────────────────────────────────────────────────────────────────
function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

function parseModules(text) {
  const out = [];
  for (const part of text.split(";").filter(Boolean)) {
    const [dir, revs, rpm, pause] = part.split(":");
    if (dir !== "cw" && dir !== "ccw") return [null, "bad direction"];
    const m = { dir, revs: Number(revs), rpm: Number(rpm), pause_ms: Number(pause) };
    if (!(m.revs >= 0.01)) return [null, "revs out of range"];
    if (!(m.rpm >= RPM_MIN && m.rpm <= RPM_MAX)) return [null, "rpm out of range"];
    if (!Number.isInteger(m.pause_ms) || m.pause_ms < 0) return [null, "bad pause"];
    out.push(m);
  }
  return out.length ? [out, null] : [null, "no modules"];
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const params = new URLSearchParams(url.search);
    for (const [k, v] of new URLSearchParams(body)) if (!params.has(k)) params.set(k, v);
    const busy = !["IDLE", "ERROR"].includes(st.state);
    switch (`${req.method} ${url.pathname}`) {
      case "GET /v1/health":
        return send(res, 200, { status: "ok", uptime_ms: uptime() });
      case "GET /v1/status":
        return send(res, 200, telemetry());
      case "POST /v1/command": {
        const c = parse(params.get("cmd") ?? "");
        if (!c) return send(res, 400, { error: "unknown command" });
        command(params.get("cmd"));
        return send(res, 200, { accepted: c.type });
      }
      case "POST /v1/config": {
        const accel = Number(params.get("accel_rpm_s"));
        const limit = Number(params.get("current_limit_a"));
        const hold = params.get("hold_idle");
        if (!(accel >= 1 && accel <= 1000) || !(limit >= 0 && limit <= 3.2) || (hold !== "0" && hold !== "1")) {
          return send(res, 400, { error: "invalid", detail: "out of range" });
        }
        if (busy) return send(res, 409, { error: "busy", detail: "stand must be stopped" });
        st.cfg = { accel, limit, hold: hold === "1" };
        return send(res, 200, { applied: { accel_rpm_s: accel, current_limit_a: limit, hold_idle: hold === "1" ? 1 : 0 } });
      }
      case "GET /v1/program":
        return st.prog ? send(res, 200, st.prog) : send(res, 404, { error: "no program" });
      case "POST /v1/program": {
        const cycles = Number(params.get("cycles"));
        const [modules, err] = parseModules(params.get("modules") ?? "");
        if (!modules) return send(res, 400, { error: "invalid", detail: err });
        if (!Number.isInteger(cycles) || cycles < 1) return send(res, 400, { error: "invalid", detail: "cycles out of range" });
        if (busy) return send(res, 409, { error: "busy", detail: "stand must be stopped" });
        st.prog = { name: (params.get("name") || "program").replace(/["\\\u0000-\u001f]/g, "").slice(0, 47), cycles, modules };
        return send(res, 200, { applied: st.prog });
      }
      default:
        res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
        return res.end();
    }
  });
});

server.on("upgrade", (req, sock) => {
  if (new URL(req.url, "http://x").pathname !== "/ws") return sock.destroy();
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  clients.add(sock);
  console.log(`[sim] WS подключён (клиентов: ${clients.size})`);
  const drop = () => {
    if (clients.delete(sock)) console.log(`[sim] WS отключён (клиентов: ${clients.size})`);
  };
  sock.drop = drop;
  sock.on("data", (b) => onWsData(sock, b));
  sock.on("close", drop);
  sock.on("end", drop);
  sock.on("error", drop);
});

setInterval(tick, TICK_MS);
setInterval(() => broadcast(telemetry()), 200);
server.listen(PORT, () => console.log(`[sim] стенд вращения: http://localhost:${PORT}  (в панели: localhost:${PORT})`));
