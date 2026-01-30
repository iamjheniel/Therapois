import { Page } from '@playwright/test';

export class AppPage {
  constructor(protected page: Page) {}

  async openSideMenu() {
    await this.page.getByText('').click();
  }
}
