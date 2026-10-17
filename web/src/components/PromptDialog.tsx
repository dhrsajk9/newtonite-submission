// A modal question ("Why are you rejecting this?", "Assign to whom?").
// Built on the native <dialog> opened with showModal(): the browser handles
// focus trapping, Escape to close and the backdrop, with nothing to re-implement.
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useAriaInvalidSync } from './Bits';

interface Props {
  open: boolean;
  title: string;
  confirmLabel: string;
  children: ReactNode;               // the form fields
  busy?: boolean;
  onConfirm: (data: FormData) => void;
  onCancel: () => void;
}

export function PromptDialog({ open, title, confirmLabel, children, busy, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const aria = useAriaInvalidSync();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onCancel} className="dialog">
      <form
        {...aria}
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(new FormData(e.currentTarget));
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="dialog-body">{children}</div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{confirmLabel}</button>
        </div>
      </form>
    </dialog>
  );
}
