import { test, expect } from '@playwright/test';
import { LetterLayoutPage } from '../../../Pages/admin/admin.letter-layout.page';

/**
 * RC 3.11.3 (#3524) — the rebrand banner belongs on the two order forms Curano sends to practices,
 * and must never appear on the Infoblatt (signed in person, never leaves the building). The initial
 * order form's greeting must also lose its second comma.
 *
 * **AC1, AC2, AC5 and AC6 are deployed and pass on staging** (verified 2026-08-27). AC3 and AC4 are
 * `fixme`'d for want of a fixture, with the evidence recorded below.
 *
 * **The order forms are driven through `POST /preview`, not the CRM.** That is what the CRM modal
 * itself calls — `downloadAsBlob('preview', {template, data})` — and going straight to it buys two
 * things. First, reachability: no practice in the first 25 CRM rows has initial orders on staging,
 * so the documented UI route ("Bestellung" tab → select rows → "Generate Initial Order Form") is
 * not reliably available. Second, and more important, it lets BOTH `address` branches be rendered.
 * That matters for AC5: the double comma came from `{% if address != 'ER' %},{% endif %}`, so the
 * PRACTICE-address branch is the one that used to break, and testing only the 'ER' branch would
 * have passed against the bug.
 *
 * Because it never touches the CRM's shared practice, this spec does NOT need the
 * `tests/fixtures/crm-serial.ts` lock.
 */
test.describe('Rebrand banner on order forms (#3524)', () => {
  test.describe.configure({ mode: 'serial' });

  const GREETING = 'Sehr geehrtes Praxisteam';

  test(
    'Deployment probe — banner and greeting on both order forms',
    { tag: ['@Admin', '@OrderFormBanner', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const letters = new LetterLayoutPage(page);
      await letters.open();

      for (const template of ['order', 'follow_up'] as const) {
        for (const address of ['ER', 'practice'] as const) {
          const doc = await letters.orderForm(template, address);
          if (!doc.buffer) {
            console.log(`  ${doc.label}: not rendered`);
            continue;
          }
          const text = LetterLayoutPage.text(doc);
          const greeting = text.split('\n').filter((l) => l.includes(GREETING));
          console.log(
            `  ${doc.label}: ${doc.pages.length}p banner=${LetterLayoutPage.hasBanner(doc)} greeting=${JSON.stringify(greeting)}`,
          );
        }
      }
      // The probe's only hard assertion: the renderer answers at all.
      const probe = await letters.orderForm('order', 'ER');
      expect(probe.buffer, 'POST /preview must render an initial order form').not.toBeNull();
    },
  );

  // ── AC1 / AC2 ────────────────────────────────────────────────────────────────────────────────
  test(
    'AC1/AC2 — both order forms show the rebrand banner',
    { tag: ['@Admin', '@OrderFormBanner', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const letters = new LetterLayoutPage(page);
      await letters.open();

      for (const template of ['order', 'follow_up'] as const) {
        const doc = await letters.orderForm(template, 'ER');
        expect(doc.buffer, `${doc.label} must render`).not.toBeNull();
        console.log(`${doc.label}: banner=${LetterLayoutPage.hasBanner(doc)}`);
        expect(
          LetterLayoutPage.hasBanner(doc),
          `${doc.label} must carry the rebrand banner (#3524 ${template === 'order' ? 'AC1' : 'AC2'})`,
        ).toBe(true);
      }
    },
  );

  // ── AC5 / AC6 ────────────────────────────────────────────────────────────────────────────────
  test(
    'AC5/AC6 — the greeting reads with exactly one comma, on both address branches',
    { tag: ['@Admin', '@OrderFormBanner', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const letters = new LetterLayoutPage(page);
      await letters.open();

      for (const template of ['order', 'follow_up'] as const) {
        // 'practice' first: that is the branch the removed `{% if address != 'ER' %}` broke.
        for (const address of ['practice', 'ER'] as const) {
          const doc = await letters.orderForm(template, address);
          expect(doc.buffer, `${doc.label} must render`).not.toBeNull();
          const lines = LetterLayoutPage.text(doc)
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.includes(GREETING));
          console.log(`${doc.label}: ${JSON.stringify(lines)}`);
          expect(lines.length, `${doc.label} must print the greeting`).toBeGreaterThan(0);
          for (const line of lines) {
            expect(line, `${doc.label} greeting must not carry a double comma`).not.toContain(`${GREETING},,`);
            expect(line, `${doc.label} greeting must read "${GREETING},"`).toContain(`${GREETING},`);
          }
        }
      }
    },
  );

  // ── AC4 ──────────────────────────────────────────────────────────────────────────────────────
  //
  // NOT VERIFIABLE on staging today, and the reason is specific rather than "no data": the banner
  // only reached this environment on 2026-08-27, and the NEWEST Infoblatt on staging was rendered
  // 2026-07-30. Every Infoblatt here therefore predates the banner, so finding none on them proves
  // nothing about the exclusion — a pre-banner document has no banner regardless of the template.
  //
  // Measured 2026-08-27: 73 ib_records (28 signed / 12 for_relative_signing / 9 archived / 1
  // deleted); of the 50 newest, 15 have a downloadable PDF and 34 answer 404 from S3 (the stored
  // object is gone). All 15 readable ones are 2 pages, created 2026-07-21..2026-07-30, banner=false.
  //
  // Making this assertable needs an Infoblatt generated after the banner shipped, which means
  // completing the therapist IB signing wizard — a write the IB specs deliberately never make
  // (`ib_signature_overlay.spec.ts` and friends open the wizard and cancel).
  test.fixme(
    'AC4 — an Infoblatt never shows the banner',
    { tag: ['@Admin', '@OrderFormBanner', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const letters = new LetterLayoutPage(page);
      await letters.open();
      const records = await letters.infoblattRecords(50);
      let checked = 0;
      for (const r of records) {
        if (!r.file) continue;
        const doc = await letters.infoblattPdf(r.id);
        if (!doc.buffer) continue;
        checked++;
        expect(LetterLayoutPage.hasBanner(doc), `Infoblatt ${r.id} must never carry the banner`).toBe(false);
      }
      expect(checked, 'an Infoblatt rendered AFTER the banner shipped is required').toBeGreaterThan(0);
    },
  );

  test(
    'AC4 (evidence) — every readable Infoblatt, its render date and banner state',
    { tag: ['@Admin', '@OrderFormBanner', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(900_000);
      const letters = new LetterLayoutPage(page);
      await letters.open();

      const records = await letters.infoblattRecords(50);
      const byStatus: Record<string, number> = {};
      records.forEach((r) => { byStatus[r.status] = (byStatus[r.status] ?? 0) + 1; });
      console.log(`ib_records: ${records.length} byStatus=${JSON.stringify(byStatus)}`);

      let readable = 0;
      let missing = 0;
      let banners = 0;
      let newest = '';
      for (const r of records) {
        if (!r.file) continue;
        const doc = await letters.infoblattPdf(r.id);
        if (!doc.buffer) { missing++; continue; }
        readable++;
        const created = LetterLayoutPage.creationDate(doc) ?? '?';
        if (created > newest) newest = created;
        const banner = LetterLayoutPage.hasBanner(doc);
        if (banner) banners++;
        console.log(`  IB ${r.id} status=${r.status} created=${created} pages=${doc.pages.length} banner=${banner}`);
      }
      console.log(`readable=${readable} missingFromS3=${missing} withBanner=${banners} newestRender=${newest}`);
      console.log(
        banners === 0 && readable > 0
          ? 'No Infoblatt carries the banner — but every readable one predates the banner deploy, so AC4 is not yet PROVEN.'
          : `${banners} Infoblatt(s) carry the banner — AC4 would be violated if any was rendered after the deploy.`,
      );
      expect(readable + missing, 'staging must expose Infoblatt records').toBeGreaterThan(0);
    },
  );

  // ── AC3 ──────────────────────────────────────────────────────────────────────────────────────
  //
  // No negative fixture exists: all seven staging entities are `isRebranded: true` (the same gap
  // #3481's AC2 records), and no banner on/off switch is exposed — `/entities/{id}` carries only
  // `isRebranded`, and /settings, /system_settings, /app_settings, /configurations, /feature_flags
  // and /branding_settings all 404. So "banner off" cannot be produced from a client.
  //
  // Worth flagging to the PM regardless: `PreviewController` is documented as not being tied to a
  // specific entity server-side, and the order forms rendered here show the banner for a payload
  // that names no entity at all. If the banner is unconditional on this route rather than resolved
  // through `DocumentBrandingResolver`, AC3 would fail for a non-Curano entity once one exists.
  test.fixme(
    'AC3 — neither order form shows a banner for a non-Curano entity or with the switch off',
    { tag: ['@Admin', '@OrderFormBanner', '@ReadOnly'] },
    async () => {
      /* see the note above — no non-Curano entity and no banner switch on staging */
    },
  );
});
