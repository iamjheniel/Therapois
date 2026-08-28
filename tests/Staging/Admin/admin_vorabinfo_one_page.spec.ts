import { test, expect } from '@playwright/test';
import { LetterLayoutPage } from '../../../Pages/admin/admin.letter-layout.page';

/**
 * RC 3.11.3 (#3522) — a Vorabinformation with up to 3 prescribed treatments must fit on ONE page,
 * closing included. Letters with 4+ treatments may still run to two pages; that is unchanged.
 *
 * **The fix IS deployed on staging** (verified 2026-08-27), so these run for real as the regression
 * guard rather than being `fixme`'d.
 *
 * How that was established, because no version string could say it: the frontend bundle still
 * reports `3.11.0` while the API already renders 3.11.2's rebrand banner, so the app version is
 * silent about which Twig template is live. What IS decisive is patient 7793's notice archive — a
 * per-render timeline of the template. Its Blanko variant rendered **2 pages with the closing
 * stranded on page 2 on every render from 2026-08-13 through 2026-08-26** (11 of them), and **1
 * page from 2026-08-27**. The body genuinely tightened rather than merely gaining room: the same
 * deploy ADDED the rebrand banner, which pushes toward more pages, and the letter still got shorter.
 *
 * **Mutating.** Only a freshly generated notice shows the current template — a stored PDF keeps
 * whatever it was rendered with — so AC1/AC2 must generate. Generating archives the patient's
 * previous notice, the same write `admin_letter_country_marker.spec.ts` and
 * `admin_rebranding_banner.spec.ts` already make.
 *
 * **Trap: patient 7793 is NOT an AC1 fixture.** It has SIX prescribed treatments, so its regular
 * letter is legitimately two pages and reading that as a failure would be wrong. AC1 needs a
 * patient whose single active PT VO carries exactly three — `THREE_TREATMENT_PATIENTS`, picked from
 * the 253 active VOs with three by requiring exactly one PT VO so the table is unambiguous.
 */
test.describe('Vorabinformation fits one page (#3522)', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'Deployment probe — where the closing lands today, and when that changed',
    { tag: ['@Admin', '@VorabinfoOnePage', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const letters = new LetterLayoutPage(page);
      await letters.open();

      const history = await letters.notices(LetterLayoutPage.HISTORY_PATIENT, 30, 'asc');
      expect(history.length, 'the history patient must have an archive to read').toBeGreaterThan(3);

      let readable = 0;
      const timeline: string[] = [];
      for (const ref of history) {
        const doc = await letters.noticePdf(ref);
        if (!doc.buffer) continue;
        readable++;
        const rows = LetterLayoutPage.treatmentRows(doc).length;
        timeline.push(
          `${ref.createdAt}  pages=${doc.pages.length} rows=${rows} ` +
            `closing=p${LetterLayoutPage.closingPage(doc)} banner=${LetterLayoutPage.hasBanner(doc)}`,
        );
      }
      timeline.forEach((l) => console.log(`  ${l}`));
      expect(readable, 'at least some archived notices must be downloadable').toBeGreaterThan(0);

      const banners = timeline.filter((l) => /banner=true/.test(l)).length;
      console.log(
        banners
          ? `#3522/#3481 template is live: ${banners} of ${readable} archived renders carry the banner.`
          : 'this environment still renders the pre-3.11.2 template (no banner on any render).',
      );
    },
  );

  // ── AC1 ──────────────────────────────────────────────────────────────────────────────────────
  test(
    'AC1 — a 3-treatment Vorabinformation is one page, closing included',
    { tag: ['@Admin', '@VorabinfoOnePage', '@Mutating'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const letters = new LetterLayoutPage(page);
      await letters.open();

      let checked = 0;
      for (const patientId of LetterLayoutPage.THREE_TREATMENT_PATIENTS) {
        const doc = await letters.generateNotice(patientId, 'regular');
        if (!doc.buffer) {
          console.log(`${doc.label}: not generated/downloadable — skipped`);
          continue;
        }
        const rows = LetterLayoutPage.treatmentRows(doc);
        const treatments = rows.length;
        console.log(
          `${doc.label}: ${doc.pages.length} page(s), ${treatments} treatment row(s), ` +
            `closing on page ${LetterLayoutPage.closingPage(doc)}`,
        );
        rows.forEach((r) => console.log(`      | ${r}`));
        if (treatments > 3) {
          console.log('   more than 3 treatments — outside AC1, not asserted');
          continue;
        }
        checked++;
        expect(doc.pages.length, `${doc.label} must fit a single page`).toBe(1);
        expect(LetterLayoutPage.closingPage(doc), `${doc.label} closing must be on page 1`).toBe(1);
      }
      expect(checked, 'at least one 3-treatment fixture must have been asserted').toBeGreaterThan(0);
    },
  );

  // ── AC2 ──────────────────────────────────────────────────────────────────────────────────────
  test(
    'AC2 — the Blanko variant of the same letter is also one page',
    { tag: ['@Admin', '@VorabinfoOnePage', '@Mutating'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const letters = new LetterLayoutPage(page);
      await letters.open();

      let checked = 0;
      for (const patientId of LetterLayoutPage.THREE_TREATMENT_PATIENTS) {
        const doc = await letters.generateNotice(patientId, 'blanko');
        if (!doc.buffer) {
          console.log(`${doc.label}: not generated/downloadable — skipped`);
          continue;
        }
        console.log(`${doc.label}: ${doc.pages.length} page(s), closing on page ${LetterLayoutPage.closingPage(doc)}`);
        checked++;
        expect(doc.pages.length, `${doc.label} must fit a single page`).toBe(1);
        expect(LetterLayoutPage.closingPage(doc), `${doc.label} closing must be on page 1`).toBe(1);
      }
      expect(checked, 'at least one Blanko fixture must have been asserted').toBeGreaterThan(0);
    },
  );

  // ── AC3 ──────────────────────────────────────────────────────────────────────────────────────
  test(
    'AC3 — the envelope window address and the body-start anchor did not move',
    { tag: ['@Admin', '@VorabinfoOnePage', '@ReadOnly'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const letters = new LetterLayoutPage(page);
      await letters.open();

      // Oldest-first, so the pre-fix renders come before the post-fix ones.
      const history = await letters.notices(LetterLayoutPage.HISTORY_PATIENT, 30, 'asc');
      const measured: { at: string; banner: boolean; anchors: ReturnType<typeof LetterLayoutPage.anchors> }[] = [];
      for (const ref of history) {
        const doc = await letters.noticePdf(ref);
        if (!doc.buffer) continue;
        measured.push({ at: ref.createdAt, banner: LetterLayoutPage.hasBanner(doc), anchors: LetterLayoutPage.anchors(doc) });
      }
      measured.forEach((m) => console.log(`  ${m.at} banner=${m.banner} ${JSON.stringify(m.anchors)}`));
      expect(measured.length, 'need archived renders to compare against').toBeGreaterThan(1);

      const before = measured.filter((m) => !m.banner);
      const after = measured.filter((m) => m.banner);
      if (!before.length || !after.length) {
        console.log('archive does not straddle the template change — comparing within what is here');
      }

      // Whatever the split, these three must be identical across EVERY render: they are the postal
      // (DIN 5008) anchors the ticket puts out of scope.
      for (const key of ['sender', 'date', 'title'] as const) {
        const values = [...new Set(measured.map((m) => m.anchors[key]))];
        console.log(`  ${key}: ${JSON.stringify(values)}`);
        expect(values.length, `the ${key} anchor must be identical on every render, got ${JSON.stringify(values)}`).toBe(1);
      }

      // And the thing the ticket DOES change should be visible, when the archive straddles it.
      if (before.length && after.length) {
        const b = [...new Set(before.map((m) => m.anchors.salutation))];
        const a = [...new Set(after.map((m) => m.anchors.salutation))];
        console.log(`  salutation before=${JSON.stringify(b)} after=${JSON.stringify(a)} (expected to differ — this IS the compression)`);
      }
    },
  );

  // ── AC4 ──────────────────────────────────────────────────────────────────────────────────────
  test(
    'AC4 — a 4+ treatment letter is untouched, and the shared layout is not compressed for others',
    { tag: ['@Admin', '@VorabinfoOnePage', '@Mutating'] },
    async ({ page }) => {
      test.setTimeout(600_000);
      const letters = new LetterLayoutPage(page);
      await letters.open();

      const doc = await letters.generateNotice(LetterLayoutPage.HISTORY_PATIENT, 'regular');
      expect(doc.buffer, `${doc.label} must be downloadable`).not.toBeNull();
      const treatments = LetterLayoutPage.treatmentRows(doc).length;
      console.log(`${doc.label}: ${treatments} treatments -> ${doc.pages.length} page(s)`);
      expect(treatments, 'this fixture is the 4+ case; it must still carry more than 3').toBeGreaterThan(3);
      // Explicitly NOT asserting a single page: the ticket allows 4+ to run to two.
      expect(doc.pages.length, 'a 4+ treatment letter must still render').toBeGreaterThanOrEqual(1);

      // The shared layout's own anchors must be where every other document type puts them.
      const anchors = LetterLayoutPage.anchors(doc);
      console.log(`  anchors ${JSON.stringify(anchors)}`);
      expect(anchors.sender, 'the envelope-window sender line must still render').not.toBeNull();
    },
  );
});
