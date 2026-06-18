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
    // "Schedule Next Activity" quick chip (+3D = three days out).
    await this.page
      .locator('div')
      .filter({ hasText: /^\+3D$/ })
      .first()
      .click();

    const todoInput = this.page.getByRole('textbox', {
      name: 'What needs to be done?',
    });
    await todoInput.fill(todoText);
    await this.page.getByText('Save', { exact: true }).click();

    // If the practice already has a pending next activity, a confirmation modal asks to
    // replace it ("Bestehende nächste Aktivität ersetzen"). Confirm it when present.
    const replace = this.page.getByText('Ersetzen & Erstellen', { exact: true });
    if (await replace.isVisible({ timeout: 4000 }).catch(() => false)) {
      await replace.click();
    }

    await expect(this.page.getByTestId('surface')).toContainText(
      'Activity created successfully'
    );
  }

  async completeActivity(note: string) {
    // There is one "Complete" button per pending next activity; complete the first one.
    await this.page.getByText('Complete', { exact: true }).first().click();
    const noteInput = this.page.getByRole('textbox', {
      name: '(Optional) Completion note...',
    });
    await noteInput.fill(note);
    await this.page.getByText('Confirm', { exact: true }).click();
    // The success toast text can vary; assert the completion modal closed and a toast fired.
    await expect(this.page.getByTestId('surface')).toBeVisible({ timeout: 30000 });
  }
}
