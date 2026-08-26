import { Page } from '@playwright/test';
import { AppPage } from '../base/app.page';
import { pdfText } from '../util/pdf-text';

export type Entity = {
  id: number;
  name: string;
  isRebranded: boolean;
};

export type DocumentRead = {
  /** Where the document came from, for failure messages. */
  label: string;
  /** Extracted text, or null when the file could not be downloaded. */
  text: string | null;
};

/**
 * The Curano rebranding banner on outgoing documents (RC 3.11.2 hotfix, #3481).
 *
 * The ticket asks for a banner — old Therapios logo plus a fixed German sentence — on all seven
 * outgoing document types once an entity's branding has switched to Curano, positioned **below the
 * recipient's address and above the date line**.
 *
 * Surface notes, all verified live on staging:
 *  - **Branding is an entity flag, `isRebranded`, on `GET /entities`.** All 7 staging entities read
 *    `true`, so there is no live fixture for AC2 (a document from a not-yet-rebranded entity).
 *  - **There is no banner field and no settings resource.** `/entities/{id}` exposes only
 *    `isRebranded`; `/settings`, `/system_settings`, `/app_settings`, `/configurations`,
 *    `/feature_flags` and `/branding_settings` all 404. AC4's "setting Curano's team controls" does
 *    not exist yet, so its off-state cannot be the reason a banner is missing.
 *  - **Invoices freeze their branding at issue time** (the `isCuranoBrandingSnapshot()` the ticket
 *    describes) and this is directly observable: a PKV invoice issued 20.07.2026 still prints
 *    "Therapios Hamburg 1 GmbH" while a copayment invoice issued today prints "Curano Hamburg
 *    GmbH" — the same legal entity, two frozen names. That is the split AC5 is about.
 *  - **Reading a document means reading its PDF.** `Pages/util/pdf-text.ts` handles the subset
 *    fonts; see `letter-pdf-text-extraction` for why the text IS extractable.
 *  - **A stored PDF keeps whatever it was rendered with**, so the banner can only be observed on a
 *    document generated AFTER the hotfix deploys. Re-reading an archived file proves nothing.
 */
export class RebrandingBannerPage extends AppPage {
  static readonly API = 'https://api.staging.therapios.de';

  /**
   * The banner sentence, verbatim from the ticket's Localization Reference (Dennis Drechsler,
   * 24 Aug 2026). This copy is FINAL — do not paraphrase it or relax the match.
   */
  static readonly BANNER_DE =
    'Therapios heißt jetzt Curano! Ab sofort sind wir unter neuem Namen für Sie da – ' +
    'gewohnt herzlich, kompetent und professionell. Außer dem neuen Namen ändert sich ' +
    'dabei für Sie nichts.';

  /**
   * A tolerant probe for "is the banner there at all".
   *
   * Deliberately looser than {@link BANNER_DE}: PDF text extraction can break a paragraph across
   * lines, so a whole-sentence match would report "no banner" for a banner that IS present but
   * wrapped. The headline is the part that cannot wrap.
   */
  static readonly BANNER_HEADLINE = /Therapios\s+heißt\s+jetzt\s+Curano/;

  /** The seven document types the ticket puts in scope. */
  static readonly DOCUMENTS = [
    'Vorabinformation',
    'PKV billing invoice',
    'Hono document',
    'GKV co-payment invoice',
    'Storno invoice',
    'Infoblatt (IB)',
    'Therapy report (TB)',
  ] as const;

  /** The three that freeze their branding at issue time — AC5's population. */
  static readonly FROZEN_BRANDING_DOCUMENTS = [
    'PKV billing invoice',
    'GKV co-payment invoice',
    'Storno invoice',
  ] as const;

  constructor(page: Page) {
    super(page);
  }

  async open(): Promise<void> {
    await this.page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await this.page
      .getByText('VO #', { exact: true })
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => {});
  }

  /** Signs an API read with the bearer token the app keeps in `auth-state`. */
  private async json(path: string): Promise<{ status: number; json: any }> {
    return await this.page.evaluate(
      async ([base, p]: [string, string]) => {
        let token: string | null = null;
        try {
          token = JSON.parse(localStorage.getItem('auth-state') || '').token;
        } catch {
          /* the caller asserts on the status */
        }
        const r = await fetch(`${base}${p}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/ld+json' },
        });
        const t = await r.text();
        try {
          return { status: r.status, json: JSON.parse(t) };
        } catch {
          return { status: r.status, json: t.slice(0, 300) };
        }
      },
      [RebrandingBannerPage.API, path],
    );
  }

  /** Downloads an API-served PDF and returns its text; null when it is not downloadable. */
  private async pdfAt(path: string): Promise<string | null> {
    const res = await this.page.evaluate(
      async ([base, p]: [string, string]) => {
        let token: string | null = null;
        try {
          token = JSON.parse(localStorage.getItem('auth-state') || '').token;
        } catch {
          /* handled by the status check */
        }
        const r = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${token}` } });
        return { status: r.status, bytes: r.ok ? Array.from(new Uint8Array(await r.arrayBuffer())) : [] };
      },
      [RebrandingBannerPage.API, path],
    );
    return res.status === 200 ? pdfText(Buffer.from(res.bytes)) : null;
  }

  /** Downloads a pre-signed S3 URL (letters) and returns its text. */
  private async pdfAtUrl(url: string): Promise<string | null> {
    const res = await this.page.evaluate(async (u: string) => {
      const r = await fetch(u);
      return { status: r.status, bytes: r.ok ? Array.from(new Uint8Array(await r.arrayBuffer())) : [] };
    }, url);
    return res.status === 200 ? pdfText(Buffer.from(res.bytes)) : null;
  }

  // ─────────────────────────────── branding state ────────────────────────────

  async entities(): Promise<Entity[]> {
    const res = await this.json('/entities?itemsPerPage=50');
    const members = res.json?.member ?? res.json?.['hydra:member'] ?? [];
    return members.map((m: any) => ({ id: m.id, name: m.name, isRebranded: !!m.isRebranded }));
  }

  /**
   * Whether ANY control for the banner is exposed by the API.
   *
   * AC4 requires a switch Curano's team can flip. Until one exists, "no banner" cannot be blamed on
   * the switch being off — which is what makes the deployment verdict below unambiguous.
   */
  async bannerControlSurface(): Promise<{ entityFields: string[]; settingsEndpoints: Record<string, number> }> {
    const ent = await this.json('/entities/1');
    const entityFields = Object.keys(ent.json ?? {}).filter((k) => /brand|banner|rebrand|curano/i.test(k));
    const settingsEndpoints: Record<string, number> = {};
    for (const p of [
      '/settings',
      '/system_settings',
      '/app_settings',
      '/configurations',
      '/feature_flags',
      '/branding_settings',
    ]) {
      settingsEndpoints[p] = (await this.json(p)).status;
    }
    return { entityFields, settingsEndpoints };
  }

  // ────────────────────────────────── documents ──────────────────────────────

  /** The most recent Vorabinformation on file for a patient, read without generating a new one. */
  async latestNoticeText(patientId: number): Promise<DocumentRead> {
    const res = await this.json(
      `/pre_treatment_notices?page=1&itemsPerPage=5&order%5BcreatedAt%5D=desc&patient=%2Fpatients%2F${patientId}`,
    );
    const rows = res.json?.member ?? res.json?.['hydra:member'] ?? [];
    if (!rows.length) return { label: `Vorabinformation (patient ${patientId})`, text: null };
    return {
      label: `Vorabinformation (patient ${patientId}, notice ${rows[0].id}, ${rows[0].createdAt})`,
      text: await this.pdfAtUrl(rows[0].signedFileUrl),
    };
  }

  /**
   * Generates a FRESH Vorabinformation and returns its text.
   *
   * This is the only way to observe a rendering change: a stored PDF keeps whatever it was rendered
   * with. It archives the patient's current notice and creates a new one — the same write
   * `admin_letter_country_marker.spec.ts` already makes for the same reason.
   */
  async generateNoticeText(
    patientId: number,
    discipline: 'physiotherapy' | 'ergotherapy' | 'speech_therapy' = 'physiotherapy',
    variant: 'regular' | 'blanko' = 'regular',
  ): Promise<DocumentRead> {
    const res = await this.page.evaluate(
      async ([base, pid, disc, v]: [string, number, string, string]) => {
        let token: string | null = null;
        try {
          token = JSON.parse(localStorage.getItem('auth-state') || '').token;
        } catch {
          /* handled by the status check */
        }
        const r = await fetch(`${base}/patients/${pid}/generate-pre-treatment-notice/${disc}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/ld+json',
          },
          body: JSON.stringify({ variant: v }),
        });
        const t = await r.text();
        try {
          return { status: r.status, json: JSON.parse(t) };
        } catch {
          return { status: r.status, json: t.slice(0, 300) };
        }
      },
      [RebrandingBannerPage.API, patientId, discipline, variant],
    );
    if (res.status >= 300) {
      return { label: `Vorabinformation (patient ${patientId}) — generate ${res.status}`, text: null };
    }
    // Re-read the list: the POST response does not always carry a usable signed URL.
    return await this.latestNoticeText(patientId);
  }

  /** A PKV or GKV-copayment invoice PDF, by invoice id. */
  async invoiceText(id: number, label: string): Promise<DocumentRead> {
    return { label: `${label} (invoice ${id})`, text: await this.pdfAt(`/invoices/${id}/download`) };
  }

  /** A Storno (credit note) PDF, by the cancelled invoice's id. */
  async stornoText(id: number): Promise<DocumentRead> {
    return { label: `Storno (invoice ${id})`, text: await this.pdfAt(`/invoices/${id}/storno/download`) };
  }

  // ─────────────────────────────── banner assertions ─────────────────────────

  /** Whether a document's text carries the banner. */
  static hasBanner(text: string): boolean {
    return RebrandingBannerPage.BANNER_HEADLINE.test(text);
  }

  /** Whether a document was rendered with Curano branding (the trigger AC1/AC2 hinge on). */
  static isCuranoBranded(text: string): boolean {
    return /Curano/i.test(text);
  }

  /**
   * Where the banner sits relative to the recipient block and the date line (AC1's placement).
   *
   * Returns the 0-based line indexes so a caller can assert ordering rather than mere presence.
   * The dateline is "<Ort>, DD.MM.YYYY"; the banner headline is its own block.
   */
  static placement(text: string): { banner: number; dateLine: number } {
    const lines = text.split('\n');
    return {
      banner: lines.findIndex((l) => RebrandingBannerPage.BANNER_HEADLINE.test(l)),
      dateLine: lines.findIndex((l) => /^[A-ZÄÖÜ][\wäöüß .-]*,\s*\d{2}\.\d{2}\.\d{4}\s*$/.test(l.trim())),
    };
  }
}
