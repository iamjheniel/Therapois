import { test } from '@playwright/test';
import { CRMBasePage } from '../../Pages/crm/crm.base.page';
import { CRMListPage } from '../../Pages/crm/crm.list.page';
import { CRMFollowUpOrdersPage } from '../../Pages/crm/crm.follow-up-orders.page';

test.describe('Admin CRM Practice Info', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard');
  });

  test(
    'CRM Initial Orders Add Notes and Generate PDF',
    { tag: ['@Admin', '@CRMFollowUpOrder'] },
    
    async ({ page }) => {
        const crm = new CRMBasePage(page);
        const followUpOrders = new CRMFollowUpOrdersPage(page);
        const crmList = new CRMListPage(page);

    await crm.openCRM(); // ✅ belongs to CRMPage
    await crmList.openPracticeView();
    await followUpOrders.openFollowUpOrders(); // now VOs load
    await followUpOrders.openBulkActions();
    await followUpOrders.addNote('test automation');
    await followUpOrders.openBulkActions();
    await followUpOrders.generateFollowUpOrderForm();
    await followUpOrders.downloadPDF();

   
    }
  );

  test(
    'CRM Initial Orders Change Status',
    { tag: ['@Admin', '@CRMFollowUpOrder'] },
    
    async ({ page }) => {
        const crm = new CRMBasePage(page);
        const followUpOrders = new CRMFollowUpOrdersPage(page);
        const crmList = new CRMListPage(page);

    await crm.openCRM(); // ✅ belongs to CRMPage
    await crmList.openPracticeView();
    await followUpOrders.openFollowUpOrders(); // now VOs load
    await followUpOrders.openBulkActions();
    await followUpOrders.changeStatusToBestellt();
   
    }
  );
});