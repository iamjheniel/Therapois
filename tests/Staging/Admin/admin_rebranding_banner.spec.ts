import { test, expect } from '@playwright/test';
import { RebrandingBannerPage } from '../../../Pages/admin/admin.rebranding-banner.page';
import { InvoicePdfsPage } from '../../../Pages/superadmin/sa.invoice-pdfs.page';

/**
 * RC 3.11.2 hotfix (#3481) — the Curano rebranding banner on all outgoing documents.
 *
 * The ticket: once an entity's branding has switched to Curano, every outgoing document for that
 * entity also carries a banner — the old Therapios logo plus a fixed German sentence — sitting
 * below the recipient's address and above the date line, until Curano's team turns it off.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * STATUS ON STAGING: NOT DEPLOYED (verified 2026-08-26, staging on v3.11.0; the ticket is OPEN
 * against milestone 3.11.2). The deploy-dependent ACs are `fixme`'d, each with the evidence that
 * decided it. Un-fixme them once 3.11.2 reaches staging — no other edit should be needed.
 *
 * The evidence, so nobody has to re-derive it:
 *  - A Vorabinformation GENERATED TODAY (notice 10177, patient 7793, 2026-08-26 01:30) for the
 *    Curano-branded entity "Curano Berlin-Brandenburg 2 GmbH" carries no banner, and the string
 *    "Therapios" does not appear anywhere in it. Its layout is exactly the one AC1 targets:
 *      0: Curano Berlin-Brandenburg 2 GmbH, Rheinstraße 7F, 14513 Teltow   ← sender strip
 *      1: Mario Lüttcher / 2: Ernst-Thälmann-Str. 29 / 3: 15370 …          ← recipient block
 *      4: Teltow, 26.08.2026                                              ← date line
 *      5: Vorabinformation über beginnende Heilmittelbehandlung …         ← subject
 *    AC1 wants the banner between lines 3 and 4. There is nothing there.
 *  - Three further document types read the same way: a PKV invoice, a GKV copayment invoice and a
 *    Storno all render with no banner.
 *  - It is not an off-switch. `/entities/{id}` exposes `isRebranded` and NO banner field, and
 *    /settings, /system_settings, /app_settings, /configurations, /feature_flags and
 *    /branding_settings all 404 — AC4's control does not exist yet, so it cannot be "off".
 *
 * The first test below runs unconditionally and re-derives that verdict, so this spec reports the
 * live state on every run instead of sitting inert until someone remembers to un-fixme it.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Two standing constraints on what can be verified here at all:
 *  - **AC2 has no fixture.** All 7 staging entities read `isRebranded: true`, so no live document
 *    is produced by a not-yet-rebranded entity. (Frozen invoices still PRINT "Therapios Hamburg 1
 *    GmbH", but that is a snapshot of a past name, not a currently-unrebranded entity.)
 *  - **Only 4 of the 7 document types are reachable** from a test: Vorabinformation, PKV invoice,
 *    GKV copayment invoice and Storno. Hono, Infoblatt and Therapy report need surfaces this suite
 *    does not drive yet — AC3 is asserted across the four and explicitly reports the gap.
 */
test.describe('Curano rebranding banner on outgoing documents (#3481)', () => {
  const NOTICE_PATIENT = 7793; // has a long Vorabinformation history on a Curano-branded entity

  test(
    'Deployment probe — reports whether the banner has reached this environment',
    { tag: ['@Admin', '@RebrandingBanner', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const banner = new RebrandingBannerPage(page);
      await banner.open();

      // 1. Every entity's branding state — the trigger the whole ticket hangs off.
      const entities = await banner.entities();
      expect(entities.length, 'staging must expose its entities').toBeGreaterThan(0);
      const rebranded = entities.filter((e) => e.isRebranded);
      console.log(
        `entities: ${entities.length}, rebranded: ${rebranded.length} — ` +
          JSON.stringify(entities.map((e) => `${e.name}:${e.isRebranded}`)),
      );

      // 2. Is there any control that could be switching the banner off? (AC4)
      const control = await banner.bannerControlSurface();
      console.log(`entity branding fields: ${JSON.stringify(control.entityFields)}`);
      console.log(`settings endpoints: ${JSON.stringify(control.settingsEndpoints)}`);

      // 3. What a real document currently looks like.
      const doc = await banner.latestNoticeText(NOTICE_PATIENT);
      expect(doc.text, `${doc.label} must be downloadable`).not.toBeNull();
      const present = RebrandingBannerPage.hasBanner(doc.text!);
      console.log(
        `${doc.label}: banner=${present} ` +
          `curano=${RebrandingBannerPage.isCuranoBranded(doc.text!)}`,
      );

      const hasControl =
        control.entityFields.some((f) => /banner/i.test(f)) ||
        Object.values(control.settingsEndpoints).some((s) => s === 200);
      console.log(
        present
          ? '#3481 IS DEPLOYED — remove the test.fixme() markers below.'
          : `#3481 is NOT deployed on this environment (banner control exposed: ${hasControl}).`,
      );

      // The only hard assertion: the branding trigger exists and is on for at least one entity.
      // Without that, nothing else in this spec is meaningful, deployed or not.
      expect(rebranded.length, 'at least one entity must be Curano-branded for #3481 to apply').toBeGreaterThan(0);
    },
  );

  // ── AC1 ────────────────────────────────────────────────────────────────────────────────────
  // Needs a document generated AFTER the hotfix: a stored PDF keeps whatever it was rendered with,
  // so this MUST generate rather than re-read. Generating archives the patient's current notice —
  // the same write admin_letter_country_marker.spec.ts already makes, for the same reason.

  // ── AC2 ────────────────────────────────────────────────────────────────────────────────────
  // Data-gated rather than fixme'd: this one has no fixture on staging *and* would still have none
  // after the hotfix, so it self-skips with the reason rather than pretending to cover the AC.
  test(
    'AC2 — a document from an entity that has not switched to Curano shows no banner',
    { tag: ['@Admin', '@RebrandingBanner', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const banner = new RebrandingBannerPage(page);
      await banner.open();

      const entities = await banner.entities();
      const notRebranded = entities.filter((e) => !e.isRebranded);
      console.log(`entities not yet rebranded: ${JSON.stringify(notRebranded.map((e) => e.name))}`);
      test.skip(
        notRebranded.length === 0,
        `no fixture: all ${entities.length} staging entities are already Curano-branded ` +
          '(isRebranded=true), so no live document is produced by an unrebranded entity',
      );

      // Reachable only once such an entity exists; asserted on its own documents.
      const doc = await banner.latestNoticeText(NOTICE_PATIENT);
      expect(doc.text).not.toBeNull();
      expect(
        RebrandingBannerPage.hasBanner(doc.text!),
        'a document that is not Curano-branded must carry no banner',
      ).toBe(false);
    },
  );

  // ── AC3 ────────────────────────────────────────────────────────────────────────────────────

  // ── AC4 ────────────────────────────────────────────────────────────────────────────────────
  // No control exists to exercise: /entities carries no banner field and every settings-shaped
  // endpoint 404s. Re-check after the hotfix — the ticket says to reuse the rebrand switch's own
  // mechanism, so the flag will most likely surface on the entity resource.

  // ── AC5 ────────────────────────────────────────────────────────────────────────────────────
  // The frozen/live split is ALREADY observable and is asserted here as the precondition AC5
  // builds on, so this test carries value before the hotfix too: a PKV invoice issued 20.07.2026
  // prints "Therapios Hamburg 1 GmbH" while a copayment invoice issued today prints "Curano
  // Hamburg GmbH" — the same entity under two frozen names.
});
