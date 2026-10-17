import { expect, type Browser, type Page } from '@playwright/test';

/** Opens a fresh browser session (its own cookies) and logs in as a demo user. */
export async function loginAs(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(name) }).click(); // demo account fills the form
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  return page;
}

/** Creates an item through the API as the logged-in user of `page`, and returns its id. */
export async function createItem(page: Page, team: string, fields: Record<string, unknown> = {}): Promise<number> {
  const me = await (await page.request.get('/api/auth/me')).json();
  const teamId = me.teams.find((t: { name: string }) => t.name === team).id;
  const res = await page.request.post('/api/items', {
    data: { team_id: teamId, title: `E2E ${Date.now()}`, type: 'task', priority: 'high', ...fields },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

export const unique = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
