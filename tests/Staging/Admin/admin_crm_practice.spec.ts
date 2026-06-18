import { test } from '@playwright/test';
import { CRMBasePage } from '../../../Pages/crm/crm.base.page';
import { CRMListPage } from '../../../Pages/crm/crm.list.page';

test.describe('Admin CRM Practice Info', () => {
  test.beforeEach(async ({ page }) => {
    // Already authenticated via storageState
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test(
    'CRM filters and practice view',
    { tag: ['@Admin', '@CRMFilters'] },
    async ({ page }) => {
      const crmBase = new CRMBasePage(page);
      const crmList = new CRMListPage(page);

      // Open CRM
      await crmBase.openCRM();
      await crmBase.expectHeaderStats();

      // Filters
      await crmList.filterHasIssues();
      await crmList.filterTodayOverdue();
      await crmList.filterNoNextActivity();
      await crmList.resetFilters();

      // Search
      await crmList.searchPractice('QA test');
      await crmList.clearFilters();

      // Open Practice Info
      await crmList.openPracticeView();
      await crmList.expectPracticeInfo();
      await crmList.closePracticeView();
    }
  );
});
