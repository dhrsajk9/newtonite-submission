// The workflow buttons. Only the actions the server says this person may take
// right now (`allowed_actions`) are shown; the server re-checks every request anyway.
//
// Claim is applied OPTIMISTICALLY: the page shows you as the owner immediately,
// then reconciles with the server's answer. If someone else won the race, the
// change is rolled back and you're told who did.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Action, type Me, type WorkItem } from '../api';
import { ACTION_DONE, ACTION_LABEL } from '../format';
import { PromptDialog } from './PromptDialog';
import { useToast } from './Toast';

const PRIMARY: Action[] = ['claim', 'approve', 'resolve', 'close'];

export function ActionPanel({ item, me }: { item: WorkItem; me: Me }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [prompt, setPrompt] = useState<null | 'assign' | 'reject' | 'reopen'>(null);
  const actions = item.allowed_actions ?? [];
  const key = ['item', item.id];

  const members = useQuery({
    queryKey: ['members', item.team_id],
    queryFn: () => api.members(item.team_id),
    enabled: prompt === 'assign',
  });

  const act = useMutation({
    mutationFn: ({ action, body }: { action: Action; body?: object }) =>
      api.act(item.id, action, action === 'claim' ? {} : { version: item.version, ...body }),

    onMutate: async ({ action }) => {
      if (action !== 'claim') return {};
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<WorkItem>(key);
      qc.setQueryData<WorkItem>(key, (old) =>
        old && { ...old, status: 'IN_PROGRESS', assignee_id: me.id, assignee_name: me.name, allowed_actions: [] },
      );
      return { before };
    },

    onSuccess: (updated, { action }) => {
      qc.setQueryData(key, updated); // the server's answer is the truth
      setPrompt(null);
      toast(ACTION_DONE[action]);
    },

    onError: (error, _vars, context) => {
      if (context?.before) qc.setQueryData(key, context.before); // undo the optimistic change
      if (!(error instanceof ApiError)) return toast('Something went wrong. Try again.', 'error');
      if (error.code === 'VERSION_CONFLICT' && error.details.current) {
        qc.setQueryData(key, error.details.current);
        toast('Someone changed this item while you were looking at it. The page now shows the latest version; check it and try again.', 'error');
      } else {
        toast(error.message, 'error'); // e.g. "Priya Nair has already claimed this item."
      }
    },

    onSettled: () => {
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ['activity', item.id] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['items'] });
    },
  });

  if (actions.length === 0) {
    return <p className="muted small">There's nothing you can do on this item right now.</p>;
  }

  const run = (action: Action) => {
    if (action === 'assign' || action === 'reject' || action === 'reopen') setPrompt(action);
    else act.mutate({ action });
  };

  return (
    <>
      <div className="actions">
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            className={`btn ${PRIMARY.includes(a) ? 'btn-primary' : ''}`}
            disabled={act.isPending}
            onClick={() => run(a)}
          >
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>

      <PromptDialog
        open={prompt === 'assign'}
        title="Assign this item"
        confirmLabel="Assign"
        busy={act.isPending}
        onCancel={() => setPrompt(null)}
        onConfirm={(f) => act.mutate({ action: 'assign', body: { assignee_id: Number(f.get('assignee_id')) } })}
      >
        <label className="field">
          <span>Person</span>
          <select name="assignee_id" required defaultValue="">
            <option value="" disabled>{members.isPending ? 'Loading…' : 'Choose a person'}</option>
            {members.data
              ?.filter((m) => m.role !== 'viewer')
              .map((m) => (
                <option key={m.id} value={m.id} disabled={m.id === item.assignee_id}>
                  {m.name}{m.id === item.assignee_id ? ' (current)' : ''}
                </option>
              ))}
          </select>
          <small className="field-hint">Only members and leads of {item.team_name} can own its items.</small>
        </label>
      </PromptDialog>

      <PromptDialog
        open={prompt === 'reject' || prompt === 'reopen'}
        title={prompt === 'reject' ? 'Reject this request' : 'Reopen this item'}
        confirmLabel={prompt === 'reject' ? 'Reject' : 'Reopen'}
        busy={act.isPending}
        onCancel={() => setPrompt(null)}
        onConfirm={(f) => act.mutate({ action: prompt!, body: { reason: String(f.get('reason')).trim() } })}
      >
        <label className="field">
          <span>Reason <span className="req" aria-hidden="true">*</span></span>
          <textarea name="reason" required rows={3} maxLength={1000}
            placeholder={prompt === 'reject' ? 'What is missing or wrong?' : 'Why does this need more work?'} />
          <small className="field-error">A reason is required. It's kept in the item's history.</small>
        </label>
      </PromptDialog>
    </>
  );
}
