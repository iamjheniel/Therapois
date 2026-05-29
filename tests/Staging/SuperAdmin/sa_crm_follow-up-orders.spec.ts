import { test } from '@playwright/test';
import { CRMBasePage } from '../../../Pages/crm/crm.base.page';
import { CRMListPage } from '../../../Pages/crm/crm.list.page';
import { CRMFollowUpOrdersPage } from '../../../Pages/crm/crm.follow-up-orders.page';

test.describe('Super Admin CRM Follow-up Orders', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard');
  });

  test(
    'CRM Follow-up Orders Add Notes and Generate PDF',
    { tag: ['@SuperAdmin', '@CRMFollowUpOrder'] },
    async ({ page }) => {
      const crm = new CRMBasePage(page);
      const followUpOrders = new CRMFollowUpOrdersPage(page);
      const crmList = new CRMListPage(page);

      await crm.openCRM();
      await crmList.openPracticeView();
      await followUpOrders.openFollowUpOrders();
      await followUpOrders.openBulkActions();
      await followUpOrders.addNote('test automation');
      await followUpOrders.openBulkActions();
      await followUpOrders.generateFollowUpOrderForm();
      await followUpOrders.downloadPDF();
    }
  );

  test(
    'CRM Follow-up Orders Change Status',
    { tag: ['@SuperAdmin', '@CRMFollowUpOrder'] },
    async ({ page }) => {
      const crm = new CRMBasePage(page);
      const followUpOrders = new CRMFollowUpOrdersPage(page);
      const crmList = new CRMListPage(page);

      await crm.openCRM();
      await crmList.openPracticeView();
      await followUpOrders.openFollowUpOrders();
      await followUpOrders.openBulkActions();
      await followUpOrders.changeStatusToBestellt();
    }
  );
});
