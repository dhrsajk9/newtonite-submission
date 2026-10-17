// End-to-end checks of the behaviours the UI must get right when several
// people use the app at once. Each test uses separate browser sessions.
import { expect, test } from '@playwright/test';
import { createItem, loginAs, unique } from './helpers';

test('logging out returns to the login screen, and the next user sees only their own data', async ({ browser }) => {
  const page = await loginAs(browser, 'Ravi');
  await page.getByRole('link', { name: 'All items' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByText('Demo accounts')).toBeVisible();

  // Kabir logs in on the same browser: Customer Support only, nothing left over from Ravi.
  await page.getByRole('button', { name: /Kabir/ }).click();
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(page.locator('.rail-teams')).toContainText('Customer Support');
  await expect(page.locator('.rail-teams')).not.toContainText('Payments');
});

test('two people claim at once: one wins, the other is told who did', async ({ browser }) => {
  const [ravi, meera] = [await loginAs(browser, 'Ravi'), await loginAs(browser, 'Meera')];
  const id = await createItem(ravi, 'Payments');
  await ravi.goto(`/items/${id}`);
  await meera.goto(`/items/${id}`);

  await ravi.getByRole('button', { name: 'Claim' }).click();
  await expect(ravi.getByText('Claimed', { exact: true })).toBeVisible();

  // Meera's page still shows the Claim button: her view is stale.
  await meera.getByRole('button', { name: 'Claim' }).click();
  await expect(meera.getByText('Ravi Kumar has already claimed this item.')).toBeVisible();
  // Her optimistic "I own it" was rolled back to the server's truth.
  await expect(meera.locator('.facts')).toContainText('Ravi Kumar');
  await expect(meera.getByRole('button', { name: 'Claim' })).toHaveCount(0);
});

test('saving an outdated edit shows the other change and overwrites nothing', async ({ browser }) => {
  const [asha, ravi] = [await loginAs(browser, 'Asha'), await loginAs(browser, 'Ravi')];
  const id = await createItem(asha, 'Payments', { priority: 'medium' });
  await ravi.request.post(`/api/items/${id}/actions/claim`);

  await asha.goto(`/items/${id}`);
  await asha.getByRole('button', { name: 'Edit' }).click();
  await asha.getByLabel('Why it exists').fill('Bank confirmed the duplicate charge.');

  // Meanwhile Ravi raises the priority and saves first.
  await ravi.goto(`/items/${id}`);
  await ravi.getByRole('button', { name: 'Edit' }).click();
  await ravi.locator('label.seg-critical').click();
  await ravi.getByRole('button', { name: 'Save changes' }).click();
  await expect(ravi.getByText('Changes saved')).toBeVisible();

  await asha.getByRole('button', { name: 'Save changes' }).click();
  await expect(asha.getByText('Someone else saved first')).toBeVisible();
  await expect(asha.locator('.conflict')).toContainText('Priority: Critical');

  await asha.getByRole('button', { name: 'Keep my changes on top of theirs' }).click();
  await asha.getByRole('button', { name: 'Save changes' }).click();
  await expect(asha.getByText('Changes saved')).toBeVisible();

  // Both changes survived.
  const item = await (await asha.request.get(`/api/items/${id}`)).json();
  expect(item).toMatchObject({ priority: 'critical', description: 'Bank confirmed the duplicate charge.' });
});

test('a create request that reaches the server twice creates one item', async ({ browser }) => {
  const asha = await loginAs(browser, 'Asha');
  const title = unique('Retried create');
  // Simulate a flaky network: the first response is lost and the request is sent again.
  // (A disabled button stops double-clicks in the UI; this checks the server-side guarantee.)
  await asha.route('**/api/items', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();                  // first delivery: the server handles it, the answer is lost
    const retry = await route.fetch();    // same request again, same Idempotency-Key
    await route.fulfill({ response: retry });
  });
  await asha.goto('/items/new');
  await asha.getByLabel('Team').selectOption({ label: 'Payments' });
  await asha.getByLabel('Type').selectOption({ label: 'Task' });
  await asha.getByLabel('Title').fill(title);
  await asha.getByRole('button', { name: 'Create item' }).click();
  await expect(asha.getByRole('heading', { name: title })).toBeVisible();

  const found = await (await asha.request.get(`/api/items?q=${encodeURIComponent(`"${title}"`)}`)).json();
  expect(found.items.filter((i: { title: string }) => i.title === title)).toHaveLength(1);
});

test('rejecting needs a reason, and the reason is kept in the history', async ({ browser }) => {
  const [ravi, arjun] = [await loginAs(browser, 'Ravi'), await loginAs(browser, 'Arjun')];
  const id = await createItem(ravi, 'Payments', { type: 'payment' });
  const claimed = await (await ravi.request.post(`/api/items/${id}/actions/claim`)).json();
  await ravi.request.post(`/api/items/${id}/actions/request_approval`, { data: { version: claimed.version } });

  await arjun.goto(`/items/${id}`);
  await arjun.getByRole('button', { name: 'Reject…' }).click();
  const dialog = arjun.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Reject' }).click();          // no reason yet
  await expect(dialog).toBeVisible();                                    // still open: blocked
  await dialog.getByLabel('Reason').fill('Attach the bank statement.');
  await dialog.getByRole('button', { name: 'Reject' }).click();
  await expect(arjun.locator('.events')).toContainText('rejected the request: “Attach the bank statement.”');
  await expect(arjun.locator('.detail-badges')).toContainText('In progress');
});

test("a viewer sees no actions, and another team's item looks like it doesn't exist", async ({ browser }) => {
  const [priya, vikram] = [await loginAs(browser, 'Priya'), await loginAs(browser, 'Vikram')];
  const asha = await loginAs(browser, 'Asha');
  const id = await createItem(asha, 'Payments');

  await priya.goto(`/items/${id}`); // Priya views Payments
  await expect(priya.getByText("There's nothing you can do on this item right now.")).toBeVisible();
  await expect(priya.getByRole('button', { name: 'Claim' })).toHaveCount(0);

  await vikram.goto(`/items/${id}`); // Vikram is not in Payments at all
  await expect(vikram.getByRole('heading', { name: 'Item not found' })).toBeVisible();
});
