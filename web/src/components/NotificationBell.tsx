// The bell: unread count, a short list, and links to the items.
// Polls every 15 s. Notifications are created by the background worker,
// usually within a second of the change.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { relative } from '../format';

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: api.notifications, refetchInterval: 15_000 });
  const markAll = useMutation({ mutationFn: api.markAllRead, onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = data?.unreadCount ?? 0;
  return (
    <div className="bell" ref={wrap}>
      <button
        type="button"
        className="bell-button"
        aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel">
          <div className="bell-head">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button type="button" className="link-button" onClick={() => markAll.mutate()}>Mark all as read</button>
            )}
          </div>
          {data?.notifications.length ? (
            <ul className="bell-list">
              {data.notifications.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`bell-item${n.read_at ? '' : ' unread'}`}
                    onClick={async () => {
                      setOpen(false);
                      navigate(`/items/${n.work_item_id}`);
                      if (!n.read_at) {
                        await api.markRead(n.id);
                        qc.invalidateQueries({ queryKey: ['notifications'] });
                      }
                    }}
                  >
                    <span>{n.message}</span>
                    <span className="muted small">{relative(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted bell-empty">Nothing yet. You'll be told here when work is assigned to you or needs your approval.</p>
          )}
        </div>
      )}
    </div>
  );
}
