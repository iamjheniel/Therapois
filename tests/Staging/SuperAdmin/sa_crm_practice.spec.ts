import { test } from '../../fixtures/crm-serial';
import { CRMBasePage } from '../../../Pages/crm/crm.base.page';
import { CRMListPage } from '../../../Pages/crm/crm.list.page';

test.describe('Super Admin CRM Practice Info', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test(
    'CRM filters and practice view',
    { tag: ['@SuperAdmin', '@CRMFilters'] },
    async ({ page }) => {
      const crmBase = new CRMBasePage(page);
      const crmList = new CRMListPage(page);

      await crmBase.openCRM();
      await crmBase.expectHeaderStats();

      await crmList.filterHasIssues();
      await crmList.filterTodayOverdue();
      await crmList.filterNoNextActivity();
      await crmList.resetFilters();

      await crmList.searchPractice('QA test');
      await crmList.clearFilters();

      await crmList.openPracticeView();
      await crmList.expectPracticeInfo();
      await crmList.closePracticeView();
    }
  );
});
