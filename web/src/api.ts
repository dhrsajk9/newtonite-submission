// ─────────────────────────────────────────────────────────────────────────────
// The only place the UI talks to the server. Every call goes through `request`,
// which turns the API's standard error shape into an ApiError the UI can act on
// (e.g. show "Priya claimed this first" for ALREADY_CLAIMED).
// ─────────────────────────────────────────────────────────────────────────────

export type Role = 'viewer' | 'member' | 'lead';
export type Status = 'OPEN' | 'IN_PROGRESS' | 'AWAITING_APPROVAL' | 'RESOLVED' | 'CLOSED';
export type Priority = 'critical' | 'high' | 'medium' | 'low';
export type ItemType = 'incident' | 'customer_issue' | 'payment' | 'compliance' | 'task';
export type Action =
  | 'claim' | 'assign' | 'unassign' | 'request_approval'
  | 'approve' | 'reject' | 'resolve' | 'close' | 'reopen';

export interface Me {
  id: number;
  name: string;
  email: string;
  teams: { id: number; name: string; role: Role }[];
}

export interface WorkItem {
  id: number;
  team_id: number;
  team_name: string;
  title: string;
  description: string;
  type: ItemType;
  status: Status;
  priority: Priority;
  assignee_id: number | null;
  assignee_name: string | null;
  created_by: number;
  created_by_name: string;
  approval_requested_by: number | null;
  next_step: string;
  due_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  allowed_actions?: Action[];
}

export interface ActivityEvent {
  id: number;
  type: string;
  payload: Record<string, any>;
  created_at: string;
  actor_id: number;
  actor_name: string;
}

export interface Notification {
  id: number;
  work_item_id: number;
  message: string;
  read_at: string | null;
  created_at: string;
}

export interface Queue { items: WorkItem[]; total: number }

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: Record<string, any> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    const { code, message, ...details } = e;
    throw new ApiError(res.status, code ?? 'UNKNOWN', message ?? `Request failed (${res.status}).`, details);
  }
  return data as T;
}

/** A fresh key for one user action. Retries of that action reuse it; see the server's idempotency.ts. */
export const newIdempotencyKey = () => crypto.randomUUID();

export interface ListParams {
  team?: string; status?: string; priority?: string; type?: string; assignee?: string; q?: string; cursor?: string;
}

export const api = {
  me: () => request<Me>('GET', '/api/auth/me'),
  login: (email: string, password: string) => request<Me>('POST', '/api/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),

  dashboard: () => request<Record<'mine' | 'approvals' | 'unclaimed' | 'overdue', Queue>>('GET', '/api/dashboard'),

  list: (params: ListParams) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    qs.set('limit', '50');
    return request<{ items: WorkItem[]; nextCursor: string | null }>('GET', `/api/items?${qs}`);
  },
  item: (id: number) => request<WorkItem>('GET', `/api/items/${id}`),
  create: (body: object, idempotencyKey: string) =>
    request<WorkItem>('POST', '/api/items', body, { 'Idempotency-Key': idempotencyKey }),
  edit: (id: number, body: object) => request<WorkItem>('PATCH', `/api/items/${id}`, body),
  act: (id: number, action: Action, body: object = {}) =>
    request<WorkItem>('POST', `/api/items/${id}/actions/${action}`, body),

  activity: (id: number, cursor?: string) =>
    request<{ events: ActivityEvent[]; nextCursor: string | null }>(
      'GET', `/api/items/${id}/activity?limit=30${cursor ? `&cursor=${cursor}` : ''}`,
    ),
  comment: (id: number, body: string, idempotencyKey: string) =>
    request('POST', `/api/items/${id}/comments`, { body }, { 'Idempotency-Key': idempotencyKey }),

  members: (teamId: number) => request<{ id: number; name: string; role: Role }[]>('GET', `/api/teams/${teamId}/members`),

  notifications: () => request<{ notifications: Notification[]; unreadCount: number }>('GET', '/api/notifications'),
  markRead: (id: number) => request('POST', `/api/notifications/${id}/read`),
  markAllRead: () => request('POST', '/api/notifications/read-all'),
};
