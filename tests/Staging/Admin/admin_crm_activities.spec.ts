import { test } from '@playwright/test';
import { CRMBasePage } from '../../../Pages/crm/crm.base.page';
import { CRMListPage } from '../../../Pages/crm/crm.list.page';
import { CRMActivities } from '../../../Pages/crm/crm.activities.page';

test.describe('Admin CRM Activities', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('https://staging.therapios.de/dashboard', { waitUntil: 'domcontentloaded' });
  });

  test(
    'CRM Create Activity',
    { tag: ['@Admin', '@CRMActivities'] },
    
    async ({ page }) => {
        const crm = new CRMBasePage(page);
        const crmList = new CRMListPage(page);
        const activities = new CRMActivities(page);
        

    await crm.openCRM(); // ✅ belongs to CRMPage
    await crmList.openPracticeView(); // ✅ belongs to CRMListPage
    await activities.openActivities();
    await activities.createActivity('Follow-up needed');

    }
  );
    test(
    'CRM Create Issue',
    { tag: ['@Admin', '@CRMCreateIssue'] },
    
    async ({ page }) => {
        const crm = new CRMBasePage(page);
        const crmList = new CRMListPage(page);
        const activities = new CRMActivities(page);
        

    await crm.openCRM(); // ✅ belongs to CRMPage
    await crmList.openPracticeView(); // ✅ belongs to CRMListPage
    await activities.openActivities();
    await activities.createIssue('Follow-up needed', 'Cannot Reach Practice');

    }
  );


  test(
    'CRM Resolve Issue',
    { tag: ['@Admin', '@CRMResolveIssue'] },
    
    async ({ page }) => {
        const crm = new CRMBasePage(page);
        const crmList = new CRMListPage(page);
        const activities = new CRMActivities(page);
        

    await crm.openCRM(); // ✅ belongs to CRMPage
    await crmList.openPracticeView(); // ✅ belongs to CRMListPage
    await activities.openActivities();
    await activities.resolveFirstIssue('test automation');

    }
  );
    test(
    'CRM Create Next Activity',
    { tag: ['@Admin', '@CRMActivities'] },
    
    async ({ page }) => {
        const crm = new CRMBasePage(page);
        const crmList = new CRMListPage(page);
        const activities = new CRMActivities(page);
        

    await crm.openCRM(); // ✅ belongs to CRMPage
    await crmList.openPracticeView(); // ✅ belongs to CRMListPage
    await activities.openActivities();
    await activities.createNextActivity('test automation', '3D');

    }
  );

    test(
    'CRM Complete Next Activity',
    { tag: ['@Admin', '@CRMActivities'] },
    
    async ({ page }) => {
        const crm = new CRMBasePage(page);
        const crmList = new CRMListPage(page);
        const activities = new CRMActivities(page);
        

    await crm.openCRM(); // ✅ belongs to CRMPage
    await crmList.openPracticeView(); // ✅ belongs to CRMListPage
    await activities.openActivities();
    await activities.completeActivity('test automation');

    }
  );
});