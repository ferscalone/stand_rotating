import { useEffect, useState, type ReactNode } from "react";
import type { UseCoordinator } from "../coord/useCoordinator";

interface Props {
  coord: UseCoordinator;
}

function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(t);
  }, [periodMs]);
  return now;
}

const p2 = (n: number) => (n < 10 ? "0" : "") + n;
const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${p2(s % 60)}`;
};
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  return `${Math.floor(s / 60)} мин`;
};

const LockIcon = ({ open }: { open?: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d={open ? "M8 11V7a4 4 0 0 1 7.5-2" : "M8 11V7a4 4 0 0 1 8 0v4"} />
  </svg>
);

/**
 * Канал управления: кто сейчас управляет стендом, сколько осталось до
 * авто-освобождения, кто ещё смотрит, и действия - занять / продлить / передать /
 * освободить / попросить. Кнопки стенда в остальных карточках разблокированы
 * только у владельца канала.
 */
export function LockBar({ coord }: Props) {
  const now = useNow(1000);
  const { online, owner, isOwner, viewers, requests, me, myRequest, pending, skew } = coord;

  const [nameDraft, setNameDraft] = useState(me.name);
  useEffect(() => {
    if (document.activeElement?.id !== "operator-name") setNameDraft(me.name);
  }, [me.name]);

  const others = viewers.filter((v) => v.clientId !== me.clientId);
  const [target, setTarget] = useState("");
  const transferTo = others.some((v) => v.clientId === target) ? target : (others[0]?.clientId ?? "");

  const local = (serverMs: number) => serverMs - skew;
  const left = owner?.expiresAt != null ? local(owner.expiresAt) - now : null;
  const noName = !me.name;

  let tone: "offline" | "free" | "own" | "busy";
  let title: string;
  let sub: string;
  let actions: ReactNode = null;

  if (!online) {
    tone = "offline";
    title = "Сервер координации недоступен";
    sub = "Просмотр работает, управление заблокировано до восстановления связи.";
  } else if (!owner) {
    tone = "free";
    title = "Канал управления свободен";
    sub = noName
      ? "Укажите своё имя - его увидят остальные, - затем займите управление."
      : "Займите управление, чтобы запускать стенд и менять параметры.";
    actions = (
      <button
        className="chip primary"
        disabled={pending || noName}
        onClick={coord.acquire}
        title={noName ? "Сначала укажите имя" : "Только вы сможете управлять стендом"}
      >
        <LockIcon open />
        Занять управление
      </button>
    );
  } else if (isOwner) {
    tone = "own";
    title = "Вы управляете стендом";
    sub =
      left !== null
        ? `Без действий управление освободится через ${mmss(left)}. Любая команда продлевает срок.`
        : "Управление не освобождается автоматически.";
    actions = (
      <>
        {left !== null && (
          <button className="chip" disabled={pending} onClick={coord.extend} title="Сбросить таймер бездействия">
            Продлить
          </button>
        )}
        {others.length > 0 && (
          <span className="lb-transfer">
            <select
              className="lb-select"
              value={transferTo}
              onChange={(e) => setTarget(e.target.value)}
              aria-label="Кому передать управление"
            >
              {others.map((v) => (
                <option key={v.clientId} value={v.clientId}>
                  {v.name || "без имени"}
                </option>
              ))}
            </select>
            <button className="chip" disabled={pending || !transferTo} onClick={() => coord.transfer(transferTo)}>
              Передать
            </button>
          </span>
        )}
        <button className="chip" disabled={pending} onClick={coord.release}>
          Освободить
        </button>
      </>
    );
  } else {
    tone = "busy";
    title = `Управляет: ${owner!.name || "без имени"}`;
    sub = owner!.online
      ? `С ${hhmm(local(owner!.since))} · последнее действие ${ago(now - local(owner!.lastActive))} назад`
      : `Закрыл(а) панель - канал освободится через ${mmss(left ?? 0)}`;
    if (myRequest) {
      const wait = local(myRequest.deadline) - now;
      sub = `Запрос отправлен. Если ${owner!.name || "владелец"} не ответит и ничего не сделает за ${mmss(wait)}, управление перейдёт к вам.`;
      actions = (
        <>
          <button className="chip" disabled={pending} onClick={coord.request} title="Напомнить владельцу">
            Напомнить
          </button>
          <button className="chip" disabled={pending} onClick={coord.cancelRequest}>
            Отменить запрос
          </button>
        </>
      );
    } else {
      actions = (
        <button
          className="chip primary"
          disabled={pending || noName}
          onClick={coord.request}
          title={noName ? "Сначала укажите имя" : "Владелец получит уведомление"}
        >
          Попросить управление
        </button>
      );
    }
  }

  const commitName = () => coord.setName(nameDraft);

  return (
    <section className={`card col-12 lockbar ${tone}`}>
      <div className="lb-row">
        <div className="lb-icon">
          <LockIcon open={tone === "free" || tone === "own"} />
        </div>
        <div className="lb-text">
          <div className="lb-title">{title}</div>
          <div className="lb-sub">{sub}</div>
        </div>
        <div className="lb-actions">{actions}</div>
        <input
          id="operator-name"
          className={`host-input lb-name ${noName ? "need" : ""}`}
          type="text"
          value={nameDraft}
          maxLength={40}
          placeholder="Ваше имя"
          title="Как вас увидят остальные. Enter - сохранить."
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>

      {isOwner &&
        requests.map((r) => (
          <div key={r.clientId} className="lb-request">
            <span>
              <b>{r.name || "Коллега"}</b> просит управление · авто-передача через{" "}
              <span className="num">{mmss(local(r.deadline) - now)}</span>, если вы ничего не делаете
            </span>
            <span className="lb-actions">
              <button className="chip primary" disabled={pending} onClick={() => coord.transfer(r.clientId)}>
                Передать
              </button>
              <button className="chip" disabled={pending} onClick={() => coord.decline(r.clientId)}>
                Отклонить
              </button>
            </span>
          </div>
        ))}

      {online && viewers.length > 0 && (
        <div className="lb-viewers">
          <span className="lb-viewers-k">На связи:</span>
          {viewers.map((v) => (
            <span
              key={v.clientId}
              className={`lb-viewer ${v.standConnected ? "live" : ""}`}
              title={v.standConnected ? "Панель подключена к стенду" : "Панель не подключена к стенду"}
            >
              <span className="dot" />
              {v.name || "без имени"}
              {v.clientId === me.clientId && " (вы)"}
              {owner?.clientId === v.clientId && " · управляет"}
              {requests.some((r) => r.clientId === v.clientId) && " · просит"}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
