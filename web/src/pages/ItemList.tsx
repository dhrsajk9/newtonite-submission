// All items, filtered and searched on the server, 50 at a time.
// Filters live in the URL, so a filtered view can be bookmarked or shared.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, type ItemType, type ListParams, type Me, type Priority, type Status } from '../api';
import { ItemRow } from '../components/Bits';
import { PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, STATUS_ORDER, TYPE_LABEL } from '../format';

const FILTER_KEYS = ['team', 'status', 'priority', 'type', 'assignee', 'q'] as const;

export function ItemList({ me }: { me: Me }) {
  const [params, setParams] = useSearchParams();
  const filters: ListParams = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as ListParams;

  const set = (key: keyof ListParams, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const toggleIn = (key: 'status' | 'priority', value: string) => {
    const current = new Set((filters[key] ?? '').split(',').filter(Boolean));
    if (current.has(value)) current.delete(value);
    else current.add(value);
    set(key, [...current].join(','));
  };

  // Search box: update the URL 300 ms after typing stops, not on every key.
  const [search, setSearch] = useState(filters.q ?? '');
  useEffect(() => setSearch(filters.q ?? ''), [filters.q]);
  useEffect(() => {
    const t = setTimeout(() => search !== (filters.q ?? '') && set('q', search.trim()), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const list = useInfiniteQuery({
    queryKey: ['items', filters],
    queryFn: ({ pageParam }) => api.list({ ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const active = FILTER_KEYS.some((k) => filters[k]);
  const statuses = new Set((filters.status ?? '').split(','));
  const priorities = new Set((filters.priority ?? '').split(','));

  return (
    <div className="page">
      <div className="page-head">
        <h1>All items</h1>
        {me.teams.some((t) => t.role !== 'viewer') && <Link to="/items/new" className="btn btn-primary">New item</Link>}
      </div>

      <div className="filters" role="search">
        <label className="field field-search">
          <span>Search</span>
          <input type="search" placeholder="Words in the title or description" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="field">
          <span>Team</span>
          <select value={filters.team} onChange={(e) => set('team', e.target.value)}>
            <option value="">All your teams</option>
            {me.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Assignee</span>
          <select value={filters.assignee} onChange={(e) => set('assignee', e.target.value)}>
            <option value="">Anyone</option>
            <option value="me">Me</option>
            <option value="unassigned">Unassigned</option>
          </select>
        </label>
        <label className="field">
          <span>Type</span>
          <select value={filters.type} onChange={(e) => set('type', e.target.value)}>
            <option value="">Any type</option>
            {(Object.keys(TYPE_LABEL) as ItemType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </label>

        <fieldset className="chips">
          <legend>Status</legend>
          {STATUS_ORDER.map((s: Status) => (
            <button key={s} type="button" aria-pressed={statuses.has(s)} className="chip" onClick={() => toggleIn('status', s)}>
              {STATUS_LABEL[s]}
            </button>
          ))}
        </fieldset>
        <fieldset className="chips">
          <legend>Priority</legend>
          {PRIORITIES.map((p: Priority) => (
            <button key={p} type="button" aria-pressed={priorities.has(p)} className={`chip chip-${p}`} onClick={() => toggleIn('priority', p)}>
              {PRIORITY_LABEL[p]}
            </button>
          ))}
        </fieldset>
        {active && (
          <button type="button" className="link-button clear" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </button>
        )}
      </div>

      {list.error && <p className="form-error" role="alert">{list.error.message}</p>}
      {list.isPending ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <div className="empty">
          <p>No items match these filters.</p>
          {active && <button type="button" className="btn" onClick={() => setParams(new URLSearchParams())}>Clear filters</button>}
        </div>
      ) : (
        <>
          <ul className="rows rows-list" aria-busy={list.isFetching}>{items.map((i) => <ItemRow key={i.id} item={i} />)}</ul>
          <div className="list-foot">
            <span className="muted">Showing {items.length}{list.hasNextPage ? '+' : ''} items</span>
            {list.hasNextPage && (
              <button type="button" className="btn" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                {list.isFetchingNextPage ? 'Loading…' : 'Load 50 more'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
