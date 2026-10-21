import { expect, expectNoSideScroll, test } from './helpers.js';

// The mock's Rahman Garments owner has three unread notifications (step 17a added a requisition
// waiting for approval) and one read one
test('reads notifications from the bell', async ({ page }) => {
  await page.goto('/');
  const bell = page.getByRole('button', { name: 'Notifications, 3 unread' });
  await bell.click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(
    panel.getByText("The invitation email to rupa@rahmangarments.bounce couldn't be sent.", {
      exact: false,
    }),
  ).toBeVisible();
  await expectNoSideScroll(page);

  // A click marks it read and opens the page it is about
  await panel.getByRole('button', { name: /Nasrin Akter joined the workspace/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications, 2 unread' })).toBeVisible();

  await page.getByRole('button', { name: 'Notifications, 2 unread' }).click();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
});
