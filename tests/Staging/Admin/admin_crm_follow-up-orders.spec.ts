import { test } from '../../fixtures/crm-serial';
import { CRMBasePage } from '../../../Pages/crm/crm.base.page';
import { CRMListPage } from '../../../Pages/crm/crm.list.page';
import { CRMFollowUpOrdersPage } from '../../../Pages/crm/crm.follow-up-orders.page';

test.describe('Admin CRM Practice Info', () => {
  // These tests walk the same practice list and select/mutate follow-up orders, so they must not
  // run in parallel with each other (shared backend state). Serial mode covers within-file ordering;
  // the crm-serial fixture serializes across files/projects and owns the (generous) CRM timeout —
  // scanning up to a dozen practices for one with follow-up orders is inherently slow.
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
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