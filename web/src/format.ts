// Human-readable words for the API's values, in one place so every screen agrees.
import type { Action, ActivityEvent, ItemType, Priority, Status } from './api';

export const STATUS_LABEL: Record<Status, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  AWAITING_APPROVAL: 'Awaiting approval',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};
export const STATUS_ORDER: Status[] = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'];

export const PRIORITY_LABEL: Record<Priority, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
export const PRIORITIES: Priority[] = ['critical', 'high', 'medium', 'low'];

export const TYPE_LABEL: Record<ItemType, string> = {
  incident: 'Incident',
  customer_issue: 'Customer issue',
  payment: 'Payment',
  compliance: 'Compliance',
  task: 'Task',
};

/** Button text for each workflow action, and the past tense used in confirmations. */
export const ACTION_LABEL: Record<Action, string> = {
  claim: 'Claim',
  assign: 'Assign…',
  unassign: 'Unassign',
  request_approval: 'Request approval',
  approve: 'Approve',
  reject: 'Reject…',
  resolve: 'Resolve',
  close: 'Close',
  reopen: 'Reopen…',
};
export const ACTION_DONE: Record<Action, string> = {
  claim: 'Claimed',
  assign: 'Assigned',
  unassign: 'Unassigned',
  request_approval: 'Approval requested',
  approve: 'Approved',
  reject: 'Rejected',
  resolve: 'Resolved',
  close: 'Closed',
  reopen: 'Reopened',
};

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const formatDate = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : '—');
export const formatTime = (iso: string) => timeFmt.format(new Date(iso));

export function relative(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return formatDate(iso);
}

export const isOverdue = (due: string | null, status: Status) =>
  !!due && new Date(due).getTime() < Date.now() && ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL'].includes(status);

const FIELD_LABEL: Record<string, string> = {
  title: 'title', description: 'description', next_step: 'next step', due_at: 'due date',
};

/** One line describing a history event, e.g. "changed priority from Low to Critical". */
export function describeEvent(e: ActivityEvent): string {
  const p = e.payload;
  const to = (s: string) => STATUS_LABEL[s as Status] ?? s;
  switch (e.type) {
    case 'created': return 'created this item';
    case 'assigned': return p.claimed ? 'claimed this item' : `assigned it to ${p.assignee_name}`;
    case 'unassigned': return p.reason ? `unassigned it: “${p.reason}”` : 'unassigned it';
    case 'priority_changed':
      return `changed priority from ${PRIORITY_LABEL[p.from as Priority]} to ${PRIORITY_LABEL[p.to as Priority]}`;
    case 'updated': return `edited the ${Object.keys(p.changes ?? {}).map((f) => FIELD_LABEL[f] ?? f).join(', ')}`;
    case 'approval_requested': return 'requested approval';
    case 'approved': return 'approved the request';
    case 'rejected': return `rejected the request: “${p.reason}”`;
    case 'status_changed':
      return p.reason ? `moved it to ${to(p.to_status)}: “${p.reason}”` : `moved it to ${to(p.to_status)}`;
    case 'commented': return 'commented';
    default: return e.type;
  }
}
