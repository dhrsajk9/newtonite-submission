import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type Me } from '../api';
import { ActionPanel } from '../components/ActionPanel';
import { DueDate, PriorityLabel, StatusBadge } from '../components/Bits';
import { EditForm } from '../components/EditForm';
import { Timeline } from '../components/Timeline';
import { WorkflowTrack } from '../components/WorkflowTrack';
import { formatDate, TYPE_LABEL } from '../format';

/** The full item page: /items/42 */
export function ItemDetail({ me }: { me: Me }) {
  const id = Number(useParams().id);
  return <ItemView key={id} me={me} id={id} variant="page" />;
}

interface ItemViewProps {
  me: Me;
  id: number;
  /** "page" = its own screen; "panel" = beside a list on wide screens. */
  variant: 'page' | 'panel';
  /** Panel only: where "close" goes (the same list, without ?item=). */
  closeHref?: string;
}

/**
 * Everything about one item. Used both as the full page and as the split-view
 * panel, so the two can never behave differently.
 */
export function ItemView({ me, id, variant, closeHref }: ItemViewProps) {
  const [editing, setEditing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // Polled, so changes by other people show up without a reload.
  const { data: item, error, isPending } = useQuery({
    queryKey: ['item', id],
    queryFn: () => api.item(id),
    refetchInterval: 15_000,
  });

  // In the panel, move keyboard and screen-reader focus to the newly opened item.
  useEffect(() => {
    if (variant === 'panel' && item) heading.current?.focus({ preventScroll: true });
  }, [variant, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const wrapper = variant === 'page' ? 'page detail' : 'detail detail-panel';

  if (isPending) return <div className={wrapper}><p className="muted">Loading…</p></div>;
  if (error || !item) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className={wrapper}>
        <h1>{notFound ? 'Item not found' : 'Could not load this item'}</h1>
        <p>{notFound ? "It doesn't exist, or it belongs to a team you're not in." : error?.message}</p>
        {variant === 'page' ? <Link to="/items">Back to all items</Link> : closeHref && <Link to={closeHref}>Close</Link>}
      </div>
    );
  }

  const canEdit = me.teams.some(
    (t) => t.id === item.team_id && (t.role === 'lead' || (t.role === 'member' && item.assignee_id === me.id)),
  ) && item.status !== 'CLOSED';

  return (
    <div className={wrapper}>
      {variant === 'page' ? (
        <Link to="/items" className="back">All items</Link>
      ) : (
        <div className="panel-bar">
          <Link to={`/items/${item.id}`} className="panel-open">Open full page</Link>
          {closeHref && (
            <Link to={closeHref} className="panel-close" aria-label="Close item panel">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </Link>
          )}
        </div>
      )}

      <header className={`detail-head spine-${item.priority}`}>
        <div className="detail-meta">
          <span>#{item.id}</span>
          <span>{TYPE_LABEL[item.type]}</span>
          <span>{item.team_name}</span>
        </div>
        <h1 ref={heading} tabIndex={-1}>{item.title}</h1>
        <div className="detail-badges">
          <PriorityLabel priority={item.priority} />
          <StatusBadge status={item.status} />
        </div>
      </header>

      <WorkflowTrack status={item.status} type={item.type} />

      <div className="detail-grid">
        <div className="detail-main">
          {editing ? (
            <EditForm item={item} onDone={() => setEditing(false)} />
          ) : (
            <section className="description" aria-labelledby="why-title">
              <div className="section-head">
                <h2 id="why-title">Why it exists</h2>
                {canEdit && <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>Edit</button>}
              </div>
              {item.description ? <p className="prose">{item.description}</p> : <p className="muted">No description yet.</p>}
              <h2>Next step</h2>
              {item.next_step ? <p className="next-step">{item.next_step}</p> : <p className="muted">Not set.</p>}
            </section>
          )}
          <Timeline item={item} me={me} />
        </div>

        <aside className="detail-side">
          <section aria-labelledby="actions-title">
            <h2 id="actions-title">Actions</h2>
            <ActionPanel item={item} me={me} />
          </section>
          <dl className="facts">
            <dt>Owner</dt><dd>{item.assignee_name ?? <span className="muted">Unassigned</span>}</dd>
            <dt>Due</dt><dd><DueDate item={item} /></dd>
            <dt>Created by</dt><dd>{item.created_by_name}</dd>
            <dt>Created</dt><dd>{formatDate(item.created_at)}</dd>
            <dt>Last changed</dt><dd>{formatDate(item.updated_at)}</dd>
            <dt>Version</dt><dd>{item.version}</dd>
          </dl>
        </aside>
      </div>
    </div>
  );
}
