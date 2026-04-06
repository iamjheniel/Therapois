import { Page, expect } from '@playwright/test';

export class CRMActivities {
  constructor(private page: Page) {}

  // ✅ Use getters, not class fields
  get activityInput() {
    return this.page.getByRole('textbox', {
      name: 'Enter activity details',
    });
  }

  get surfaceToast() {
    return this.page.getByTestId('surface');
  }

   async openActivities() {
    await this.page.getByText('Aktivitäten').click();
  }

  async createActivity(text: string) {
    await this.activityInput.click();
    await this.activityInput.fill(text);
    await this.page.getByText('Save').click();
    await expect(this.surfaceToast).toContainText(
      'Activity created successfully'
    );
  }

  async createIssue(text: string, type: string) {
  await this.activityInput.fill(text);

  // Open Select
  const selectDropdown = this.page
    .locator('div.css-146c3p1')
    .filter({ hasText: 'Select' })
    .last();

  await expect(selectDropdown).toBeVisible();
  await selectDropdown.click();

  // Click option
  const issueOption = this.page
    .locator('div.css-146c3p1')
    .filter({ hasText: type })
    .last();

  await expect(issueOption).toBeVisible();
  await issueOption.click();

  await this.page.getByText('Save').click();
  await expect(this.surfaceToast).toContainText(
    'Activity created successfully'
  );
}

  async resolveFirstIssue(note: string) {
    await this.page.getByText('Resolve').first().click();
    const noteInput = this.page.getByRole('textbox', {
      name: /(Optional).*[Rr]esolution|[Rr]esolution.*note/i,
    });
    await noteInput.fill(note);
    await this.page.getByText('Confirm', { exact: true }).click();
    await expect(this.page.getByTestId('surface')).toContainText(
      'Issue resolved'
    );
  }

  async createNextActivity(activityText: string, todoText: string) {
    await this.activityInput.fill(activityText);
    await this.page
      .locator('div')
      .filter({ hasText: /^\+3D$/ })
      .first()
      .click();

    const todoInput = this.page.getByRole('textbox', {
      name: 'What needs to be done?',
    });
    await todoInput.fill(todoText);
    await this.page.getByText('Save').click();

    await expect(this.page.getByTestId('surface')).toContainText(
      'Activity created successfully'
    );
    await expect(this.page.locator('#root')).toContainText(todoText);
  }

  async completeActivity(note: string, index = 1) {
    await this.page.getByText('Complete').nth(index).click();
    const noteInput = this.page.getByRole('textbox', {
      name: '(Optional) Completion note...',
    });
    await noteInput.fill(note);
    await this.page.getByText('Confirm', { exact: true }).click();
    await expect(this.page.getByTestId('surface')).toContainText(
      'Next activity completed'
    );
  }
}
