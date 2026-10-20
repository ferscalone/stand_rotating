// ── Определение хоста стенда ──────────────────────────────────────────────────
// Хост определяется во ВРЕМЯ ВЫПОЛНЕНИЯ, никогда не зашивается жёстко:
//
//   1. localStorage("rotate.stand_host") - задаётся из поля в шапке; для каждого браузера.
//   2. import.meta.env.VITE_STAND_HOST   - необязательное значение по умолчанию из сборки (.env).
//   3. DEFAULT_HOST                      - домен стенда как последний вариант.
//
// Ключ со своим префиксом: за шлюзом все панели живут на одном origin и делят
// localStorage - общий ключ перетирал бы адрес соседнего стенда.
const LS_KEY = "rotate.stand_host";

// Имя mDNS из прошивки (Config::NET_HOSTNAME). На части точек доступа .local не
// резолвится - тогда впишите IP стенда в шапке (он печатается в Serial при загрузке).
export const DEFAULT_HOST = "1.rotate.esp32-s3.local";

// Значения, зеркалированные из firmware/src/Config.h. Используются до прихода
// первого кадра телеметрии и для проверки ввода; авторитет - валидатор прошивки.
export const FIRMWARE = {
  rpmDefault: 30,
  accelRpmS: 20, // ACCEL_RPM_S_DEFAULT
  currentLimitA: 0, // CURRENT_LIMIT_A_DEFAULT (0 - защита выключена)
  holdIdle: true, // HOLD_IDLE_DEFAULT
} as const;

export const LIMITS = {
  rpmMin: 0.1,
  rpmMax: 200, // об/мин реального вала (1/16 шага, см. units.ts)
  accelMin: 1,
  accelMax: 250, // прошивка: 1000 своих об/мин/с = 250 реальных при 1/16
  currentLimitMax: 3.2,
  modulesMax: 64,
  cyclesMin: 1,
  cyclesMax: 1_000_000,
  revsMin: 0.01,
  revsMax: 250_000, // прошивка: 1 000 000 своих оборотов = 250 000 реальных
  pauseMsMax: 3_600_000,
  nameMax: 40,
} as const;

function envHost(): string | undefined {
  const v = import.meta.env.VITE_STAND_HOST;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function resolveHost(): string {
  try {
    const stored = localStorage.getItem(LS_KEY);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    // localStorage может быть недоступен (приватный режим / file://).
  }
  return envHost() ?? DEFAULT_HOST;
}

export function setStoredHost(host: string): void {
  try {
    const h = host.trim();
    if (h) localStorage.setItem(LS_KEY, h);
    else localStorage.removeItem(LS_KEY);
  } catch {
    // хост в памяти всё равно действует в текущем сеансе.
  }
}

export function clearStoredHost(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    // игнорируется
  }
}

export function defaultHost(): string {
  return envHost() ?? DEFAULT_HOST;
}

export const httpBase = (host: string) => `http://${host}`;
export const wsUrl = (host: string) => `ws://${host}/ws`;
