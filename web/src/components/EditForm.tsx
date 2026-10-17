// Editing an item's fields, with optimistic concurrency.
//
// The form remembers the version it started from. If someone else saves first:
//   • while you edit, a notice says the item changed underneath you;
//   • when you save, the server answers 409 with the current item, and you choose:
//     "Keep my changes" (re-apply only the fields YOU changed on top of theirs)
//     or "Discard my changes" (take theirs).
// Nobody's work is ever silently overwritten.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Priority, type WorkItem } from '../api';
import { PRIORITIES, PRIORITY_LABEL } from '../format';
import { useAriaInvalidSync } from './Bits';
import { useToast } from './Toast';

type Fields = Pick<WorkItem, 'title' | 'description' | 'priority' | 'next_step'> & { due: string };
const FIELD_NAMES: Record<keyof Fields, string> = {
  title: 'Title', description: 'Description', priority: 'Priority', next_step: 'Next step', due: 'Due date',
};

const toFields = (i: WorkItem): Fields => ({
  title: i.title, description: i.description, priority: i.priority, next_step: i.next_step,
  due: i.due_at ? i.due_at.slice(0, 10) : '',
});

export function EditForm({ item, onDone }: { item: WorkItem; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const aria = useAriaInvalidSync();
  const [base, setBase] = useState<WorkItem>(item);       // what the user started from
  const [draft, setDraft] = useState<Fields>(toFields(item));
  const [conflict, setConflict] = useState<WorkItem | null>(null);

  const baseFields = toFields(base);
  const changed = (Object.keys(draft) as (keyof Fields)[]).filter((k) => draft[k] !== baseFields[k]);
  const staleWhileEditing = item.version !== base.version && !conflict;

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { version: base.version };
      for (const k of changed) {
        if (k === 'due') body.due_at = draft.due ? new Date(`${draft.due}T23:59:59`).toISOString() : null;
        else body[k] = draft[k];
      }
      return api.edit(item.id, body);
    },
    onSuccess: (updated) => {
      qc.setQueryData(['item', item.id], updated);
      qc.invalidateQueries({ queryKey: ['activity', item.id] });
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast('Changes saved');
      onDone();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setConflict(e.details.current);
        qc.setQueryData(['item', item.id], e.details.current);
      } else {
        toast(e instanceof ApiError ? e.message : 'Could not save. Try again.', 'error');
      }
    },
  });

  const set = (k: keyof Fields) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  // Fields the other person changed, for the conflict panel.
  const theirs = conflict ? toFields(conflict) : null;
  const theirChanges = theirs ? (Object.keys(theirs) as (keyof Fields)[]).filter((k) => theirs[k] !== baseFields[k]) : [];
  const overlap = theirChanges.filter((k) => changed.includes(k));

  return (
    <form
      className="stack edit"
      {...aria}
      onSubmit={(e) => {
        e.preventDefault();
        if (changed.length === 0) return onDone();
        save.mutate();
      }}
    >
      {staleWhileEditing && (
        <p className="notice" role="status">
          Someone else changed this item while you were editing. You'll see their changes before anything is overwritten.
        </p>
      )}

      {conflict && theirs && (
        <div className="conflict" role="alert">
          <h3>Someone else saved first</h3>
          <p>Nothing was overwritten. Their version has:</p>
          <ul>
            {theirChanges.length === 0 && <li>Workflow changes only (status or assignee).</li>}
            {theirChanges.map((k) => (
              <li key={k}>
                <strong>{FIELD_NAMES[k]}</strong>: {k === 'priority' ? PRIORITY_LABEL[theirs[k] as Priority] : theirs[k] || '(empty)'}
                {overlap.includes(k) && <span className="overlap"> You also changed this.</span>}
              </li>
            ))}
          </ul>
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setConflict(null);
                onDone();
              }}
            >
              Discard my changes
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                // Re-apply only my edits on top of their version.
                const mine = Object.fromEntries(changed.map((k) => [k, draft[k]]));
                setBase(conflict);
                setDraft({ ...theirs, ...mine });
                setConflict(null);
              }}
            >
              Keep my changes on top of theirs
            </button>
          </div>
        </div>
      )}

      <label className="field">
        <span>Title <span className="req" aria-hidden="true">*</span></span>
        <input required maxLength={200} value={draft.title} onChange={set('title')} />
        <small className="field-error">A title is required.</small>
      </label>
      <fieldset className="field">
        <legend>Priority</legend>
        <div className="segmented">
          {PRIORITIES.map((p) => (
            <label key={p} className={`seg seg-${p}`}>
              <input type="radio" name="priority" value={p} checked={draft.priority === p} onChange={set('priority')} />
              <span>{PRIORITY_LABEL[p]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>Why it exists</span>
        <textarea rows={5} maxLength={10000} value={draft.description} onChange={set('description')} />
      </label>
      <div className="grid-2">
        <label className="field">
          <span>Next step</span>
          <input maxLength={500} value={draft.next_step} onChange={set('next_step')} />
        </label>
        <label className="field">
          <span>Due date</span>
          <input type="date" value={draft.due} onChange={set('due')} />
        </label>
      </div>
      {!conflict && (
        <div className="form-actions">
          <button type="button" className="btn" onClick={onDone}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </form>
  );
}
