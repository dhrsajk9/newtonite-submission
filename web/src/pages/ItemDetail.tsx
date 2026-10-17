import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type Me } from '../api';
import { ActionPanel } from '../components/ActionPanel';
import { DueDate, PriorityLabel, StatusBadge } from '../components/Bits';
import { EditForm } from '../components/EditForm';
import { Timeline } from '../components/Timeline';
import { WorkflowTrack } from '../components/WorkflowTrack';
import { formatDate, TYPE_LABEL } from '../format';

export function ItemDetail({ me }: { me: Me }) {
  const id = Number(useParams().id);
  const [editing, setEditing] = useState(false);
  // Polled, so changes by other people show up without a reload.
  const { data: item, error, isPending } = useQuery({
    queryKey: ['item', id],
    queryFn: () => api.item(id),
    refetchInterval: 15_000,
  });

  if (isPending) return <div className="page"><p className="muted">Loading…</p></div>;
  if (error || !item) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="page">
        <h1>{notFound ? 'Item not found' : 'Could not load this item'}</h1>
        <p>{notFound ? "It doesn't exist, or it belongs to a team you're not in." : error?.message}</p>
        <Link to="/items">Back to all items</Link>
      </div>
    );
  }

  const canEdit = me.teams.some(
    (t) => t.id === item.team_id && (t.role === 'lead' || (t.role === 'member' && item.assignee_id === me.id)),
  ) && item.status !== 'CLOSED';

  return (
    <div className="page detail">
      <Link to="/items" className="back">All items</Link>
      <header className={`detail-head spine-${item.priority}`}>
        <div className="detail-meta">
          <span>#{item.id}</span>
          <span>{TYPE_LABEL[item.type]}</span>
          <span>{item.team_name}</span>
        </div>
        <h1>{item.title}</h1>
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
