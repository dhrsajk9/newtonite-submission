// Split view: on wide screens, lists open items in a panel on the right
// instead of navigating away. The selected item lives in the URL (?item=42),
// so the back button, reloads and shared links all keep the selection.
import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

/** Wide enough for a usable list AND a usable item panel side by side. */
const WIDE = '(min-width: 1360px)';

export function useIsWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

/** The id of the item open in the panel, if any. */
export function useSelectedItemId(): number | null {
  const [params] = useSearchParams();
  const id = Number(params.get('item'));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Where a row should link to: the panel (same page, ?item=42, filters kept)
 * on wide screens, or the full item page on narrow ones.
 */
export function useItemHref(): (id: number) => string {
  const wide = useIsWide();
  const location = useLocation();
  const [params] = useSearchParams();
  return (id) => {
    if (!wide || location.pathname.startsWith('/items/')) return `/items/${id}`;
    const next = new URLSearchParams(params);
    next.set('item', String(id));
    return `${location.pathname}?${next}`;
  };
}

/** A URL for the current page with the panel closed (filters kept). */
export function useCloseHref(): string {
  const location = useLocation();
  const [params] = useSearchParams();
  const next = new URLSearchParams(params);
  next.delete('item');
  const qs = next.toString();
  return qs ? `${location.pathname}?${qs}` : location.pathname;
}
