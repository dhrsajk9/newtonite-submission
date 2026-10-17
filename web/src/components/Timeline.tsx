// History and discussion, newest first, paginated (it grows without limit).
// A comment being sent appears immediately, marked "Sending…", until the server confirms it.
import { useRef } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newIdempotencyKey, type Me, type WorkItem } from '../api';
import { describeEvent, formatTime, relative } from '../format';
import { useToast } from './Toast';

export function Timeline({ item, me }: { item: WorkItem; me: Me }) {
  const qc = useQueryClient();
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  const key = useRef(newIdempotencyKey()); // one key per comment, reused if the send is retried
  const canComment = me.teams.some((t) => t.id === item.team_id && t.role !== 'viewer');

  const history = useInfiniteQuery({
    queryKey: ['activity', item.id],
    queryFn: ({ pageParam }) => api.activity(item.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });

  const comment = useMutation({
    mutationFn: (body: string) => api.comment(item.id, body, key.current),
    onSuccess: () => {
      form.current?.reset();
      key.current = newIdempotencyKey(); // the next comment is a new action
      qc.invalidateQueries({ queryKey: ['activity', item.id] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not post the comment. Try again.', 'error'),
  });

  const events = history.data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <section className="timeline" aria-labelledby="history-title">
      <h2 id="history-title">History and comments</h2>

      {canComment && (
        <form
          ref={form}
          className="comment-form"
          onSubmit={(e) => {
            e.preventDefault();
            const body = String(new FormData(e.currentTarget).get('body')).trim();
            if (body) comment.mutate(body);
          }}
        >
          <label className="field">
            <span className="visually-hidden">Add a comment</span>
            <textarea name="body" rows={2} maxLength={10000} placeholder="Add a comment: what you found, what you decided, what's next" />
          </label>
          <button type="submit" className="btn" disabled={comment.isPending}>Comment</button>
        </form>
      )}

      <ol className="events">
        {comment.isPending && (
          <li className="event pending">
            <div className="event-line"><strong>{me.name}</strong> commented <span className="muted small">Sending…</span></div>
            <blockquote>{comment.variables}</blockquote>
          </li>
        )}
        {events.map((e) => (
          <li key={e.id} className={`event event-${e.type}`}>
            <div className="event-line">
              <strong>{e.actor_name}</strong> {describeEvent(e)}
              <time className="muted small" dateTime={e.created_at} title={formatTime(e.created_at)}>{relative(e.created_at)}</time>
            </div>
            {e.type === 'commented' && <blockquote>{e.payload.body}</blockquote>}
          </li>
        ))}
      </ol>
      {history.hasNextPage && (
        <button type="button" className="btn" onClick={() => history.fetchNextPage()} disabled={history.isFetchingNextPage}>
          Show older history
        </button>
      )}
    </section>
  );
}
