import { test } from '@playwright/test';
import { CRMBasePage } from '../../../Pages/crm/crm.base.page';
import { CRMListPage } from '../../../Pages/crm/crm.list.page';
import { CRMInitialOrdersPage } from '../../../Pages/crm/crm.initial-orders.page';

test.describe('Admin CRM Practice Info', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard');
  });

  test(
    'CRM Initial Orders Add Noted and Generate PDF',
    { tag: ['@Admin', '@CRMInitialOrder'] },
    async ({ page }) => {
    const crmBase = new CRMBasePage(page);
    const crmList = new CRMListPage(page);
    const initialOrders = new CRMInitialOrdersPage(page);

    await crmBase.openCRM();
    await crmList.openPracticeView();       // 🔑 REQUIRED
    await initialOrders.openErstverordnungen(); // now VOs load
    await initialOrders.openBulkActions();
    await initialOrders.addNote('test automation');
    await initialOrders.openBulkActions();
    await initialOrders.generateInitialOrderForm();
    await initialOrders.downloadPDF();


    }
  );
    test(
    'CRM Initial Orders Change Status',
    { tag: ['@Admin', '@CRMInitialOrder'] },
    async ({ page }) => {
    const crmBase = new CRMBasePage(page);
    const crmList = new CRMListPage(page);
    const initialOrders = new CRMInitialOrdersPage(page);

    await crmBase.openCRM();
    await crmList.openPracticeView();       // 🔑 REQUIRED
    await initialOrders.openErstverordnungen(); // now VOs load
    await initialOrders.openBulkActions();
    await initialOrders.changeStatusToBestellt();

    }
  );
});
