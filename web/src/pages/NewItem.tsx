import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newIdempotencyKey, type ItemType, type Me } from '../api';
import { useAriaInvalidSync } from '../components/Bits';
import { useToast } from '../components/Toast';
import { PRIORITIES, PRIORITY_LABEL, TYPE_LABEL } from '../format';

export function NewItem({ me }: { me: Me }) {
  const teams = me.teams.filter((t) => t.role !== 'viewer');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const aria = useAriaInvalidSync();

  // One key for this form. A double-click or a retry after a network error sends
  // the same key, so the server creates the item once.
  const key = useRef(newIdempotencyKey());
  const [error, setError] = useState<ApiError | null>(null);

  const create = useMutation({
    mutationFn: (body: object) => api.create(body, key.current),
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast('Item created');
      navigate(`/items/${item.id}`);
    },
    onError: (e) => setError(e instanceof ApiError ? e : null),
  });

  if (teams.length === 0) {
    return <div className="page"><h1>New item</h1><p>You can view items but not create them. Ask a team lead to make you a member.</p></div>;
  }

  return (
    <div className="page page-narrow">
      <h1>New item</h1>
      <form
        className="stack"
        {...aria}
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const due = String(f.get('due_at') ?? '');
          setError(null);
          create.mutate({
            team_id: Number(f.get('team_id')),
            title: String(f.get('title')).trim(),
            type: f.get('type'),
            priority: f.get('priority'),
            description: String(f.get('description') ?? ''),
            next_step: String(f.get('next_step') ?? ''),
            due_at: due ? new Date(`${due}T23:59:59`).toISOString() : null,
          });
        }}
      >
        <div className="grid-2">
          <label className="field">
            <span>Team <span className="req" aria-hidden="true">*</span></span>
            <select name="team_id" required defaultValue={teams.length === 1 ? teams[0].id : ''}>
              <option value="" disabled>Choose a team</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <small className="field-error">Choose the team that owns this work.</small>
          </label>
          <label className="field">
            <span>Type <span className="req" aria-hidden="true">*</span></span>
            <select name="type" required defaultValue="">
              <option value="" disabled>Choose a type</option>
              {(Object.keys(TYPE_LABEL) as ItemType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            <small className="field-error">Choose a type.</small>
          </label>
        </div>

        <label className="field">
          <span>Title <span className="req" aria-hidden="true">*</span></span>
          <input name="title" required maxLength={200} placeholder="What needs to happen, in a few words" />
          <small className="field-error">Give the item a title.</small>
        </label>

        <fieldset className="field">
          <legend>Priority <span className="req" aria-hidden="true">*</span></legend>
          <div className="segmented">
            {PRIORITIES.map((p) => (
              <label key={p} className={`seg seg-${p}`}>
                <input type="radio" name="priority" value={p} required defaultChecked={p === 'medium'} />
                <span>{PRIORITY_LABEL[p]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="field">
          <span>Why it exists</span>
          <textarea name="description" rows={5} maxLength={10000} placeholder="Context: what happened, who reported it, links" />
        </label>

        <div className="grid-2">
          <label className="field">
            <span>Next step</span>
            <input name="next_step" maxLength={500} placeholder="e.g. Check provider logs" />
          </label>
          <label className="field">
            <span>Due date</span>
            <input name="due_at" type="date" />
          </label>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error.code === 'VALIDATION_ERROR' && error.details.fields
              ? `Check these fields: ${error.details.fields.map((f: { path: string }) => f.path).join(', ')}.`
              : error.message}
          </p>
        )}
        <div className="form-actions">
          <Link to="/items" className="btn">Cancel</Link>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create item'}
          </button>
        </div>
      </form>
    </div>
  );
}
