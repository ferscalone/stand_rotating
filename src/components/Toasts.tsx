import type { Toast } from "../coord/useCoordinator";

interface Props {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

/** Всплывающие уведомления канала управления (правый нижний угол). */
export function Toasts({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <div className="toast-body">
            <div className="toast-title">{t.title}</div>
            {t.text && <div className="toast-text">{t.text}</div>}
            {t.actions && t.actions.length > 0 && (
              <div className="toast-actions">
                {t.actions.map((a) => (
                  <button
                    key={a.label}
                    className={`chip ${a.primary ? "primary" : ""}`}
                    onClick={() => {
                      a.run();
                      onDismiss(t.id);
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Закрыть">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
