import { useCallback, useEffect, useRef, useState } from "react";
import { clearStoredHost, defaultHost, resolveHost, setStoredHost } from "./config";
import { useStand, type LogEntry } from "./hooks/useStand";
import { useTheme } from "./hooks/useTheme";
import { useLibrary } from "./hooks/useLibrary";
import { useCoordinator } from "./coord/useCoordinator";
import type { Command, Program } from "./types";
import { Header } from "./components/Header";
import { LockBar } from "./components/LockBar";
import { Toasts } from "./components/Toasts";
import { LogArchive } from "./components/LogArchive";
import { StatusCard } from "./components/StatusCard";
import { RotationCard } from "./components/RotationCard";
import { PowerCard } from "./components/PowerCard";
import { ManualCard } from "./components/ManualCard";
import { ControlsCard } from "./components/ControlsCard";
import { ProgramRunCard } from "./components/ProgramRunCard";
import { SettingsCard } from "./components/SettingsCard";
import { ProgramBuilder } from "./components/ProgramBuilder";
import { SpeedChart } from "./components/SpeedChart";
import { EventLog } from "./components/EventLog";

export default function App() {
  const { theme, toggle } = useTheme();
  const [host, setHost] = useState<string>(() => resolveHost());
  const [archiveOpen, setArchiveOpen] = useState(false);

  const noteRef = useRef<(kind: LogEntry["kind"], text: string) => void>(() => {});
  const coord = useCoordinator(host, (kind, text) => noteRef.current(kind, text));
  const { status, telemetry, history, log, send, sendConfig, uploadProgram, fetchProgram, note } = useStand(
    host,
    coord.observer,
  );
  noteRef.current = note;
  const library = useLibrary(coord.me.name, host);

  const applyHost = useCallback((next: string) => {
    const h = next.trim();
    if (!h) return;
    setStoredHost(h);
    setHost(h);
  }, []);

  const resetHost = useCallback(() => {
    clearStoredHost();
    setHost(defaultHost());
  }, []);

  const { reportConn, reportCmd, reportConfig, gate } = coord;
  const wasConnected = useRef(false);
  useEffect(() => {
    const connected = status === "connected";
    if (connected !== wasConnected.current) {
      wasConnected.current = connected;
      reportConn(connected);
    }
  }, [status, reportConn]);

  // Команды уходят на стенд только от владельца канала. Исключение - E-STOP:
  // остановить вал в аварийной ситуации должен мочь любой, кто видит панель.
  const guardedSend = useCallback(
    (cmd: Command) => {
      const emergency = cmd === "estop";
      if (!gate.allowed && !emergency) return;
      send(cmd);
      reportCmd(`команда ${cmd.toUpperCase()}${emergency && !gate.allowed ? " (аварийный стоп без права управления)" : ""}`);
    },
    [gate.allowed, send, reportCmd],
  );

  const guardedConfig = useCallback(
    async (accel: number, limit: number, hold: boolean) => {
      if (!gate.allowed) return null;
      const res = await sendConfig(accel, limit, hold);
      const a = res?.applied;
      reportConfig(
        !!a,
        a
          ? `параметры: ускорение ${a.accel_rpm_s} об/мин/с, порог тока ${a.current_limit_a} А, удержание ${a.hold_idle ? "вкл" : "выкл"}`
          : `параметры отклонены стендом: ${res?.error ?? "нет ответа"}${res?.detail ? ` - ${res.detail}` : ""}`,
      );
      return res;
    },
    [gate.allowed, sendConfig, reportConfig],
  );

  // Программа, загруженная в стенд: читается при подключении и когда телеметрия
  // сообщает о смене (имя / число модулей / циклов) - например, загрузил другой
  // оператор.
  const [standProgram, setStandProgram] = useState<Program | null>(null);
  const progSig = telemetry
    ? `${telemetry.prog_loaded}|${telemetry.prog_name}|${telemetry.prog_modules}|${telemetry.prog_cycles}`
    : "";
  const connected = status === "connected";
  useEffect(() => {
    if (!connected || !progSig) return;
    if (!telemetry?.prog_loaded) {
      setStandProgram(null);
      return;
    }
    let cancelled = false;
    void fetchProgram().then((p) => {
      if (!cancelled) setStandProgram(p);
    });
    return () => {
      cancelled = true;
    };
    // telemetry целиком в зависимостях не нужен - важна только подпись программы
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, progSig, fetchProgram]);
  useEffect(() => setStandProgram(null), [host]);

  const guardedUpload = useCallback(
    async (p: Program) => {
      if (!gate.allowed) return null;
      const res = await uploadProgram(p);
      if (res?.applied) setStandProgram(res.applied);
      reportConfig(
        !!res?.applied,
        res?.applied
          ? `программа «${res.applied.name}» загружена в стенд (модулей ${res.applied.modules.length}, циклов ${res.applied.cycles})`
          : `программа «${p.name}» отклонена стендом: ${res?.error ?? "нет ответа"}${res?.detail ? ` - ${res.detail}` : ""}`,
      );
      return res;
    },
    [gate.allowed, uploadProgram, reportConfig],
  );

  const state = telemetry?.state ?? null;

  return (
    <div className="app">
      <Header
        host={host}
        status={status}
        theme={theme}
        onApplyHost={applyHost}
        onResetHost={resetHost}
        onToggleTheme={toggle}
      />

      <div className="grid">
        <LockBar coord={coord} />

        <StatusCard telemetry={telemetry} />
        <RotationCard telemetry={telemetry} gate={gate} onCommand={guardedSend} />
        <PowerCard telemetry={telemetry} />

        <ManualCard telemetry={telemetry} gate={gate} onCommand={guardedSend} />
        <ControlsCard state={state} gate={gate} onCommand={guardedSend} />

        <ProgramRunCard telemetry={telemetry} gate={gate} onCommand={guardedSend} />
        {/* key={host}: при смене стенда параметры заново берутся из его телеметрии */}
        <SettingsCard key={host} telemetry={telemetry} gate={gate} onApply={guardedConfig} />

        <ProgramBuilder
          telemetry={telemetry}
          gate={gate}
          standProgram={standProgram}
          library={library}
          onUpload={guardedUpload}
          onStart={() => guardedSend("start")}
          onFetchStand={fetchProgram}
        />

        <SpeedChart history={history} theme={theme} />

        <EventLog
          log={log}
          actions={
            <button className="chip small" onClick={() => setArchiveOpen(true)}>
              Архив журналов
            </button>
          }
        />
      </div>

      {archiveOpen && <LogArchive onClose={() => setArchiveOpen(false)} />}
      <Toasts toasts={coord.toasts} onDismiss={coord.dismissToast} />
    </div>
  );
}
