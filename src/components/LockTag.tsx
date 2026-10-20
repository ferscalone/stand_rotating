import type { Gate } from "../coord/useCoordinator";
import type { Avail } from "../standLogic";

/** Метка в заголовке карточки: кто управляет стендом. */
export function LockTag({ gate }: { gate: Gate }) {
  if (gate.isOwner) return <span className="tag ok">Вы управляете</span>;
  if (gate.ownerName) return <span className="tag busy" title={gate.reason}>Управляет: {gate.ownerName}</span>;
  return <span className="tag" title={gate.reason}>Управление не занято</span>;
}

/** Замок на кнопке, когда управление принадлежит не вам. */
export const LockedIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

/** Наложить права канала на доступность: без права - заблокировано с причиной. */
export function gatedAvail(avail: Avail, gate: Gate): Avail {
  return gate.allowed ? avail : { enabled: false, reason: gate.reason };
}
