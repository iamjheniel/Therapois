import { test } from '@playwright/test';
import { CRMBasePage } from '../../../Pages/crm/crm.base.page';
import { CRMListPage } from '../../../Pages/crm/crm.list.page';
import { CRMActivities } from '../../../Pages/crm/crm.activities.page';

test.describe('Super Admin CRM Activities', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard');
  });

  test(
    'CRM Create Activity',
    { tag: ['@SuperAdmin', '@CRMActivities'] },
    async ({ page }) => {
      const crm = new CRMBasePage(page);
      const crmList = new CRMListPage(page);
      const activities = new CRMActivities(page);

      await crm.openCRM();
      await crmList.openPracticeView();
      await activities.openActivities();
      await activities.createActivity('Follow-up needed');
    }
  );

  test(
    'CRM Create Issue',
    { tag: ['@SuperAdmin', '@CRMCreateIssue'] },
    async ({ page }) => {
      const crm = new CRMBasePage(page);
      const crmList = new CRMListPage(page);
      const activities = new CRMActivities(page);

      await crm.openCRM();
      await crmList.openPracticeView();
      await activities.openActivities();
      await activities.createIssue('Follow-up needed', 'Cannot Reach Practice');
    }
  );

  test(
    'CRM Resolve Issue',
    { tag: ['@SuperAdmin', '@CRMResolveIssue'] },
    async ({ page }) => {
      const crm = new CRMBasePage(page);
      const crmList = new CRMListPage(page);
      const activities = new CRMActivities(page);

      await crm.openCRM();
      await crmList.openPracticeView();
      await activities.openActivities();
      await activities.resolveFirstIssue('test automation');
    }
  );

  test(
    'CRM Create Next Activity',
    { tag: ['@SuperAdmin', '@CRMActivities'] },
    async ({ page }) => {
      const crm = new CRMBasePage(page);
      const crmList = new CRMListPage(page);
      const activities = new CRMActivities(page);

      await crm.openCRM();
      await crmList.openPracticeView();
      await activities.openActivities();
      await activities.createNextActivity('test automation', '3D');
    }
  );

  test(
    'CRM Complete Next Activity',
    { tag: ['@SuperAdmin', '@CRMActivities'] },
    async ({ page }) => {
      const crm = new CRMBasePage(page);
      const crmList = new CRMListPage(page);
      const activities = new CRMActivities(page);

      await crm.openCRM();
      await crmList.openPracticeView();
      await activities.openActivities();
      await activities.completeActivity('test automation');
    }
  );
});
