// Small shared pieces: status and priority labels, an item row, field validity.
import { useCallback, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Priority, Status, WorkItem } from '../api';
import { formatDate, isOverdue, PRIORITY_LABEL, STATUS_LABEL, TYPE_LABEL } from '../format';

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`status status-${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>;
}

/** Priority is shown by colour AND by word, never colour alone. */
export function PriorityLabel({ priority }: { priority: Priority }) {
  return (
    <span className={`prio prio-${priority}`}>
      <span className="prio-dot" aria-hidden="true" />
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

export function DueDate({ item }: { item: Pick<WorkItem, 'due_at' | 'status'> }) {
  if (!item.due_at) return <span className="muted">No due date</span>;
  const overdue = isOverdue(item.due_at, item.status);
  return (
    <span className={overdue ? 'overdue' : undefined}>
      {overdue ? `Overdue since ${formatDate(item.due_at)}` : `Due ${formatDate(item.due_at)}`}
    </span>
  );
}

/** One work item in a list. The coloured bar on the left encodes priority. */
export function ItemRow({ item, showTeam = true, showAssignee = true }: { item: WorkItem; showTeam?: boolean; showAssignee?: boolean }) {
  return (
    <li>
      <Link to={`/items/${item.id}`} className={`row spine-${item.priority}`}>
        <span className="row-main">
          <span className="row-title">{item.title}</span>
          <span className="row-sub">
            <span>#{item.id}</span>
            <span>{TYPE_LABEL[item.type]}</span>
            {showTeam && <span>{item.team_name}</span>}
          </span>
        </span>
        <span className="row-cells">
          <PriorityLabel priority={item.priority} />
          <StatusBadge status={item.status} />
          <span className="row-assignee">
            {showAssignee ? item.assignee_name ?? <span className="muted">Unassigned</span> : <span className="muted">You</span>}
          </span>
          <span className="row-due"><DueDate item={item} /></span>
        </span>
      </Link>
    </li>
  );
}

/**
 * Keeps aria-invalid in step with the browser's :user-invalid state, so screen
 * reader users hear about an error at the same moment sighted users see it:
 * after they've left a field, or tried to submit.
 */
export function useAriaInvalidSync() {
  const sync = (el: EventTarget | null) => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    if (!el.willValidate) return;
    if (el.matches(':user-invalid')) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  };
  return {
    onBlurCapture: useCallback((e: FormEvent) => sync(e.target), []),
    onInputCapture: useCallback((e: FormEvent) => sync(e.target), []),
    onInvalidCapture: useCallback((e: FormEvent) => (e.target as HTMLElement).setAttribute('aria-invalid', 'true'), []),
  };
}
