// Wraps a list page. On wide screens it adds a panel on the right showing the
// selected item (?item=42); on narrower screens it renders the list alone and
// rows link to the full item page as before.
import type { ReactNode } from 'react';
import type { Me } from '../api';
import { ItemView } from '../pages/ItemDetail';
import { useCloseHref, useIsWide, useSelectedItemId } from '../split';

export function SplitView({ me, children }: { me: Me; children: ReactNode }) {
  const wide = useIsWide();
  const selected = useSelectedItemId();
  const closeHref = useCloseHref();

  if (!wide) return <>{children}</>;

  return (
    <div className="split">
      <div className="split-list">{children}</div>
      <section className="split-panel" aria-label="Item details">
        {selected ? (
          <ItemView key={selected} me={me} id={selected} variant="panel" closeHref={closeHref} />
        ) : (
          <div className="panel-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M13 4v16M16 9h2M16 12h2" />
            </svg>
            <p>Select an item to see its details here.</p>
            <p className="muted small">The list stays where it is, so you can work through it one item at a time.</p>
          </div>
        )}
      </section>
    </div>
  );
}
