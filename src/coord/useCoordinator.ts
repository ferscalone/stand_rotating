import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { attention, primeAttention } from "./attention";
import { clientId as getClientId, loadName, saveName, setWasOwner, wasOwner } from "./identity";
import type {
  CoordConfig,
  JournalEntry,
  LockRequest,
  Notice,
  Owner,
  ReportItem,
  ServerMessage,
  Viewer,
} from "./types";

// ── Хук канала управления и журнала ──────────────────────────────────────────
// Держит SSE-поток к серверу координации (server/api.mjs) для текущего стенда,
// отдаёт состояние канала (кто управляет, кто смотрит, кто просит), действия
// (занять / освободить / продлить / попросить / передать / отклонить), всплывающие
// уведомления и отправку записей в серверный журнал.
//
// Без связи с сервером управление БЛОКИРУЕТСЯ (иначе два человека снова смогут
// жать кнопки одновременно) - просмотр телеметрии при этом работает как обычно.
// Общий для dashboard1 и dashboard2.

export interface ToastAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export interface Toast {
  id: number;
  /** Ключ для замены/снятия уведомления (например, "req:<clientId>"). */
  key?: string;
  tone: "info" | "ok" | "warn" | "danger";
  title: string;
  text?: string;
  actions?: ToastAction[];
}

/** Разрешение на управление для кнопок. */
export interface Gate {
  allowed: boolean;
  /** Почему нельзя (пусто, если можно). */
  reason: string;
  /** Имя того, кто сейчас управляет (null - никто). */
  ownerName: string | null;
  isOwner: boolean;
}

/** Наблюдатель за потоком стенда - события и телеметрия уходят в серверный журнал. */
export interface StandObserver {
  onEvent: (ev: { event: string; detail: string; uptime_ms: number }) => void;
  onTelemetry: (t: { uptime_ms: number } & Record<string, unknown>) => void;
}

export interface UseCoordinator {
  online: boolean;
  me: { clientId: string; name: string };
  setName: (name: string) => void;
  owner: Owner | null;
  viewers: Viewer[];
  requests: LockRequest[];
  config: CoordConfig | null;
  isOwner: boolean;
  myRequest: LockRequest | null;
  /** Перевод времени сервера в локальное: local = server - skew. */
  skew: number;
  gate: Gate;
  pending: boolean;
  acquire: () => void;
  release: () => void;
  extend: () => void;
  request: () => void;
  cancelRequest: () => void;
  transfer: (clientId: string) => void;
  decline: (clientId: string) => void;
  observer: StandObserver;
  reportCmd: (text: string) => void;
  reportConfig: (ok: boolean, text: string) => void;
  reportConn: (connected: boolean) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
}

interface Snapshot {
  owner: Owner | null;
  viewers: Viewer[];
  requests: LockRequest[];
}

const EMPTY: Snapshot = { owner: null, viewers: [], requests: [] };
const REPORT_EVERY_MS = 2000;
const REPORT_QUEUE_MAX = 600;
const TOAST_TTL_MS = 8000;

const fmtSec = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} с`;

export function useCoordinator(
  host: string,
  /** Сюда уходят записи общего журнала (кто что сделал) для экранного журнала. */
  onJournal: (kind: "lock" | "user" | "error", text: string) => void,
): UseCoordinator {
  const clientId = useMemo(() => getClientId(), []);
  const [name, setNameState] = useState<string>(() => loadName());
  const [online, setOnline] = useState(false);
  const [config, setConfig] = useState<CoordConfig | null>(null);
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [skew, setSkew] = useState(0);
  const [pending, setPending] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const nameRef = useRef(name);
  nameRef.current = name;
  const hostRef = useRef(host);
  hostRef.current = host;
  const journalRef = useRef(onJournal);
  journalRef.current = onJournal;
  const configRef = useRef<CoordConfig | null>(null);
  configRef.current = config;
  const snapRef = useRef<Snapshot>(EMPTY);
  snapRef.current = snap;
  const toastId = useRef(1);

  // ── Уведомления ────────────────────────────────────────────────────────────
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dropToastKey = useCallback((key: string) => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
  }, []);

  const pushToast = useCallback(
    (t: Omit<Toast, "id">, ttl: number | null = TOAST_TTL_MS) => {
      const id = toastId.current++;
      setToasts((prev) => [...prev.filter((x) => !t.key || x.key !== t.key), { ...t, id }].slice(-6));
      if (ttl !== null) window.setTimeout(() => dismissToast(id), ttl);
      return id;
    },
    [dismissToast],
  );

  // ── Действия ───────────────────────────────────────────────────────────────
  const act = useCallback(
    async (action: string, extra: Record<string, unknown> = {}): Promise<boolean> => {
      setPending(true);
      try {
        const r = await fetch("api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host: hostRef.current, clientId, name: nameRef.current, action, ...extra }),
        });
        const j = (await r.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
        if (!r.ok || !j?.ok) {
          pushToast({ tone: "danger", title: "Не получилось", text: j?.message ?? `Ошибка сервера (HTTP ${r.status})` });
          return false;
        }
        return true;
      } catch {
        pushToast({ tone: "danger", title: "Сервер координации недоступен", text: "Действие не выполнено." });
        return false;
      } finally {
        setPending(false);
      }
    },
    [clientId, pushToast],
  );

  const acquire = useCallback(() => {
    primeAttention();
    void act("acquire");
  }, [act]);
  const release = useCallback(() => {
    void act("release");
  }, [act]);
  const extend = useCallback(() => {
    void act("extend").then((ok) => ok && dropToastKey("expiring"));
  }, [act, dropToastKey]);
  const request = useCallback(() => {
    primeAttention();
    void act("request").then((ok) => {
      if (ok && snapRef.current.owner && snapRef.current.owner.clientId !== clientId) {
        pushToast({ tone: "info", title: "Запрос отправлен", text: `${snapRef.current.owner.name} получит уведомление.` });
      }
    });
  }, [act, clientId, pushToast]);
  const cancelRequest = useCallback(() => {
    void act("cancel-request");
  }, [act]);
  const transfer = useCallback(
    (target: string) => {
      void act("transfer", { target });
    },
    [act],
  );
  const decline = useCallback(
    (target: string) => {
      dropToastKey(`req:${target}`);
      void act("decline", { target });
    },
    [act, dropToastKey],
  );

  const setName = useCallback(
    (raw: string) => {
      const n = raw.replace(/\s+/g, " ").trim().slice(0, 40);
      if (n === nameRef.current) return;
      nameRef.current = n;
      setNameState(n);
      saveName(n);
      void fetch("api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: hostRef.current, clientId, name: n, action: "rename" }),
      }).catch(() => {});
    },
    [clientId],
  );

  // Ссылки на действия для кнопок внутри уведомлений (уведомление живёт дольше рендера).
  const actionsRef = useRef({ transfer, decline, extend });
  actionsRef.current = { transfer, decline, extend };

  // ── Разбор уведомлений сервера ─────────────────────────────────────────────
  const handleNotice = useCallback(
    (n: Notice) => {
      const cfg = configRef.current;
      switch (n.kind) {
        case "granted": {
          const text: Record<typeof n.how, string> = {
            acquire: "Кнопки управления разблокированы.",
            manual: `Управление передал(а) вам ${n.from ?? "владелец"}.`,
            queue: "Канал освободился - вы были первым в очереди.",
            timeout: `${n.from ?? "Владелец"} не ответил(а) на запрос - управление перешло к вам.`,
            offline: `${n.from ?? "Владелец"} не в сети - управление перешло к вам.`,
            resume: "Сервер координации перезапускался, управление восстановлено.",
          };
          pushToast({ tone: "ok", title: "Вы управляете стендом", text: text[n.how] });
          if (n.how !== "acquire" && n.how !== "resume") attention("Вам передано управление", text[n.how]);
          break;
        }
        case "transferred":
          dropToastKey("expiring");
          pushToast(
            n.how === "timeout"
              ? { tone: "warn", title: "Управление передано", text: `Вы не ответили на запрос - управляет ${n.to}.` }
              : { tone: "info", title: "Управление передано", text: `Теперь управляет ${n.to}.` },
            n.how === "timeout" ? null : TOAST_TTL_MS,
          );
          break;
        case "request": {
          const { clientId: from, name: who } = n.from;
          const secs = cfg ? fmtSec(cfg.requestTimeoutMs) : "некоторое время";
          pushToast(
            {
              key: `req:${from}`,
              tone: "warn",
              title: `${who || "Коллега"} просит управление`,
              text: `Если не ответить и ничего не делать ${secs}, управление перейдёт автоматически.`,
              actions: [
                { label: "Передать", primary: true, run: () => actionsRef.current.transfer(from) },
                { label: "Отклонить", run: () => actionsRef.current.decline(from) },
              ],
            },
            null,
          );
          attention("Запрос управления", `${who || "Коллега"} просит передать управление стендом`);
          break;
        }
        case "declined":
          pushToast({ tone: "warn", title: "Запрос отклонён", text: `${n.by} продолжает работу со стендом.` });
          break;
        case "request-expired":
          pushToast({
            tone: "info",
            title: "Запрос истёк",
            text: n.owner ? `${n.owner} сейчас работает со стендом. Можно попросить ещё раз.` : "Можно попросить ещё раз.",
          });
          break;
        case "request-dropped":
          pushToast({ tone: "info", title: "Канал занят раньше вас", text: `Управление получил(а) ${n.owner}.` });
          break;
        case "expiring":
          pushToast(
            {
              key: "expiring",
              tone: "warn",
              title: "Управление скоро освободится",
              text: "Вы давно ничего не делали. Нажмите «Продлить», если ещё работаете.",
              actions: [{ label: "Продлить", primary: true, run: () => actionsRef.current.extend() }],
            },
            null,
          );
          attention("Управление скоро освободится", "Продлите, если ещё работаете со стендом");
          break;
        case "expired":
          dropToastKey("expiring");
          pushToast({ tone: "warn", title: "Управление освобождено", text: "Из-за долгого бездействия." }, null);
          break;
      }
    },
    [pushToast, dropToastKey],
  );

  // ── SSE-поток ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: number | null = null;
    let delay = 1000;
    let closed = false;

    const connect = () => {
      const q = new URLSearchParams({ host, clientId, name: nameRef.current });
      if (wasOwner(host)) q.set("resume", "1");
      es = new EventSource(`api/stream?${q.toString()}`);
      es.onopen = () => {
        delay = 1000;
      };
      es.onmessage = (e) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(e.data as string) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case "hello":
            setConfig(msg.config);
            setOnline(true);
            break;
          case "state": {
            setSkew(msg.serverNow - Date.now());
            setSnap({ owner: msg.owner, viewers: msg.viewers, requests: msg.requests });
            setOnline(true);
            if (msg.owner?.clientId === clientId) setWasOwner(msg.host);
            else setWasOwner(null);
            break;
          }
          case "notify":
            handleNotice(msg);
            break;
          case "journal": {
            const en: JournalEntry = msg.entry;
            // Свои команды уже есть в экранном журнале строкой "→ отправлено".
            if ((en.kind === "cmd" || en.kind === "config") && en.client === clientId) break;
            journalRef.current(en.kind === "warn" ? "error" : en.kind === "lock" ? "lock" : "user", en.text);
            break;
          }
        }
      };
      es.onerror = () => {
        // Переподключаемся сами (а не встроенным повтором EventSource), чтобы
        // каждый раз отправлять актуальные имя и флаг resume.
        es?.close();
        es = null;
        setOnline(false);
        if (closed) return;
        retryTimer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      };
    };

    setSnap(EMPTY);
    setOnline(false);
    connect();
    return () => {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      es?.close();
    };
  }, [host, clientId, handleNotice]);

  // Уведомление о запросе снимается, как только запроса больше нет (передали,
  // отклонили, запросивший ушёл) - в том числе из другой вкладки владельца.
  useEffect(() => {
    const live = new Set(snap.requests.map((r) => `req:${r.clientId}`));
    setToasts((prev) => {
      const next = prev.filter((t) => !t.key?.startsWith("req:") || live.has(t.key));
      return next.length === prev.length ? prev : next;
    });
    if (snap.owner?.clientId !== clientId) dropToastKey("expiring");
  }, [snap, clientId, dropToastKey]);

  // ── Отправка записей в журнал сервера ──────────────────────────────────────
  const queue = useRef<ReportItem[]>([]);
  const flushTimer = useRef<number | null>(null);
  const flushing = useRef(false);
  const lastTeleUptime = useRef<number | null>(null);

  const flush = useCallback(async () => {
    if (flushTimer.current !== null) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (flushing.current || queue.current.length === 0) return;
    flushing.current = true;
    const items = queue.current;
    queue.current = [];
    try {
      const r = await fetch("api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: hostRef.current, clientId, name: nameRef.current, items }),
        keepalive: items.length < 50,
      });
      if (!r.ok && r.status >= 500) throw new Error(String(r.status));
    } catch {
      // Сервер недоступен - вернуть записи в очередь (с ограничением размера).
      queue.current = items.concat(queue.current).slice(-REPORT_QUEUE_MAX);
    } finally {
      flushing.current = false;
    }
  }, [clientId]);

  const enqueue = useCallback(
    (item: ReportItem, now = false) => {
      queue.current.push(item);
      if (queue.current.length > REPORT_QUEUE_MAX) queue.current.splice(0, queue.current.length - REPORT_QUEUE_MAX);
      if (now) void flush();
      else if (flushTimer.current === null) flushTimer.current = window.setTimeout(() => void flush(), REPORT_EVERY_MS);
    },
    [flush],
  );

  // Смена стенда: отправить хвост для старого стенда и начать с чистого листа.
  useEffect(() => {
    lastTeleUptime.current = null;
    return () => {
      void flush();
    };
  }, [host, flush]);

  const observer = useMemo<StandObserver>(
    () => ({
      onEvent: (ev) => enqueue({ type: "event", event: ev.event, detail: ev.detail ?? "", uptime_ms: ev.uptime_ms }),
      onTelemetry: (t) => {
        const step = configRef.current?.telemetryIntervalMs ?? 0;
        if (!step) return;
        const last = lastTeleUptime.current;
        if (last === null || t.uptime_ms - last >= step || t.uptime_ms < last) {
          lastTeleUptime.current = t.uptime_ms;
          enqueue({ type: "telemetry", ts: Date.now(), t });
        }
      },
    }),
    [enqueue],
  );

  const reportCmd = useCallback((text: string) => enqueue({ type: "cmd", text }, true), [enqueue]);
  const reportConfig = useCallback(
    (ok: boolean, text: string) => enqueue({ type: "config", ok, text }, true),
    [enqueue],
  );
  const reportConn = useCallback(
    (connected: boolean) => enqueue({ type: "conn", connected }, true),
    [enqueue],
  );

  // ── Производное ────────────────────────────────────────────────────────────
  const owner = snap.owner;
  const isOwner = online && owner?.clientId === clientId;
  const myRequest = snap.requests.find((r) => r.clientId === clientId) ?? null;

  const gate = useMemo<Gate>(() => {
    if (!online) {
      return { allowed: false, reason: "Нет связи с сервером координации", ownerName: null, isOwner: false };
    }
    if (!owner) return { allowed: false, reason: "Сначала займите управление", ownerName: null, isOwner: false };
    if (owner.clientId === clientId) return { allowed: true, reason: "", ownerName: owner.name, isOwner: true };
    return { allowed: false, reason: `Канал занят: ${owner.name}`, ownerName: owner.name, isOwner: false };
  }, [online, owner, clientId]);

  return {
    online,
    me: { clientId, name },
    setName,
    owner,
    viewers: snap.viewers,
    requests: snap.requests,
    config,
    isOwner,
    myRequest,
    skew,
    gate,
    pending,
    acquire,
    release,
    extend,
    request,
    cancelRequest,
    transfer,
    decline,
    observer,
    reportCmd,
    reportConfig,
    reportConn,
    toasts,
    dismissToast,
  };
}
