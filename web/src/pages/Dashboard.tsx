// "Needs attention": four focused queues answer "what should I do next?"
// without scrolling through thousands of items.
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Me, type Queue } from '../api';
import { ItemRow } from '../components/Bits';

interface QueueSpec {
  key: 'mine' | 'approvals' | 'unclaimed' | 'overdue';
  title: string;
  hint: string;
  empty: string;
  seeAll?: string;
  show: (me: Me) => boolean;
}

const QUEUES: QueueSpec[] = [
  {
    key: 'mine', title: 'Assigned to you', hint: 'Your unfinished work, most urgent first.',
    empty: 'Nothing assigned to you. Claim something from the unclaimed queue.',
    seeAll: '/items?assignee=me&status=IN_PROGRESS,AWAITING_APPROVAL',
    show: (me) => me.teams.some((t) => t.role !== 'viewer'),
  },
  {
    key: 'approvals', title: 'Waiting for your approval', hint: 'Requests from your teams. You never see your own here.',
    empty: 'No requests are waiting for you.',
    seeAll: '/items?status=AWAITING_APPROVAL',
    show: (me) => me.teams.some((t) => t.role === 'lead'),
  },
  {
    key: 'unclaimed', title: 'Unclaimed and urgent', hint: 'Critical and high priority work nobody has taken yet.',
    empty: 'All urgent work has an owner.',
    seeAll: '/items?status=OPEN&priority=critical,high&assignee=unassigned',
    show: (me) => me.teams.some((t) => t.role !== 'viewer'),
  },
  {
    key: 'overdue', title: 'Overdue', hint: 'Active items in your teams past their due date.',
    empty: 'Nothing is overdue.',
    show: () => true,
  },
];

export function Dashboard({ me }: { me: Me }) {
  const { data, isPending, error } = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard, refetchInterval: 30_000 });

  return (
    <div className="page">
      <h1>Needs attention</h1>
      {error && <p className="form-error" role="alert">Couldn't load your queues. {error.message}</p>}
      <div className="queues">
        {QUEUES.filter((q) => q.show(me)).map((q) => (
          <QueueSection key={q.key} spec={q} queue={data?.[q.key]} loading={isPending} />
        ))}
      </div>
    </div>
  );
}

function QueueSection({ spec, queue, loading }: { spec: QueueSpec; queue?: Queue; loading: boolean }) {
  const id = `queue-${spec.key}`;
  return (
    <section className={`queue queue-${spec.key}`} aria-labelledby={id}>
      <header className="queue-head">
        <h2 id={id}>
          {spec.title}
          {queue && <span className="queue-count">{queue.total}</span>}
        </h2>
        <p className="muted">{spec.hint}</p>
      </header>
      {loading ? (
        <p className="muted queue-empty">Loading…</p>
      ) : queue && queue.items.length > 0 ? (
        <>
          <ul className="rows">{queue.items.map((item) => <ItemRow key={item.id} item={item} showAssignee={spec.key !== 'mine'} />)}</ul>
          {spec.seeAll && queue.total > queue.items.length && (
            <Link className="queue-more" to={spec.seeAll}>Show all {queue.total}</Link>
          )}
        </>
      ) : (
        <p className="muted queue-empty">{spec.empty}</p>
      )}
    </section>
  );
}
