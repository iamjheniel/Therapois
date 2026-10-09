import { test, expect } from '../../fixtures/session';
import { ReminderBrandingPage, BANNER, type DocumentRead } from '../../../Pages/superadmin/sa.reminder-branding.page';

/**
 * RC 3.14 — a Zahlungserinnerung prints TODAY's branding, not the invoice's (#3714, commit
 * `a371c19f2`, PR #3726).
 *
 * Reminder letters used to take the Curano-or-Therapios choice and the rebrand banner from the
 * invoice's frozen snapshot, so the letter always matched the invoice it chased. This reverses that
 * for reminders only: a reminder is by definition sent well after the invoice, so it should show
 * the entity as it is today. The invoice PDF keeps its snapshot.
 *
 * **Deployed; AC1, AC2 and AC4 verified live. 6 passed, 1 `fixme`.**
 *
 * ## The whole ticket is one comparison, and it needs no mutation
 *
 * The same invoice has two documents: the stored PDF (frozen branding) and the reminder (live).
 * On staging every entity is already `isRebranded: true` while the older invoices froze Therapios —
 * so the two documents must now DISAGREE, and that disagreement is AC1, AC2 and AC4 in one
 * measurement. Nothing is written: downloading a reminder renders and returns with no persist
 * (#3559), and downloading an invoice serves the stored file (#3495).
 *
 * Measured on four overdue PKV invoices, every one of them the same way:
 *
 * | | reminder (live) | invoice (frozen) |
 * |---|---|---|
 * | email | `info@curano.de` | `info@therapios.de` |
 * | website | `www.curano.de` | `www.therapios.de` |
 * | banner | shown | absent |
 * | date line | `Hamburg, 20.09.2026` | `16.06.2026` |
 *
 * ## FOUR markers, because one template variable could go wrong alone
 *
 * `DocumentBrandingResolver::resolve()` sets `brand_email`, `brand_website`, `show_rebrand_banner`
 * and `letter_date` independently, so a build that fixed the email but not the date line would pass
 * a single-marker check. The date line is the one worth naming: Curano renders **"City,
 * DD.MM.YYYY"** and Therapios a bare **"DD.MM.YYYY"** — pure formatting, and the easiest to miss.
 *
 * ## FINDING: a correct letter is headed "Therapios …" and announces "Therapios heißt jetzt Curano!"
 *
 * Only BRANDING went live. `entity_name`, address, IBAN and BIC still come from
 * `getIssuerNameSnapshot()`, deliberately, so the letter's banking details match the invoice it
 * chases. The visible result is a reminder whose issuer block reads **"Therapios Hamburg 1 GmbH"**
 * while the body carries the Curano banner and `info@curano.de`. That is in scope-compliance with
 * the ticket ("only the branding source"), but AC1 says the letter "shows Curano branding, not the
 * Therapios branding the invoice was created with", and a QA reading that literally will see the
 * old company name at the top and file it. Reported as a green test, not a failure.
 *
 * ## AC3 is an ops change, not a test step
 *
 * `rebrand_banner_enabled` resolves through `FeatureFlagService`; **Unleash is not provisioned in
 * any deployed environment**, so the value comes from the ECS env var `REBRAND_BANNER_ENABLED` —
 * **staging ON, production OFF** by design. There is no `/feature_flags` endpoint (404, along with
 * `/settings`, `/system_settings`, `/configurations`, `/app_settings`), so the banner cannot be
 * switched off from a client. What IS verified is the rendering half: the invoice documents carry
 * `show_rebrand_banner: false` from their snapshots and print no banner, so the false branch works.
 *
 * **Read-only** — every request is a GET; both downloads are non-writing.
 */

test.describe('#3714 the Zahlungserinnerung prints current branding', () => {
  test.describe.configure({ mode: 'serial' });

  /** Read once and shared: each pair is two PDF downloads. */
  let pairs: { invoiceNumber: string; reminder: DocumentRead; invoice: DocumentRead }[] = [];

  test(
    'deployment: the reminder and the invoice disagree about branding for the same invoice',
    { tag: ['@SuperAdmin', '@ReminderBranding', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(900_000);
      const api = new ReminderBrandingPage(request);

      const entities = await api.entities();
      console.log(`#3714 entities: ${JSON.stringify(entities)}`);
      // The precondition that makes the comparison meaningful — the live value the reminder now
      // reads. With every entity still on Therapios there would be nothing to disagree about.
      //
      // Scoped to the entities that actually ISSUE invoices. This read used to assert the property
      // over every row, which broke on 2026-09-25 when #3775's load-test fixtures added two
      // synthetic `ZZPerf Entity …` Gesellschaften carrying `isRebranded: false`. They issue
      // nothing, so they cannot weaken the comparison — but a global assertion cannot say that, and
      // failed on a build where the ticket was still correct. Same class as #3775's own trap, where
      // the ZZPerf therapists make two tile totals look like a rule mismatch.
      const issuing = entities.filter((e) => !/^ZZPerf\b/i.test(e.name));
      console.log(`#3714 invoice-issuing entities: ${issuing.length} of ${entities.length} (synthetic ZZPerf rows excluded)`);
      expect(issuing.length, 'staging has invoice-issuing entities').toBeGreaterThan(0);
      expect(
        issuing.every((e) => e.isRebranded),
        'every invoice-issuing entity is live-Curano today',
      ).toBe(true);

      const eligible = await api.eligibleOverdue(4);
      console.log(`#3714 eligible overdue PKV invoices: ${JSON.stringify(eligible)}`);
      expect(eligible.length, 'there are reminders to generate').toBeGreaterThan(0);

      for (const inv of eligible) {
        const reminder = await api.reminder(inv.id);
        const invoice = await api.invoicePdf(inv.id);
        pairs.push({ invoiceNumber: inv.invoiceNumber, reminder, invoice });
        console.log(
          `#3714 ${inv.invoiceNumber}: reminder ${reminder.status} ${JSON.stringify(reminder.markers)} | ` +
            `invoice ${invoice.status} ${JSON.stringify(invoice.markers)}`,
        );
      }

      const readable = pairs.filter((p) => p.reminder.status === 200 && p.invoice.status === 200);
      expect(readable.length, 'both documents came back for at least one invoice').toBeGreaterThan(0);

      // The headline: for the same invoice the two documents resolve branding differently, which
      // is only possible once the reminder stopped reading the snapshot.
      const disagreeing = readable.filter(
        (p) =>
          ReminderBrandingPage.brandOf(p.reminder.markers) !== ReminderBrandingPage.brandOf(p.invoice.markers),
      );
      console.log(
        `#3714 ${disagreeing.length} of ${readable.length} invoices have a reminder branded differently from the invoice`,
      );
      expect(disagreeing.length, 'DEPLOYED: the reminder no longer inherits the invoice branding').toBeGreaterThan(0);
    },
  );

  test(
    'AC1 the reminder prints Curano on every one of four independent markers',
    { tag: ['@SuperAdmin', '@ReminderBranding', '@ReadOnly'] },
    async () => {
      const readable = pairs.filter((p) => p.reminder.status === 200);
      expect(readable.length, 'reminders were read by the first test').toBeGreaterThan(0);

      for (const p of readable) {
        const m = p.reminder.markers;
        expect(m.email, `${p.invoiceNumber}: brand_email`).toBe('curano');
        expect(m.website, `${p.invoiceNumber}: brand_website`).toBe('curano');
        // `letter_date` is the pure-formatting marker: Curano prefixes the entity's city.
        expect(m.cityDateLine, `${p.invoiceNumber}: letter_date is the "City, DD.MM.YYYY" form`).toBeTruthy();
        expect(ReminderBrandingPage.brandOf(m), `${p.invoiceNumber}: every marker agrees`).toBe('curano');
      }
      console.log(
        `#3714 AC1: ${readable.length} reminders, all Curano — date lines ${JSON.stringify(readable.map((p) => p.reminder.markers.cityDateLine))}`,
      );
    },
  );

  test(
    'AC4 the invoice PDF is untouched and still prints the branding it was created with',
    { tag: ['@SuperAdmin', '@ReminderBranding', '@ReadOnly'] },
    async () => {
      const readable = pairs.filter((p) => p.invoice.status === 200);
      expect(readable.length, 'invoice PDFs were read by the first test').toBeGreaterThan(0);

      // AC4 is the control that stops AC1 from being satisfied by "everything is Curano now".
      const frozen = readable.filter((p) => ReminderBrandingPage.brandOf(p.invoice.markers) === 'therapios');
      console.log(
        `#3714 AC4: ${frozen.length} of ${readable.length} invoice PDFs still print Therapios — ` +
          JSON.stringify(readable.map((p) => `${p.invoiceNumber}:${ReminderBrandingPage.brandOf(p.invoice.markers)}`)),
      );
      expect(frozen.length, 'AC4: the invoice keeps its frozen branding').toBeGreaterThan(0);

      for (const p of frozen) {
        const m = p.invoice.markers;
        expect(m.email, `${p.invoiceNumber} invoice: brand_email`).toBe('therapios');
        expect(m.website, `${p.invoiceNumber} invoice: brand_website`).toBe('therapios');
        expect(m.cityDateLine, `${p.invoiceNumber} invoice: the bare date form, no city prefix`).toBeNull();
        expect(m.banner, `${p.invoiceNumber} invoice: no banner on a Therapios document`).toBe(false);
      }
    },
  );

  test(
    'AC2 the banner is on the reminder and not on the invoice it chases',
    { tag: ['@SuperAdmin', '@ReminderBranding', '@ReadOnly'] },
    async () => {
      const readable = pairs.filter((p) => p.reminder.status === 200 && p.invoice.status === 200);
      expect(readable.length).toBeGreaterThan(0);

      for (const p of readable) {
        // AC2's exact case: the invoice was created before the banner applied to it, the reminder
        // is generated now, and only the reminder shows it.
        expect(p.reminder.markers.banner, `${p.invoiceNumber}: AC2 the reminder shows the banner`).toBe(true);
        expect(p.invoice.markers.banner, `${p.invoiceNumber}: and the invoice does not`).toBe(false);
        expect(p.reminder.text, `${p.invoiceNumber}: the banner headline itself`).toMatch(BANNER);
      }
      console.log(`#3714 AC2: ${readable.length} reminders carry the banner, 0 of their invoices do`);
    },
  );

  test(
    'AC3 the false branch renders nothing — verified on the documents that carry a false snapshot',
    { tag: ['@SuperAdmin', '@ReminderBranding', '@ReadOnly'] },
    async ({ request }) => {
      test.setTimeout(300_000);
      const api = new ReminderBrandingPage(request);

      // AC3's live-flag-off state is unreachable (see below), but its RENDERING half is not: the
      // invoice documents pass `show_rebrand_banner: false` from their snapshots through the very
      // same resolver and template, and print no banner. So the false branch is exercised — what
      // cannot be exercised is reaching it via the live flag.
      const withoutBanner = pairs.filter((p) => p.invoice.status === 200 && !p.invoice.markers.banner);
      console.log(`#3714 AC3: ${withoutBanner.length} documents render the show_rebrand_banner=false branch`);
      expect(withoutBanner.length, 'the false branch renders no banner').toBeGreaterThan(0);

      const probes = await api.bannerSwitchProbes();
      console.log(`#3714 AC3 banner-switch surfaces: ${JSON.stringify(probes)}`);
      // Re-measured every run so the `fixme` below cannot silently go stale: if one of these ever
      // answers 200, AC3 becomes testable.
      expect(
        Object.values(probes).every((s) => s === 404),
        'no client-reachable banner switch exists — AC3 off-state is an ops change',
      ).toBe(true);
    },
  );

  test(
    'FINDING: the reminder keeps the invoice\'s issuer NAME while printing the new brand',
    { tag: ['@SuperAdmin', '@ReminderBranding', '@ReadOnly'] },
    async () => {
      const readable = pairs.filter((p) => p.reminder.status === 200 && p.invoice.status === 200);
      expect(readable.length).toBeGreaterThan(0);

      for (const p of readable) {
        console.log(
          `#3714 issuer — reminder: "${p.reminder.issuerLine}" | invoice: "${p.invoice.issuerLine}"`,
        );
        // Deliberate: only branding went live, so the banking block still matches the invoice.
        expect(p.reminder.issuerLine, `${p.invoiceNumber}: the issuer line is the frozen snapshot`).toBe(
          p.invoice.issuerLine,
        );
      }

      const oddPair = readable.find(
        (p) => /Therapios/.test(p.reminder.issuerLine ?? '') && p.reminder.markers.banner,
      );
      if (oddPair) {
        console.log(
          '#3714 FINDING (for the PM): only BRANDING went live — entity_name, address, IBAN and BIC still come ' +
            `from getIssuerNameSnapshot(), so a correct reminder is headed "${oddPair.reminder.issuerLine}" while ` +
            'its body carries the Curano banner and info@curano.de. That is scope-compliant ("only the branding ' +
            'source"), and it keeps the banking details matching the invoice being chased — but AC1 reads "the ' +
            'letter shows Curano branding, not the Therapios branding the invoice was created with", and a QA ' +
            'applying that literally will see the old company name at the top of the letter and file it.',
        );
        expect(oddPair.reminder.markers.email, 'the brand is Curano while the name is not').toBe('curano');
      }
    },
  );
});
