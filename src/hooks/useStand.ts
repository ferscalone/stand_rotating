import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { httpBase, wsUrl } from "../config";
import {
  isEvent,
  isTelemetry,
  type Command,
  type ConfigApplyResponse,
  type ConnStatus,
  type Program,
  type ProgramApplyResponse,
  type SpeedPoint,
  type StandSettings,
  type StandEvent,
  type Telemetry,
} from "../types";
import { ackReason, errorLabel, guardLabel, stateMeta } from "../standLogic";
import { coerceProgram, toFirmwareForm } from "../programLogic";
import { commandToFirmware, defaultRevFactor, programScale, revFactor, telemetryToShaft } from "../units";
import type { StandObserver } from "../coord/useCoordinator";

// Одна запись в экранном журнале событий.
export interface LogEntry {
  id: number;
  ts: number; // время по часам клиента, мс
  kind: "state" | "cycle" | "module" | "done" | "error" | "warn" | "sys" | "cmd" | "ack" | "lock" | "user";
  text: string;
}

/** Предупреждение автоматического контроля: код (hall1_mismatch, ...) и значение. */
export interface GuardWarning {
  ts: number;
  code: string;
  value: number;
}

export interface UseStand {
  status: ConnStatus;
  telemetry: Telemetry | null;
  /** Скользящая история скорости и тока для графика (от старых к новым). */
  history: SpeedPoint[];
  log: LogEntry[];
  /** Последнее предупреждение контроля вращения (автостоп выключен) - для карточки датчиков. */
  lastWarn: GuardWarning | null;
  /** Отправить текстовый кадр команды по WS (при закрытом сокете - откат на REST). */
  send: (cmd: Command) => void;
  /** POST параметров стенда (ускорение, порог тока, удержание, датчики Холла). */
  sendConfig: (s: StandSettings) => Promise<ConfigApplyResponse | null>;
  /** Загрузить программу в стенд (POST /v1/program, сохраняется в NVS). */
  uploadProgram: (p: Program) => Promise<ProgramApplyResponse | null>;
  /** Прочитать загруженную в стенд программу (GET /v1/program). */
  fetchProgram: () => Promise<Program | null>;
  /** Принудительно выполнить немедленное (пере)подключение к `host`. */
  reconnect: () => void;
  /** Добавить строку в экранный журнал (например, действия других людей). */
  note: (kind: LogEntry["kind"], text: string) => void;
}

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 15000;
// Попытка подключения, которая за этот бюджет не открывается и не закрывается,
// считается неудачной и разрывается, чтобы не висеть на ~40-секундном TCP-таймауте
// браузера (что выглядит для оператора как застывшая строка "Подключение…").
const CONNECT_TIMEOUT = 6000;
// Скользящее окно графика. При ~5 Гц 900 точек ≈ 3 минуты истории.
const HISTORY_MAX = 900;
const LOG_MAX = 300;
// Если стенд закрыл сокет быстрее этого после открытия и не прислал ни одного
// кадра - почти наверняка сработал лимит клиентов прошивки (NET_MAX_WS_CLIENTS):
// прошивка принимает подключение и тут же его закрывает.
const INSTANT_CLOSE_MS = 2000;
// Стенд шлёт телеметрию 5 раз в секунду. Если кадров нет дольше этого, соединение
// считается мёртвым (пропало питание/WiFi стенда - браузер может часами не замечать
// обрыв TCP и показывать застывшие данные) и переоткрывается.
const STALE_MS = 3000;

/**
 * Владеет WebSocket-соединением со стендом и предоставляет реактивную телеметрию,
 * журнал событий, буфер истории скорости и тока для графика и отправитель команд.
 * Переподключается с экспоненциальной задержкой. Смена `host` разрывает соединение
 * и переподключается заново.
 */
export function useStand(host: string, observer?: StandObserver): UseStand {
  const [status, setStatus] = useState<ConnStatus>("disconnected");
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [history, setHistory] = useState<SpeedPoint[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [lastWarn, setLastWarn] = useState<GuardWarning | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const lastFrameAt = useRef<number>(0);
  const staleTimer = useRef<number | null>(null);
  // Коэффициент «прошивочный оборот → реальный» (units.ts), по последнему кадру.
  const kRef = useRef<number>(defaultRevFactor());
  const reconnectTimer = useRef<number | null>(null);
  const reconnectDelay = useRef<number>(RECONNECT_MIN);
  const manualClose = useRef<boolean>(false);
  const logId = useRef<number>(0);
  // Начало отсчёта для оси X графика, чтобы uPlot видел небольшие стабильные числа.
  const t0 = useRef<number>(Date.now());

  // Индикация хода подключения, намеренно спокойная и единообразная:
  //   attemptRef - счётчик попыток, показываемый в журнале ("Попытка N")
  //   liveId     - id ЕДИНСТВЕННОЙ строки журнала, обновляемой на месте, чтобы
  //                попытка и её итог использовали одну строку, а не засоряли журнал.
  const attemptRef = useRef<number>(0);
  const liveId = useRef<number | null>(null);
  const connectTimeout = useRef<number | null>(null);
  // Наблюдатель (серверный журнал) хранится в ref, чтобы не пересоздавать connect().
  const observerRef = useRef<StandObserver | undefined>(observer);
  observerRef.current = observer;

  const pushLog = useCallback((kind: LogEntry["kind"], text: string) => {
    setLog((prev) => {
      const next = prev.concat({
        id: logId.current++,
        ts: Date.now(),
        kind,
        text,
      });
      return next.length > LOG_MAX ? next.slice(next.length - LOG_MAX) : next;
    });
  }, []);

  // Обновить закреплённую "живую" строку на месте (или создать её). Используется
  // для статуса подключения / ожидания повтора, чтобы не переполнять журнал.
  const setLive = useCallback((kind: LogEntry["kind"], text: string) => {
    setLog((prev) => {
      if (liveId.current !== null) {
        const idx = prev.findIndex((e) => e.id === liveId.current);
        if (idx !== -1) {
          const copy = prev.slice();
          copy[idx] = { ...copy[idx], kind, text };
          return copy;
        }
      }
      const id = logId.current++;
      liveId.current = id;
      const next = prev.concat({ id, ts: Date.now(), kind, text });
      return next.length > LOG_MAX ? next.slice(next.length - LOG_MAX) : next;
    });
  }, []);

  const commitLive = useCallback(() => {
    liveId.current = null;
  }, []);

  const clockAt = (ms: number): string => {
    const d = new Date(ms);
    const p2 = (n: number) => (n < 10 ? "0" : "") + n;
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };

  const handleTelemetry = useCallback((t: Telemetry) => {
    setTelemetry(t);
    setHistory((prev) => {
      const point: SpeedPoint = {
        t: (Date.now() - t0.current) / 1000,
        rpm: Number(t.rpm) || 0,
        amps: t.ina_ok ? Number(t.current_a) : null,
        // Датчик скорости знака не знает - берём направление вращения двигателя.
        h1: t.h1_rpm === undefined || t.h1_st === "off" ? null : Number(t.h1_rpm) * dirSign(t),
        h2: t.h2_rpm === undefined || t.h2_st === "off" ? null : Number(t.h2_rpm) * dirSign(t),
      };
      const next = prev.concat(point);
      return next.length > HISTORY_MAX
        ? next.slice(next.length - HISTORY_MAX)
        : next;
    });
  }, []);

  const handleEvent = useCallback(
    (ev: StandEvent) => {
      const detail = ev.detail ?? "";
      switch (ev.event) {
        case "ack": {
          // "<CMD>:ok" | "<CMD>:ok_after_stop" | "<CMD>:<причина>"
          const sep = detail.indexOf(":");
          const cmd = sep >= 0 ? detail.slice(0, sep) : detail;
          const result = sep >= 0 ? detail.slice(sep + 1) : "";
          if (cmd === "GUARD" && (result === "on" || result === "off")) {
            pushLog(
              result === "on" ? "ack" : "warn",
              result === "on"
                ? "Автостоп по датчикам Холла/току ВКЛЮЧЁН"
                : "Автостоп по датчикам Холла/току ВЫКЛЮЧЕН - при расхождении будут только предупреждения",
            );
          } else if (result === "ok") pushLog("ack", `${cmd} принята`);
          else if (result === "ok_after_stop") pushLog("ack", `${cmd} принята - выполнится после плавной остановки`);
          else pushLog("error", `${cmd} отклонена: ${ackReason(result)}`);
          return;
        }
        case "state":
          pushLog("state", `Состояние: ${stateMeta(detail as Telemetry["state"]).label} (${detail})`);
          return;
        case "module": {
          const [cyc, mod] = detail.split(":");
          pushLog("module", `Цикл ${cyc ?? "?"} · модуль ${mod ?? "?"}`);
          return;
        }
        case "cycle":
          pushLog("cycle", `Цикл завершён: ${detail}`);
          return;
        case "done":
          if (detail === "completed") pushLog("done", "Программа выполнена полностью");
          else if (detail === "aborted") pushLog("done", "Программа остановлена оператором");
          else if (detail.startsWith("manual:")) {
            const revs = Math.round(Number(detail.slice(7)) * kRef.current * 100) / 100;
            pushLog("done", `Ручное вращение завершено: ${revs} об.`);
          }
          else pushLog("done", `Завершено: ${detail}`);
          return;
        case "warn": {
          // "<код>:<значение>" - автостоп выключен, стенд продолжает работу.
          const sep = detail.lastIndexOf(":");
          const code = sep >= 0 ? detail.slice(0, sep) : detail;
          const value = sep >= 0 ? Number(detail.slice(sep + 1)) : 0;
          setLastWarn({ ts: Date.now(), code, value });
          pushLog("warn", `ПРЕДУПРЕЖДЕНИЕ: ${guardLabel(code, value)} (автостоп выключен, работа продолжается)`);
          return;
        }
        case "error":
          pushLog("error", `АВАРИЯ: ${errorLabel(detail)}`);
          return;
      }

      // Незнакомое событие (новая прошивка) - как есть.
      const label = String((ev as { event: string }).event).toUpperCase();
      pushLog("sys", detail ? `${label} · ${detail}` : label);
    },
    [pushLog],
  );

  const connect = useCallback(() => {
    if (staleTimer.current !== null) {
      clearInterval(staleTimer.current);
      staleTimer.current = null;
    }
    if (reconnectTimer.current !== null) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (connectTimeout.current !== null) {
      clearTimeout(connectTimeout.current);
      connectTimeout.current = null;
    }
    if (wsRef.current) {
      const old = wsRef.current;
      old.onopen = old.onclose = old.onmessage = old.onerror = null;
      try {
        old.close();
      } catch {
        // игнорируется
      }
      wsRef.current = null;
    }
    manualClose.current = false;

    const url = wsUrl(host);
    const attempt = ++attemptRef.current;
    setStatus("reconnecting");

    setLive("sys", `Попытка ${attempt}: подключение к ${url}…`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      failAttempt();
      return;
    }
    wsRef.current = ws;

    const clearConnectTimeout = () => {
      if (connectTimeout.current !== null) {
        clearTimeout(connectTimeout.current);
        connectTimeout.current = null;
      }
    };

    let settled = false;
    let openedAt = 0;
    let gotFrame = false;
    function failAttempt() {
      if (settled) return;
      settled = true;
      clearConnectTimeout();
      if (manualClose.current) return;
      setStatus("reconnecting");
      const delayMs = reconnectDelay.current;
      const nextAt = clockAt(Date.now() + delayMs);
      setLive("sys", `Попытка ${attempt} не удалась. Следующая в ${nextAt}`);
      commitLive();
      reconnectDelay.current = Math.min(delayMs * 1.7, RECONNECT_MAX);
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        connect();
      }, delayMs);
    }

    connectTimeout.current = window.setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {
          // игнорируется
        }
        failAttempt();
      }
    }, CONNECT_TIMEOUT);

    ws.onopen = () => {
      settled = true;
      openedAt = Date.now();
      lastFrameAt.current = openedAt;
      if (staleTimer.current !== null) clearInterval(staleTimer.current);
      staleTimer.current = window.setInterval(() => {
        if (wsRef.current !== ws || Date.now() - lastFrameAt.current < STALE_MS) return;
        if (staleTimer.current !== null) clearInterval(staleTimer.current);
        staleTimer.current = null;
        pushLog("error", `Нет данных от стенда дольше ${STALE_MS / 1000} с - соединение потеряно, переподключаюсь`);
        connect();
      }, 1000);
      clearConnectTimeout();
      reconnectDelay.current = RECONNECT_MIN;
      setStatus("connected");
      setLive("state", `Подключено (попытка ${attempt})`);
      commitLive();
      attemptRef.current = 0;
    };

    ws.onmessage = (evt) => {
      let msg: unknown;
      try {
        msg = JSON.parse(evt.data as string);
      } catch {
        return;
      }
      gotFrame = true;
      lastFrameAt.current = Date.now();
      if (isEvent(msg)) {
        handleEvent(msg);
        observerRef.current?.onEvent(msg);
      } else if (isTelemetry(msg)) {
        // Дальше по панели и в серверный журнал - только реальные обороты вала.
        kRef.current = revFactor(msg.steps_per_rev, msg.shaft_steps_per_rev);
        const t = telemetryToShaft(msg);
        handleTelemetry(t);
        observerRef.current?.onTelemetry(t as unknown as { uptime_ms: number } & Record<string, unknown>);
      }
    };

    ws.onclose = () => {
      // Обнулять только СВОЙ сокет: закрытие старого не должно затирать ссылку на
      // уже созданный новый (иначе следующий connect() его не закроет и живут два
      // сокета - каждое событие приходит дважды).
      if (wsRef.current === ws) wsRef.current = null;
      if (openedAt && !gotFrame && Date.now() - openedAt < INSTANT_CLOSE_MS) {
        pushLog(
          "error",
          "Стенд закрыл соединение сразу после подключения - вероятно, занято максимальное число подключений к стенду (4). Закройте лишние вкладки панели.",
        );
      }
      failAttempt();
    };

    ws.onerror = () => {
      // Далее следует onclose, который через failAttempt() запускает повтор.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, handleEvent, handleTelemetry, setLive, commitLive, pushLog]);

  useEffect(() => {
    attemptRef.current = 0;
    reconnectDelay.current = RECONNECT_MIN;
    liveId.current = null;
    connect();
    return () => {
      manualClose.current = true;
      if (staleTimer.current !== null) {
        clearInterval(staleTimer.current);
        staleTimer.current = null;
      }
      if (reconnectTimer.current !== null) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (connectTimeout.current !== null) {
        clearTimeout(connectTimeout.current);
        connectTimeout.current = null;
      }
      if (wsRef.current) {
        const old = wsRef.current;
        // Снять обработчики до закрытия: асинхронный onclose старого сокета не
        // должен запускать переподключение после смены хоста / размонтирования.
        old.onopen = old.onclose = old.onmessage = old.onerror = null;
        try {
          old.close();
        } catch {
          // игнорируется
        }
        wsRef.current = null;
      }
      setStatus("disconnected");
    };
  }, [connect]);

  const send = useCallback(
    (cmd: Command) => {
      const ws = wsRef.current;
      // В журнале - команда в реальных оборотах, на стенд - в прошивочных.
      const fwCmd = commandToFirmware(cmd, kRef.current);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(fwCmd);
        pushLog("cmd", `→ отправлено "${cmd}"`);
        return;
      }
      // WS недоступен - откат на REST по мере возможности.
      pushLog("cmd", `WS закрыт, пробую REST: ${cmd}`);
      fetch(`${httpBase(host)}/v1/command?cmd=${encodeURIComponent(fwCmd)}`, { method: "POST" })
        .then(async (r) => {
          let detail = "";
          try {
            const j = (await r.json()) as { error?: string; accepted?: string };
            detail = j.error ? ` - ${j.error}` : j.accepted ? ` - принято` : "";
          } catch {
            // тело не JSON; игнорируется
          }
          const kind = r.ok ? "cmd" : "error";
          pushLog(kind, `REST ${cmd}: HTTP ${r.status}${detail}`);
        })
        .catch((e) => pushLog("sys", `REST ошибка: ${(e as Error).message}`));
    },
    [host, pushLog],
  );

  const sendConfig = useCallback(
    async (cfg: StandSettings): Promise<ConfigApplyResponse | null> => {
      try {
        const q = new URLSearchParams({
          accel_rpm_s: String(Math.round((cfg.accelRpmS / kRef.current) * 1000) / 1000),
          current_limit_a: String(cfg.currentLimitA),
          hold_idle: cfg.holdIdle ? "1" : "0",
          hall_mask: String(cfg.hallMask),
          hall_tol: String(cfg.hallTol),
          current_min_a: String(cfg.currentMinA),
        });
        const r = await fetch(`${httpBase(host)}/v1/config?${q.toString()}`, { method: "POST" });
        let body: ConfigApplyResponse | null = null;
        try {
          body = (await r.json()) as ConfigApplyResponse;
        } catch {
          // тело не JSON
        }
        if (r.ok && body?.applied) {
          body.applied.accel_rpm_s = Math.round(body.applied.accel_rpm_s * kRef.current * 100) / 100;
          const a = body.applied;
          const hall =
            a.hall_mask === undefined
              ? ""
              : `, датчики Холла: ${["выкл", "№1", "№2", "№1 и №2"][a.hall_mask] ?? a.hall_mask}, допуск ${a.hall_tol}, мин. ток ${a.current_min_a ? `${a.current_min_a} А` : "выкл"}`;
          pushLog(
            "cmd",
            `Параметры применены: ускорение ${a.accel_rpm_s} об/мин/с, порог тока ${a.current_limit_a ? `${a.current_limit_a} А` : "выкл"}, удержание ${a.hold_idle ? "вкл" : "выкл"}${hall}`,
          );
        } else {
          pushLog("error", `Параметры отклонены: HTTP ${r.status} ${body?.error ?? ""}${body?.detail ? ` - ${body.detail}` : ""}`);
        }
        return body;
      } catch (e) {
        pushLog("error", `Ошибка запроса параметров: ${(e as Error).message}`);
        return null;
      }
    },
    [host, pushLog],
  );

  const uploadProgram = useCallback(
    async (p: Program): Promise<ProgramApplyResponse | null> => {
      try {
        // Тело form-urlencoded - «простой» CORS-запрос без preflight.
        const k = kRef.current;
        const r = await fetch(`${httpBase(host)}/v1/program`, {
          method: "POST",
          body: toFirmwareForm(programScale(p, 1 / k)),
        });
        let body: ProgramApplyResponse | null = null;
        try {
          body = (await r.json()) as ProgramApplyResponse;
        } catch {
          // тело не JSON
        }
        if (r.ok && body?.applied) {
          const applied = coerceProgram(body.applied);
          if (applied) body.applied = programScale(applied, k);
          const a = body.applied;
          pushLog("cmd", `Программа «${a.name}» загружена в стенд: модулей ${a.modules.length}, циклов ${a.cycles}`);
        } else {
          pushLog("error", `Стенд отклонил программу: HTTP ${r.status} ${body?.error ?? ""}${body?.detail ? ` - ${body.detail}` : ""}`);
        }
        return body;
      } catch (e) {
        pushLog("error", `Ошибка загрузки программы: ${(e as Error).message}`);
        return null;
      }
    },
    [host, pushLog],
  );

  const fetchProgram = useCallback(async (): Promise<Program | null> => {
    try {
      const r = await fetch(`${httpBase(host)}/v1/program`);
      if (r.status === 404) {
        pushLog("sys", "В стенде нет загруженной программы");
        return null;
      }
      const p = coerceProgram(await r.json());
      if (!r.ok || !p) {
        pushLog("error", `Не удалось прочитать программу стенда: HTTP ${r.status}`);
        return null;
      }
      return programScale(p, kRef.current);
    } catch (e) {
      pushLog("error", `Ошибка чтения программы стенда: ${(e as Error).message}`);
      return null;
    }
  }, [host, pushLog]);

  const reconnect = useCallback(() => {
    reconnectDelay.current = RECONNECT_MIN;
    attemptRef.current = 0;
    commitLive();
    connect();
  }, [connect, commitLive]);

  return useMemo(
    () => ({
      status,
      telemetry,
      history,
      log,
      lastWarn,
      send,
      sendConfig,
      uploadProgram,
      fetchProgram,
      reconnect,
      note: pushLog,
    }),
    [status, telemetry, history, log, lastWarn, send, sendConfig, uploadProgram, fetchProgram, reconnect, pushLog],
  );
}

/** Знак скорости для датчиков Холла: по фактическому вращению, в покое - по направлению. */
function dirSign(t: Telemetry): number {
  if (t.rpm > 0.01) return 1;
  if (t.rpm < -0.01) return -1;
  return t.dir === "ccw" ? -1 : 1;
}
