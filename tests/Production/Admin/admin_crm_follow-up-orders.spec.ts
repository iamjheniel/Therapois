import { test } from '@playwright/test';
import { CRMBasePage } from '../../../Pages/crm/crm.base.page';
import { CRMListPage } from '../../../Pages/crm/crm.list.page';
import { CRMFollowUpOrdersPage } from '../../../Pages/crm/crm.follow-up-orders.page';

test.describe('Admin CRM Practice Info', () => {
  // These tests walk the same practice list and select/mutate follow-up orders, so they must
  // not run in parallel with each other (shared backend state). Serial + a generous per-test
  // timeout: scanning up to a dozen practices for one with follow-up orders is inherently slow
  // and can otherwise exhaust the default 90s budget before the action even runs.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test(
    'CRM Initial Orders Add Notes and Generate PDF',
    { tag: ['@Admin', '@CRMFollowUpOrder'] },
    
    async ({ page }) => {
        const crm = new CRMBasePage(page);
        const followUpOrders = new CRMFollowUpOrdersPage(page);
        const crmList = new CRMListPage(page);

    const found = await crmList.openPracticeViewWithFollowUpOrders();
    test.skip(!found, 'No practice with follow-up orders (Nachverfolgung) available in this environment');
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

    const found = await crmList.openPracticeViewWithFollowUpOrders();
    test.skip(!found, 'No practice with follow-up orders (Nachverfolgung) available in this environment');
    // changeStatusToBestellt() selects an eligible row itself (rotating past already-"Bestellt"
    // rows), so no separate openBulkActions() call is needed here.
    await followUpOrders.changeStatusToBestellt();
   
    }
  );
});