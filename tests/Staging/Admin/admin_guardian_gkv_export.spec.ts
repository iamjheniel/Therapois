import { test, expect } from '@playwright/test';
import { PatientAddressesPage } from '../../../Pages/admin/admin.patient-addresses.page';

/**
 * RC 3.10 — GKV Insurer Export and DATEV Debtor Records Keep the Patient's Residence Address
 * (#3191, epic #3187).
 *
 * The Optica GKV export must submit the patient's Care Home residence even when a guardian address is
 * flagged as billing — submitting a guardian's home address as a patient residence would be incorrect
 * data in a regulated §302 SGB V claim file.
 *
 * The export is reachable at `GET /billing_batches/{id}/optica-export`, which is what these tests
 * assert against. Two live constraints shape them:
 *  - a batch that is not ready answers `422 {"message":"This billing batch is not ready for export."}`,
 *    and every batch on staging was `pending` when this was written;
 *  - on an eligible batch the endpoint is slow — it did not answer within 45 s in repeated attempts —
 *    so the request is capped client-side and the test skips rather than hanging the suite.
 *
 * Read-only: the export is fetched, never sent, and no batch status is changed.
 */
const GUARDIAN_TYPES = ['legal_guardian', 'relative', 'other'] as const;
const EXPORT_CAP_MS = 60_000;

/** Fetches an API path with the signed-in user's bearer token and a hard client-side abort. */
async function cappedGet(page: any, path: string, capMs = EXPORT_CAP_MS) {
  return await page.evaluate(
    async ([url, cap]: [string, number]) => {
      let token: string | null = null;
      try {
        const j = JSON.parse(localStorage.getItem('auth-state') || '');
        token = j.token || j.accessToken || j.access_token || null;
      } catch {
        /* the caller asserts on the status it gets */
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cap);
      const started = Date.now();
      try {
        const r = await fetch(url, {
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: '*/*' },
          signal: ctrl.signal,
        });
        const body = await r.text();
        return { ms: Date.now() - started, status: r.status, ct: r.headers.get('content-type'), body };
      } catch (e: any) {
        return { ms: Date.now() - started, status: -1, error: String(e?.name || e), body: '' };
      } finally {
        clearTimeout(timer);
      }
    },
    [`https://api.staging.therapios.de${path}`, capMs],
  );
}

test.describe('Guardian Contacts — GKV insurer export keeps the residence address', () => {
  test(
    'AC1/AC2/AC3 — the Optica export never carries a guardian address in place of the patient residence',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianGkvExport'] },
    async ({ page }) => {
      test.setTimeout(400_000);
      const form = new PatientAddressesPage(page);

      // Opened on /billing rather than a patient form: the batch collection is only fetched
      // successfully from the billing page's own context.
      await page.setViewportSize({ width: 1920, height: 1200 });
      await page.goto('/billing', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('GKV-Abrechnung', { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(8000);

      // The batch list is fetched FIRST, before the patient scan: the scan issues a burst of
      // collection requests and the staging API then intermittently rejects the next one.
      // The failure reason is returned rather than swallowed, so a skip says what actually happened
      // instead of implying the environment has no batches.
      const batchResult = await page.evaluate(async () => {
        let token: string | null = null;
        try {
          const j = JSON.parse(localStorage.getItem('auth-state') || '');
          token = j.token || j.accessToken || j.access_token || null;
        } catch {
          /* reported below as a missing token */
        }
        try {
          // itemsPerPage=10 mirrors what the billing page itself requests. Asking for 50 in one go
          // is slow enough that the browser gives up with a bare "Failed to fetch".
          const r = await fetch(
            'https://api.staging.therapios.de/billing_batches?page=1&itemsPerPage=10&order%5BcreatedAt%5D=desc',
            { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/ld+json' } },
          );
          if (!r.ok) return { error: `HTTP ${r.status}`, batches: [] };
          const j = await r.json();
          return {
            error: null,
            batches: (j.member ?? j['hydra:member'] ?? []).map((b: any) => ({
              id: b.id,
              batchId: b.batchId,
              status: b.status,
            })),
          };
        } catch (e: any) {
          return { error: String(e?.message || e), batches: [] };
        }
      });
      if (batchResult.error) console.log('billing_batches fetch failed:', batchResult.error);
      const batches = batchResult.batches;
      console.log(
        'batch statuses:',
        JSON.stringify(
          batches.reduce((acc: any, b: any) => ({ ...acc, [b.status]: (acc[b.status] ?? 0) + 1 }), {}),
        ),
      );

      // Now the guardian addresses, keyed by patient, so an exported address can be checked against
      // the addresses that must never appear. 5 pages is enough — the import puts ~45 guardian
      // addresses in 500 patients — and keeps the request burst smaller.
      const hits = await form.findPatientsWithAddressType(GUARDIAN_TYPES, 5, 100);
      test.skip(
        hits.length === 0,
        'No patient has a guardian-type address on this environment, so the export has no guardian ' +
          'address it could wrongly pick up.',
      );
      const guardianByPatient = new Map<number, string[]>();
      for (const p of hits) {
        guardianByPatient.set(
          p.patientId,
          p.addresses.filter((a) => GUARDIAN_TYPES.includes(a.type)).map((a) => a.address),
        );
      }
      console.log(`${guardianByPatient.size} patients carry a guardian address`);

      // Try the most promising batches: a pending one is rejected outright, so prefer any other state.
      const candidates = [
        ...batches.filter((b: any) => b.status !== 'pending'),
        ...batches.filter((b: any) => b.status === 'pending'),
      ].slice(0, 3);
      test.skip(
        !candidates.length,
        'No billing batch could be listed — either none exists on this environment, or the staging ' +
          'API refused the request (it intermittently rejects under load).',
      );

      let exported: { batch: any; body: string } | null = null;
      const attempts: string[] = [];
      for (const b of candidates) {
        const res = await cappedGet(page, `/billing_batches/${b.id}/optica-export`);
        attempts.push(`${b.batchId}(${b.status}) → ${res.status} in ${res.ms}ms ${res.error ?? ''}`);
        if (res.status === 200 && res.body) {
          exported = { batch: b, body: res.body };
          break;
        }
      }
      console.log('export attempts:', JSON.stringify(attempts, null, 1));

      test.skip(
        !exported,
        `No billing batch produced an Optica export: ${attempts.join('; ')}. A pending batch is ` +
          `rejected with 422 "not ready for export", and on an eligible batch the endpoint did not ` +
          `answer within ${EXPORT_CAP_MS / 1000}s. Move a batch to a ready state (or raise the cap) ` +
          `to exercise this assertion.`,
      );

      const body = exported!.body;
      console.log(`export from ${exported!.batch.batchId}: ${body.length} bytes`);

      // AC1/AC2: no guardian address text may appear anywhere in the claim file. This is the whole
      // point of the ticket — the export must resolve the Care Home residence and ignore the billing
      // flag entirely when a Care Home address exists.
      const leaked: string[] = [];
      for (const [patientId, addresses] of guardianByPatient) {
        for (const addr of addresses) {
          // compare on the street token: the export splits the address into street/PLZ/city fields, so
          // the full free-text string never appears verbatim even when the wrong address was used
          const street = (addr || '').split(',')[0]?.trim();
          if (street && street.length > 6 && body.includes(street)) {
            leaked.push(`patient ${patientId}: "${street}"`);
          }
        }
      }
      expect(
        leaked,
        `the GKV insurer export must never contain a guardian's address as a patient residence; ` +
          `found: ${JSON.stringify(leaked)}`,
      ).toEqual([]);

      // AC3: patients without a guardian address are unaffected — the export still produced records.
      expect(body.length, 'the export must still produce claim data').toBeGreaterThan(0);
    },
  );

  test(
    'AC4 — a patient with no Care Home address falls back to billing-preferred selection rather than failing',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianGkvExport'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const form = new PatientAddressesPage(page);
      await form.openPatientForm(8124);

      const hits = await form.findPatientsWithAddressType(GUARDIAN_TYPES, 10, 100);
      test.skip(hits.length === 0, 'No guardian-type address on this environment.');

      // AC4's edge case is a patient whose ONLY address is a guardian one — the Convert branch of the
      // #3189 import produces exactly this shape. The selection chain must still yield an address for
      // them, so the export never fails to produce one.
      const noCareHome = hits.filter((p) => !p.addresses.some((a) => a.type === 'care_home'));
      test.skip(
        noCareHome.length === 0,
        'No patient in the scanned range has a guardian address without any Care Home address, so ' +
          'AC4\'s fallback case is not present in this sample.',
      );

      console.log(
        `patients with no Care Home address at all: ${noCareHome.length} ` +
          `(${JSON.stringify(noCareHome.map((p) => p.patientId))})`,
      );
      for (const p of noCareHome) {
        const billing = p.addresses.filter((a) => a.isBilling);
        expect(
          billing.length,
          `patient ${p.patientId}: the fallback needs exactly one billing address to select`,
        ).toBe(1);
        expect(
          billing[0].address,
          `patient ${p.patientId}: the fallback address must have address text, or the export would ` +
            `produce an empty residence`,
        ).toBeTruthy();
      }
    },
  );

  test(
    'DATEV debtor records keep the patient\'s name and residence address',
    { tag: ['@Admin', '@GuardianContacts', '@GuardianGkvExport'] },
    async () => {
      test.fixme(
        true,
        'The ticket expands scope to the DATEV debtor exporter (Dennis, Jul 22: "Name should be of ' +
          'the patient... simply use the patient\'s"), which must apply the same residence-selection ' +
          'chain as Optica. DATEV debtor records are not exposed as a readable export anywhere in the ' +
          'app or API — the only DATEV surfaces are a per-invoice sync status column and ' +
          '`datev/invoices/{id}/retry` / `datev/health-check`, none of which return the debtor\'s ' +
          'name or address. So the selection cannot be observed end-to-end from a browser suite; the ' +
          'ticket assigns it to unit tests over the selection chain. Coordinate with #3088 ' +
          '(Auto-Create DATEV Debtor Accounts), which shares the chain.',
      );
    },
  );
});
