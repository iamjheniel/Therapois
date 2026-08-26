import { test, expect } from '@playwright/test';
import { LettersPage } from '../../../Pages/admin/admin.letters.page';

/**
 * RC 3.11 — Letter Addresses: Remove Stray Country Marker "D" (#3370).
 *
 * Patient addresses imported from TheOrg carry a leftover country marker. Before this fix the
 * clean-up only removed it at the very END of the address text, so an address that instead carries it
 * directly in front of the postal code ("Ernst-Thälmann-Str. 29, D 15370 Fredersdorf-Vogelsdorf")
 * printed the marker on the STREET line of every letter.
 *
 * **How this is asserted.** Letters are PDF-only — there is no HTML preview anywhere in the app — so
 * these tests read the text back out of the generated PDF (`Pages/util/pdf-text.ts`; the fonts are
 * subset-embedded but do carry `/ToUnicode` CMaps, which is what makes them readable). The assertion
 * is scoped to the recipient block rather than the whole document, because the marker is only a
 * defect when it lands on the address lines.
 *
 * **Why these tests generate a letter.** The fix is applied at render time; the stored address text is
 * deliberately unchanged. A PDF that was rendered before the deploy therefore still shows the marker
 * forever — the PR carries this as an explicit deploy step for previously-backfilled invoice PDFs. So
 * a letter has to be generated fresh for the assertion to mean anything. That is a write: it archives
 * the patient's current Vorabinformation and creates a new one. Nothing else is modified, and no
 * letter is ever sent.
 *
 * Fixture: patient 9020 (internal id 7793, Mario Lüttcher) — the staging reproduction named in the
 * ticket.
 */

/** The ticket's staging repro patient: internal id, and the address it has on file. */
const REPRO = { id: 7793, patientNumber: 9020, street: 'Ernst-Thälmann-Str. 29', plz: '15370' };

/**
 * AC1 row 3, present on staging verbatim: "Albert-Wiebach-Str. 1D, D 14513 Teltow" — a house number
 * ending in "D" AND a separate marker before the postal code.
 *
 * Only ATTACHED suffixes ("1D", "12D") are asserted. Staging also holds space-separated forms
 * ("Essener Straße 13 D, D 22419 Hamburg", "Hauptstr. 57 D, 10317 Berlin, D") which are genuinely
 * ambiguous — "13 D" is indistinguishable from a standalone marker by the token rule the ticket
 * specifies, and the ticket's own examples are all attached. Those are reported, not asserted.
 */
const HOUSE_NUMBER = { id: 7603, patientNumber: 8837 };

/**
 * When the fix reached staging — PR #3379 merged 2026-08-14, PM-verified 2026-08-15. Letters stored
 * before this date were rendered by the old code and still carry the marker.
 */
const FIX_DEPLOYED = '2026-08-14';

/** A line of a recipient block that still carries a country marker, if any. */
function markerLines(lines: string[]): string[] {
  return lines.filter((l) => LettersPage.MARKER_BEFORE_PLZ.test(l) || LettersPage.MARKER_TRAILING.test(l));
}

test.describe('Letter addresses — stray country marker', () => {
  test.describe.configure({ mode: 'serial' });

  test(
    'AC1/AC2 — a freshly generated Vorabinformation prints the street line without the marker',
    { tag: ['@Admin', '@LetterAddress', '@CountryMarker'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const letters = new LettersPage(page);
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);

      // Precondition: the stored address still carries the marker before the postal code. The fix is
      // a rendering fix — if the stored text had been cleaned instead, this test would pass for the
      // wrong reason, so the fixture is asserted rather than assumed.
      const addresses = await letters.addresses(REPRO.id);
      const marked = addresses.filter((a) => LettersPage.MARKER_BEFORE_PLZ.test(a.address || ''));
      test.skip(
        marked.length === 0,
        `Patient ${REPRO.patientNumber}'s stored address no longer carries a country marker before ` +
          `the postal code (${JSON.stringify(addresses.map((a: any) => a.address))}), so there is ` +
          `nothing for the renderer to strip. Restore the ticket's fixture address to run this.`,
      );
      console.log(`stored address: ${JSON.stringify(marked.map((a: any) => a.address))}`);

      // Both Vorabinformation variants are named in AC2, and they render through different templates.
      for (const variant of ['regular', 'blanko'] as const) {
        const created = await letters.generateNotice(REPRO.id, 'physiotherapy', variant);
        expect(created.status, `generating the ${variant} Vorabinformation`).toBe(200);

        const url = created.notice.signedFileUrl ?? (await letters.notices(REPRO.id))[0]?.signedFileUrl;
        expect(url, `the ${variant} Vorabinformation must expose a downloadable file`).toBeTruthy();

        const text = await letters.letterText(url);
        const block = LettersPage.recipientBlock(text);
        console.log(`${variant} recipient block: ${JSON.stringify(block)}`);

        expect(
          markerLines(block),
          `the ${variant} Vorabinformation must not print a country marker in the recipient block`,
        ).toEqual([]);

        // AC1 row 1: the street line reads the street alone and the postal code keeps its own line.
        expect(block, `the ${variant} letter must print the street without the marker`).toContain(REPRO.street);
        expect(
          block.some((l) => l.startsWith(REPRO.plz)),
          `the ${variant} letter must still print the postal code line, got ${JSON.stringify(block)}`,
        ).toBe(true);
      }
    },
  );

  test(
    'AC1 — the previously stored letter shows the bug the fix removes',
    { tag: ['@Admin', '@LetterAddress', '@CountryMarker'] },
    async ({ page }) => {
      test.setTimeout(240_000);
      const letters = new LettersPage(page);
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);

      // The archive is the before-picture: a letter rendered BEFORE the fix shipped still carries the
      // marker, which is what makes the assertion above a real before/after rather than a template
      // that never printed the marker at all. It also pins the deploy consequence the PR calls out —
      // stored PDFs are not corrected retroactively, only newly rendered ones are.
      //
      // Selection is by creation date, not by "the newest archived ones": every run of the test above
      // archives its predecessor, so the recent end of the archive is full of post-fix letters.
      const archived = (await letters.notices(REPRO.id)).filter(
        (n) => n.status === 'archived' && n.createdAt < FIX_DEPLOYED,
      );
      test.skip(
        archived.length === 0,
        `Patient ${REPRO.patientNumber} has no Vorabinformation stored from before ${FIX_DEPLOYED}, ` +
          `so there is no pre-fix rendering left to compare against.`,
      );

      const texts: { id: number; createdAt: string; block: string[]; marked: string[] }[] = [];
      const gone: number[] = [];
      for (const notice of archived.slice(0, 6)) {
        const text = await letters.tryLetterText(notice.signedFileUrl);
        if (text === null) {
          gone.push(notice.id);
          continue;
        }
        const block = LettersPage.recipientBlock(text);
        texts.push({ id: notice.id, createdAt: notice.createdAt, block, marked: markerLines(block) });
      }
      console.log('pre-fix archived letters: ' + JSON.stringify(texts, null, 1));
      if (gone.length) console.log(`archived letters whose stored file is gone: ${JSON.stringify(gone)}`);
      test.skip(
        texts.length === 0,
        `Every pre-${FIX_DEPLOYED} Vorabinformation on this patient has lost its stored file ` +
          `(${JSON.stringify(gone)}), so there is no pre-fix rendering left to read.`,
      );

      expect(
        texts.some((t) => t.marked.length > 0),
        `at least one letter rendered before ${FIX_DEPLOYED} must still show the marker — otherwise ` +
          `the "after" assertion proves nothing. Got ${JSON.stringify(texts)}`,
      ).toBe(true);
    },
  );

  test(
    'AC1 — a house number ending in a letter survives the clean-up',
    { tag: ['@Admin', '@LetterAddress', '@CountryMarker'] },
    async ({ page }) => {
      test.setTimeout(300_000);
      const letters = new LettersPage(page);
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);

      // AC1 row 3: the normalizer must strip a standalone marker without touching a house number
      // that legitimately ends in "D". Staging happens to hold the ticket's own example verbatim —
      // patient 8837, "Albert-Wiebach-Str. 1D, D 14513 Teltow" — so that is the fixture, with a
      // lookup fallback in case the record is edited later.
      let fixture = (await letters.addresses(HOUSE_NUMBER.id))
        .filter((a: any) => LettersPage.MARKER_BEFORE_PLZ.test(a.address || ''))
        .map((a: any) => ({ id: HOUSE_NUMBER.id, patientId: HOUSE_NUMBER.patientNumber, address: a.address as string }))[0];

      if (!fixture) {
        const found = await letters.findMarkedAddresses(12, 100);
        console.log(
          `scanned ${found.scanned} patients — ${found.beforePlz.length} marker-before-postal-code, ` +
            `${found.trailing.length} trailing-marker`,
        );
        // an attached suffix ("1D") only — a space-separated one ("13 D") is genuinely ambiguous, see below
        fixture = found.beforePlz.filter((h) => /\d[A-Za-z]\b/.test((h.address || '').split(',')[0] || ''))[0];
      }
      test.skip(
        !fixture,
        `No patient has a house number ending in a letter alongside a country marker, so AC1's ` +
          `house-number row has no fixture on this environment.`,
      );

      console.log(`house-number fixture: patient ${fixture.patientId} — "${fixture.address}"`);
      const houseNumber = (fixture.address.split(',')[0] || '').trim();

      const created = await letters.generateNotice(fixture.id, 'physiotherapy', 'regular');
      expect(created.status, 'generating the Vorabinformation for the house-number fixture').toBe(200);
      const url = created.notice.signedFileUrl ?? (await letters.notices(fixture.id))[0]?.signedFileUrl;
      const block = LettersPage.recipientBlock(await letters.letterText(url));
      console.log(`recipient block: ${JSON.stringify(block)}`);

      expect(
        markerLines(block),
        `patient ${fixture.patientId}: the country marker must be gone from the recipient block`,
      ).toEqual([]);
      expect(
        block,
        `patient ${fixture.patientId}: the street line must keep its house number exactly as stored ` +
          `("${houseNumber}") — the clean-up must never eat a house-number letter`,
      ).toContain(houseNumber);
    },
  );

  test(
    'AC1 — a SPACE-separated house-number letter survives the clean-up',
    { tag: ['@Admin', '@LetterAddress', '@CountryMarker'] },
    async ({ page }) => {
      test.fixme(
        true,
        'Real defect, verified live on staging 2026-08-17. The normalizer anchors on the marker being ' +
          'its own token, so a house-number letter written with a space is eaten along with the ' +
          'marker:\n' +
          '  patient 8839 "Essener Straße 13 D, D 22419 Hamburg" → prints "Essener Straße 13"\n' +
          '  patient 4023 "Hauptstr. 57 D, 10317 Berlin, D"      → prints "Hauptstr. 57"\n' +
          'The attached form is handled correctly (patient 8837 "Albert-Wiebach-Str. 1D, D 14513 ' +
          'Teltow" keeps its "1D" — asserted in the test above), and the ticket\'s AC1 table only ' +
          'shows attached examples ("1D", "12D"), so this is outside the letter of the AC. It is the ' +
          'same harm the edge case guards against though: the letter goes out with an incomplete ' +
          'house number. 15 staging addresses match (12 distinct), all Care Home; the production ' +
          'share of the 472 affected addresses is unmeasured. Re-enable if the ticket is extended to ' +
          'space-separated suffixes.',
      );
      const letters = new LettersPage(page);
      await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);

      const fixture = { id: 7605, patientNumber: 8839, street: 'Essener Straße 13 D' };
      const created = await letters.generateNotice(fixture.id, 'physiotherapy', 'regular');
      expect(created.status, 'generating the Vorabinformation').toBe(200);
      const url = created.notice.signedFileUrl ?? (await letters.notices(fixture.id))[0]?.signedFileUrl;
      const block = LettersPage.recipientBlock(await letters.letterText(url));

      expect(markerLines(block), 'the country marker must be gone').toEqual([]);
      expect(block, 'the street line must keep its full house number').toContain(fixture.street);
    },
  );

  test(
    'AC3 — the Optica GKV export carries no country marker',
    { tag: ['@Admin', '@LetterAddress', '@CountryMarker'] },
    async ({ page }) => {
      test.setTimeout(400_000);
      await page.setViewportSize({ width: 1920, height: 1200 });
      await page.goto('/billing', { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('GKV-Abrechnung', { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(8000);

      // Optica stripped nothing at all before this ticket, in any position — so the export is the one
      // surface where the marker is plain readable text rather than a PDF.
      const batches = await page.evaluate(async () => {
        let token: string | null = null;
        try {
          const j = JSON.parse(localStorage.getItem('auth-state') || '');
          token = j.token || j.accessToken || j.access_token || null;
        } catch {
          /* reported below as an empty list */
        }
        const r = await fetch(
          'https://api.staging.therapios.de/billing_batches?page=1&itemsPerPage=10&order%5BcreatedAt%5D=desc',
          { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/ld+json' } },
        );
        if (!r.ok) return [];
        const j = await r.json();
        return (j.member ?? j['hydra:member'] ?? []).map((b: any) => ({ id: b.id, batchId: b.batchId, status: b.status }));
      });

      const attempts: string[] = [];
      let body: string | null = null;
      // a `pending` batch answers 422 "not ready for export", so anything else is tried first
      for (const b of [...batches.filter((x: any) => x.status !== 'pending'), ...batches.filter((x: any) => x.status === 'pending')].slice(0, 3)) {
        const res = await page.evaluate(
          async ([url, cap]: [string, number]) => {
            let token: string | null = null;
            try {
              const j = JSON.parse(localStorage.getItem('auth-state') || '');
              token = j.token || j.accessToken || j.access_token || null;
            } catch {
              /* the status below carries the failure */
            }
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), cap);
            try {
              const r = await fetch(url, {
                headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: '*/*' },
                signal: ctrl.signal,
              });
              return { status: r.status, body: await r.text() };
            } catch (e: any) {
              return { status: -1, body: String(e?.name || e) };
            } finally {
              clearTimeout(timer);
            }
          },
          [`https://api.staging.therapios.de/billing_batches/${b.id}/optica-export`, 60_000] as [string, number],
        );
        attempts.push(`${b.batchId}(${b.status}) → ${res.status}`);
        if (res.status === 200 && res.body) {
          body = res.body;
          break;
        }
      }
      console.log('export attempts: ' + attempts.join('; '));
      test.skip(
        !body,
        `No billing batch produced an Optica export (${attempts.join('; ') || 'no batch listed'}). A ` +
          `pending batch is rejected with 422 "not ready for export", and on an eligible batch the ` +
          `endpoint has been observed not to answer inside 60 s. Move a batch to a ready state to ` +
          `exercise this assertion.`,
      );

      const offenders = body!
        .split(/\r?\n/)
        .filter((line) => LettersPage.MARKER_BEFORE_PLZ.test(line) || LettersPage.MARKER_TRAILING.test(line));
      expect(
        offenders.slice(0, 10),
        'the §302 claim file must not carry a standalone country marker in any address field',
      ).toEqual([]);
    },
  );

  test('AC3 — ETI insurance submissions use the corrected address', { tag: ['@Admin', '@LetterAddress', '@CountryMarker'] }, async () => {
    test.fixme(
      true,
      'ETI submissions have no readable output surface. The only ETI endpoints the app exposes are ' +
        'the submission action and a per-invoice status column — neither returns the address block ' +
        'that was submitted, and the ETI stage is empty on staging anyway (0 Inkasso / 0 ' +
        'Sent-to-DC invoices, same data gate as #2949/#2950 in admin_pkv_billing_eti.spec.ts). The ' +
        'shared normalizer is covered by EtiAddressParserTest on the API side.',
    );
  });

  test('AC4 — DATEV billing submissions use the corrected address', { tag: ['@Admin', '@LetterAddress', '@CountryMarker'] }, async () => {
    test.fixme(
      true,
      'DATEV sync is disabled on staging ("DATEV sync is disabled in this environment"), and DATEV ' +
        'debtor records are not exposed as a readable export anywhere in the app or API — the same ' +
        'limitation already recorded for #3191 in admin_guardian_gkv_export.spec.ts. AC4 is covered ' +
        'by DebtorAddressParserTest on the API side.',
    );
  });

  test('AC2 — the other four letter types', { tag: ['@Admin', '@LetterAddress', '@CountryMarker'] }, async () => {
    test.fixme(
      true,
      'The GKV copayment invoice, PKV invoice, Storno and Hono are all invoice-driven: each needs an ' +
        'invoice in a particular state for the patient whose address carries the marker, and the ' +
        'repro patient (9020) has none ("Keine Rechnungen vorhanden"). Generating one would mean ' +
        'creating billing records rather than a letter. They share the single `din5008_address` Twig ' +
        'filter with the Vorabinformation asserted above, which is the one fix point for all six ' +
        'types — the therapy report was the only surface with a second address path, and it was ' +
        'patched separately in the same commit.',
    );
  });
});
