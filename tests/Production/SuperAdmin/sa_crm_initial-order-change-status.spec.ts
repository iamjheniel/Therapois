import { test } from '../../fixtures/crm-serial';
import { CRMBasePage } from '../../../Pages/crm/crm.base.page';
import { CRMListPage } from '../../../Pages/crm/crm.list.page';
import { CRMInitialOrdersPage } from '../../../Pages/crm/crm.initial-orders.page';

test.describe('Super Admin CRM Initial Orders', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    // Walking practice rows for one with initial orders is slow, but the CRM timeout is owned by the
    // crm-serial fixture (a spec-level test.setTimeout here would clobber the lock-wait allowance).
    await page.goto('https://app.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test(
    'CRM Initial Orders Add Notes and Generate PDF',
    { tag: ['@SuperAdmin', '@CRMInitialOrder'] },
    async ({ page }) => {
      const crmBase = new CRMBasePage(page);
      const crmList = new CRMListPage(page);
      const initialOrders = new CRMInitialOrdersPage(page);

      const found = await crmList.openPracticeViewWithOrders();
      test.skip(!found, 'No practice with initial orders (Bestellung) available in this environment');
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

      const found = await crmList.openPracticeViewWithOrders();
      test.skip(!found, 'No practice with initial orders (Bestellung) available in this environment');
      // changeStatusToBestellt() selects an eligible row itself (rotating past already-"Bestellt"
      // rows), so no separate openBulkActions() call is needed here.
      await initialOrders.changeStatusToBestellt();
    }
  );
});
