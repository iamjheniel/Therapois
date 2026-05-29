import { test } from '@playwright/test';
import { CRMBasePage } from '../../../Pages/crm/crm.base.page';
import { CRMListPage } from '../../../Pages/crm/crm.list.page';
import { CRMInitialOrdersPage } from '../../../Pages/crm/crm.initial-orders.page';

test.describe('Super Admin CRM Initial Orders', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard');
  });

  test(
    'CRM Initial Orders Add Notes and Generate PDF',
    { tag: ['@SuperAdmin', '@CRMInitialOrder'] },
    async ({ page }) => {
      const crmBase = new CRMBasePage(page);
      const crmList = new CRMListPage(page);
      const initialOrders = new CRMInitialOrdersPage(page);

      await crmBase.openCRM();
      await crmList.openPracticeView();
      await initialOrders.openErstverordnungen();
      await initialOrders.openBulkActions();
      await initialOrders.addNote('test automation');
      await initialOrders.openBulkActions();
      await initialOrders.generateInitialOrderForm();
      await initialOrders.downloadPDF();
    }
  );

  test(
    'CRM Initial Orders Change Status',
    { tag: ['@SuperAdmin', '@CRMInitialOrder'] },
    async ({ page }) => {
      const crmBase = new CRMBasePage(page);
      const crmList = new CRMListPage(page);
      const initialOrders = new CRMInitialOrdersPage(page);

      await crmBase.openCRM();
      await crmList.openPracticeView();
      await initialOrders.openErstverordnungen();
      await initialOrders.openBulkActions();
      await initialOrders.changeStatusToBestellt();
    }
  );
});
