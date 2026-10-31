import { useEffect, useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';

/* Модалка на <dialog>: фокус внутри, Esc и клик по фону закрывают — всё это даёт браузер.
   open — управляет родитель; onClose зовётся на любое закрытие */
type ModalProps = { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode };

export function Modal({ open, title, onClose, children, footer }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) onClose();   // клик пришёлся на сам <dialog>, то есть мимо содержимого
  };

  return (
    <dialog ref={ref} className="modal" onClose={onClose} onClick={onBackdrop} aria-label={title}>
      <div className="modal-body">
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">✕</button>
        </header>
        {children}
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}
