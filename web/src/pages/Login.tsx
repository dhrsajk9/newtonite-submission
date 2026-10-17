import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';

// Demo accounts from the seed data, so reviewers can switch roles in one click.
const DEMO = [
  { name: 'Asha Rao', email: 'asha@newtonite.test', roles: 'Lead in Payments, viewer in Support' },
  { name: 'Arjun Mehta', email: 'arjun@newtonite.test', roles: 'Lead in Payments and Engineering' },
  { name: 'Ravi Kumar', email: 'ravi@newtonite.test', roles: 'Member in Payments' },
  { name: 'Meera Iyer', email: 'meera@newtonite.test', roles: 'Member in Payments and Engineering' },
  { name: 'Kabir Shah', email: 'kabir@newtonite.test', roles: 'Lead in Support' },
  { name: 'Priya Nair', email: 'priya@newtonite.test', roles: 'Member in Support, viewer in Payments' },
  { name: 'Neha Gupta', email: 'neha@newtonite.test', roles: 'Member in Support and Engineering' },
  { name: 'Vikram Singh', email: 'vikram@newtonite.test', roles: 'Viewer in Engineering' },
];

export function Login() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api.login(email, password),
    onSuccess: (me) => qc.setQueryData(['me'], me),
  });

  return (
    <div className="login">
      <div className="login-panel">
        <h1 className="login-brand">Newtonite<span>Work items</span></h1>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
        >
          <label className="field">
            <span>Email</span>
            <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {login.error && (
            <p className="form-error" role="alert">
              {login.error instanceof ApiError ? login.error.message : 'Could not log in.'}
            </p>
          )}
          <button type="submit" className="btn btn-primary" disabled={login.isPending}>
            {login.isPending ? 'Logging in…' : 'Log in'}
          </button>
        </form>
      </div>

      <section className="login-demo" aria-labelledby="demo-title">
        <h2 id="demo-title">Demo accounts</h2>
        <p className="muted">Every password is <strong>password123</strong>. Pick a person to fill in the form.</p>
        <ul>
          {DEMO.map((d) => (
            <li key={d.email}>
              <button
                type="button"
                onClick={() => {
                  setEmail(d.email);
                  setPassword('password123');
                }}
              >
                <strong>{d.name}</strong>
                <span>{d.roles}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
