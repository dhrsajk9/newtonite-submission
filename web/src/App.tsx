import { NavLink, Route, Routes, Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Me } from './api';
import { NotificationBell } from './components/NotificationBell';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { ItemList } from './pages/ItemList';
import { ItemDetail } from './pages/ItemDetail';
import { NewItem } from './pages/NewItem';

const ROLE_WORD = { viewer: 'Viewer', member: 'Member', lead: 'Lead' } as const;

export function App() {
  // `null` = known to be logged out (set on a 401 or after logout).
  const { data: me, isPending } = useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: () => api.me().catch(() => null),
    staleTime: Infinity,
  });

  if (isPending) return <div className="boot" aria-busy="true">Loading…</div>;
  if (!me) return <Login />;
  return <Shell me={me} />;
}

function Shell({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      // Mark the user as logged out FIRST: <App> is watching ['me'] and switches to
      // the login screen. (Calling qc.clear() first would delete that very query, so
      // <App> would never hear about it and the screen wouldn't change.)
      qc.setQueryData(['me'], null);
      // Then drop everything else this user loaded, so the next person to log in
      // on this browser never sees it, and start them on the home page.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      navigate('/', { replace: true });
    },
  });
  const canCreate = me.teams.some((t) => t.role !== 'viewer');

  return (
    <div className="shell">
      <a href="#main" className="skip">Skip to content</a>
      <aside className="rail">
        <Link to="/" className="brand">Newtonite<span>Work items</span></Link>
        <nav aria-label="Main">
          <NavLink to="/" end>Needs attention</NavLink>
          <NavLink to="/items">All items</NavLink>
        </nav>
        {canCreate && <Link to="/items/new" className="btn btn-primary rail-new">New item</Link>}
        <div className="rail-teams">
          <h2>Your teams</h2>
          <ul>
            {me.teams.map((t) => (
              <li key={t.id}>
                <Link to={`/items?team=${t.id}`}>{t.name}</Link>
                <span className="role">{ROLE_WORD[t.role]}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rail-user">
          <span>{me.name}</span>
          <button type="button" className="link-button" onClick={() => logout.mutate()}>Log out</button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <NotificationBell />
        </header>
        <main id="main" tabIndex={-1}>
          <Routes>
            <Route path="/" element={<Dashboard me={me} />} />
            <Route path="/items" element={<ItemList me={me} />} />
            <Route path="/items/new" element={<NewItem me={me} />} />
            <Route path="/items/:id" element={<ItemDetail me={me} />} />
            <Route path="*" element={<p className="page">This page doesn't exist. <Link to="/">Go to Needs attention</Link>.</p>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
