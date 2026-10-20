// Кто сидит за этой вкладкой.
//   clientId - случайный id ВКЛАДКИ (sessionStorage): переживает перезагрузку
//              страницы (управление не теряется), но у двух вкладок он разный.
//   имя      - запоминается в браузере (localStorage), показывается другим.

const ID_KEY = "coord_client_id";
const NAME_KEY = "operator_name";
const OWNER_KEY = "coord_was_owner";

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

let memoryId: string | null = null;

export function clientId(): string {
  try {
    let id = sessionStorage.getItem(ID_KEY);
    if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
      id = randomId();
      sessionStorage.setItem(ID_KEY, id);
    }
    return id;
  } catch {
    memoryId ??= randomId();
    return memoryId;
  }
}

export function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string): void {
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
    else localStorage.removeItem(NAME_KEY);
  } catch {
    // имя всё равно действует в текущем сеансе
  }
}

/** Помнить, что вкладка владела каналом (на случай перезапуска сервера). */
export function setWasOwner(host: string | null): void {
  try {
    if (host) sessionStorage.setItem(OWNER_KEY, host);
    else sessionStorage.removeItem(OWNER_KEY);
  } catch {
    // игнорируется
  }
}

export function wasOwner(host: string): boolean {
  try {
    return sessionStorage.getItem(OWNER_KEY) === host.trim().toLowerCase();
  } catch {
    return false;
  }
}
