import { test, expect } from '../../fixtures/session';
import { PrivatBasisDatevPage as P } from '../../../Pages/superadmin/sa.privat-basis-datev.page';

/**
 * RC 3.15 #3818 on PRODUCTION — the ticket's own first-night item, read-only.
 *
 * The ticket names one Privat Basis item for the first nightly transfer after release: Stornorechnung
 * S326-6 (-630,00 €, VO 2978-21), reversing R326-10, which DATEV received on 2026-07-24 while the
 * VO was still PKV. Every request here is a GET; nothing triggers a job.
 *
 * ARMED: while production runs < 3.15, S326-6 must still be unsynced (the bug). Once production
 * reports 3.15 and a nightly window (21:30 UTC) has passed, it must read `synced`.
 */
test('#3818 production: S326-6 reaches DATEV after the first night on 3.15', {
  tag: ['@SuperAdmin', '@PrivatBasisDatev', '@ReadOnly'],
}, async ({ playwright }) => {
  const api = await playwright.request.newContext();
  try {
    const p = new P(api, 'https://api.app.therapios.de');
    await p.init({ email: 'sa.jhen@gmail.com', password: 'thera.rocks' });
    const version = (await (await api.get('https://api.app.therapios.de/status')).json()).version as string;
    const vo = (await p.get('/prescriptions?exact[prescriptionId]=2978-21')).member[0];
    const inv = (await p.get(`/invoices?prescription=${vo.id}&itemsPerPage=20`)).member;
    const storno = inv.find((i: any) => i.invoiceNumber === 'S326-6');
    const original = inv.find((i: any) => i.invoiceNumber === 'R326-10');
    console.log(`  production ${version}; VO ${vo.prescriptionId} ${vo.insuranceType}; R326-10 ${original?.status} sync=${original?.datevSyncStatus ?? '-'}; S326-6 ${storno?.status} sync=${storno?.datevSyncStatus ?? '-'} ${storno?.datevSyncedAt ?? ''}`);
    expect(vo.insuranceType, 'the VO is Privat Basis — why every nightly run skipped the Storno').toBe('privat_basis');
    expect(original?.datevSyncStatus, 'the original is in DATEV').toBe('synced');
    const [maj, min] = version.split('.').map(Number);
    if (maj * 100 + min < 315) {
      expect(storno?.datevSyncStatus ?? null, `pre-3.15 (${version}): the reversal has not gone out`).toBeNull();
      console.log('  → not deployed yet; re-run after the first 21:30 UTC night on 3.15');
    } else {
      expect(storno?.datevSyncStatus, 'on 3.15 after the first night: the reversal reached DATEV').toBe('synced');
    }
  } finally {
    await api.dispose();
  }
});
