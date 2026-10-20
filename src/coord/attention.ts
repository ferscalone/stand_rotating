// Привлечь внимание человека к уведомлению, даже если вкладка в фоне:
//   * системное уведомление (Notification API работает только на https/localhost,
//     на http по IP браузер его не даст - тогда остаются способы ниже);
//   * мигающий заголовок вкладки, пока вкладка скрыта;
//   * короткий звуковой сигнал (WebAudio разблокируется первым кликом по панели).

let audio: AudioContext | null = null;
let flashTimer: number | null = null;
let baseTitle = typeof document !== "undefined" ? document.title : "";

/** Вызывать из обработчика клика: запрос разрешений и разблокировка звука. */
export function primeAttention(): void {
  try {
    if ("Notification" in window && window.isSecureContext && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  } catch {
    // игнорируется
  }
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!audio && Ctx) audio = new Ctx();
    if (audio?.state === "suspended") void audio.resume();
  } catch {
    audio = null;
  }
}

function beep(): void {
  if (!audio || audio.state !== "running") return;
  const now = audio.currentTime;
  for (const [i, freq] of [880, 660].entries()) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.15, now + i * 0.18 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.16);
    osc.connect(gain).connect(audio.destination);
    osc.start(now + i * 0.18);
    osc.stop(now + i * 0.18 + 0.17);
  }
}

function stopFlash(): void {
  if (flashTimer !== null) {
    clearInterval(flashTimer);
    flashTimer = null;
    document.title = baseTitle;
  }
}

function flashTitle(text: string): void {
  if (!document.hidden) return;
  stopFlash();
  baseTitle = document.title;
  let on = false;
  flashTimer = window.setInterval(() => {
    on = !on;
    document.title = on ? `● ${text}` : baseTitle;
  }, 1000);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) stopFlash();
  });
}

export function attention(title: string, body: string): void {
  beep();
  flashTitle(title);
  try {
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body, tag: "stand-coord" });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch {
    // игнорируется
  }
}
