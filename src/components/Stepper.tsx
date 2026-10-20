import { useEffect, useRef, useState } from "react";

interface Props {
  value: number;
  step?: number;
  onChange: (v: number) => void;
}

/** Числовое поле с собственными кнопками вверх/вниз (нативные счётчики скрыты). */
export function Stepper({ value, step = 0.05, onChange }: Props) {
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const inputRef = useRef<HTMLInputElement>(null);

  // Локальный текстовый черновик, чтобы оператор мог свободно печатать:
  // частичные значения вроде "1.", "-", "" или "0.05" иначе затирались бы
  // контролируемым числовым `value` (Number("1.") === 1 отбрасывает точку,
  // ведущий 0 остаётся как "01" и т.д.). Разобранное число передаётся наверх
  // только когда черновик является конечным числом; в самом поле показывается
  // черновик.
  const [draft, setDraft] = useState<string>(() => String(value));

  // Пересинхронизация черновика, когда `value` меняется ИЗВНЕ (заполнение из
  // телеметрии, кнопки +/-) - но никогда, пока поле в фокусе, чтобы не
  // перезаписать то, что оператор набирает в данный момент.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(String(value));
    }
  }, [value]);

  const handleType = (raw: string) => {
    setDraft(raw);
    const n = Number(raw);
    // Number("") === 0 и Number(" ") === 0, поэтому пустое значение проверяется
    // отдельно; фиксируются только реальные конечные числа. Частичный ввод ("1.",
    // "-", ".") даёт NaN или промежуточное значение и удерживается в черновике до
    // завершения.
    if (raw.trim() !== "" && Number.isFinite(n)) {
      onChange(round(n));
    }
  };

  // При потере фокуса черновик нормализуется обратно к каноническому числу,
  // чтобы висящее "1." / "01" / "" превратилось в "1" / "1" / последнее
  // корректное значение.
  const handleBlur = () => {
    const n = Number(draft);
    setDraft(draft.trim() !== "" && Number.isFinite(n) ? String(round(n)) : String(value));
  };

  const bump = (delta: number) => {
    const next = round(value + delta);
    setDraft(String(next));
    onChange(next);
  };

  return (
    <div className="stepper">
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        className="num"
        value={draft}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => handleType(e.target.value)}
        onBlur={handleBlur}
      />
      <div className="btns">
        <button type="button" aria-label="Увеличить" onClick={() => bump(step)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 15l6-6 6 6" />
          </svg>
        </button>
        <button type="button" aria-label="Уменьшить" onClick={() => bump(-step)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
