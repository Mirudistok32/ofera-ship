import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/* Тосты: toast('Готово') из любого места под <ToastProvider>.
   Тост сам закрывается через 4 секунды, ✕ — сразу */

type ToastKind = 'info' | 'ok' | 'error';
type ToastItem = { id: number; text: string; kind: ToastKind };
type ToastFn = (text: string, kind?: ToastKind) => void;

const ToastContext = createContext<ToastFn | null>(null);

const LIFE_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const toast = useCallback<ToastFn>((text, kind = 'info') => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, text, kind }]);
  }, []);

  /* Т23: закрываем по id, а не по индексу — индекс сдвигается, когда закрылся сосед */
  const close = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <Toast key={t.id} item={t} onClose={close} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* key={t.id}: экземпляр Toast и его таймер живут вместе со своим тостом.
   onClose стабилен (useCallback), поэтому зависимости честные и таймер не перезаводится */
function Toast({ item, onClose }: { item: ToastItem; onClose: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onClose(item.id), LIFE_MS);
    return () => clearTimeout(timer);
  }, [item.id, onClose]);

  return (
    <div className={`toast toast-${item.kind}`}>
      <span>{item.text}</span>
      <button type="button" className="icon-btn" onClick={() => onClose(item.id)} aria-label="Закрыть">✕</button>
    </div>
  );
}

export function useToast(): ToastFn {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast — только внутри <ToastProvider>');
  return toast;
}
