// Integration tests for login, sessions and logout, against the real database.
import { describe, expect, it } from 'vitest';
import { login, setupApp } from './helpers.js';

const app = setupApp();

describe('login', () => {
  it('returns the user with their role in each team, and sets an httpOnly cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'asha@newtonite.test', password: 'password123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'Asha Rao',
      teams: [
        { name: 'Customer Support', role: 'viewer' },
        { name: 'Payments', role: 'lead' },
      ],
    });
    const cookie = res.cookies.find((c) => c.name === 'sid')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(res.body).not.toContain('password_hash');
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'asha@newtonite.test', password: 'nope' },
    });
    const unknownEmail = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'nobody@newtonite.test', password: 'nope' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });

  it('rejects a malformed body with a 400 listing the bad fields', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'not-an-email' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.fields.map((f: { path: string }) => f.path)).toEqual(['email', 'password']);
  });
});

describe('sessions', () => {
  it('requires a session for protected routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a made-up session token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: 'sid=forged' } });
    expect(res.statusCode).toBe(401);
  });

  it('logout revokes the session immediately', async () => {
    const cookie = await login(app, 'ravi');
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });

    // The same cookie no longer works, even though it hasn't expired.
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
