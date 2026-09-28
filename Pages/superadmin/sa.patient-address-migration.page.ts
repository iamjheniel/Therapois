import { APIRequestContext, expect } from '@playwright/test';

/**
 * The one-time patient-address split into structured fields (RC 3.12 #3373).
 *
 * A free-text `address` is split into `street` / `postalCode` / `city`, the #3370 country marker is
 * stripped on the way, the original text is kept as the fallback, and a new billing validation
 * (`billing_address_complete`, id 53) blocks a billing document when the resulting postal code and
 * city are empty.
 *
 * **A migration is verified by re-deriving it, not by sampling it.** The split rule is deterministic
 * and lives in `App\Util\PatientAddressSplitter`, so this page object carries a faithful port of it
 * (plus `AddressNormalizer::stripCountryMarker`) and `split()` below is used as an INDEPENDENT
 * ORACLE: for every stored row, compute what the fields should hold and compare. That turns AC2/AC3/
 * AC4/AC5 into one exhaustive check instead of eyeballing a handful of patients.
 *
 * Porting notes, because two of these are easy to get wrong:
 *  - PHP's `preg_replace` replaces EVERY occurrence; the JS equivalents need the `g` flag.
 *  - The marker lookbehinds are `^`, `,` and `,\s` — deliberately **not** a bare space. A loose
 *    `\bD\b` "leftover marker" check reports `Hönower Str. 53 d` (a house-number suffix) and
 *    `An de Geest 22` (a Low German street name) as defects; both are correctly preserved.
 *  - `mb_strlen` counts codepoints, so the 60-char cap uses `[...s].length`, not `.length`.
 *
 * **Fetching the data is the hard part.** There is no `/patient_addresses` collection (404), the
 * addresses ride inside `/patients`, and that payload is ~14 KB per patient — a straight walk 504s
 * around page 7. `groups[]` does not trim it (the address group drops `patientAddresses` entirely)
 * and no `properties[]` filter is registered. `sampleAddresses()` therefore takes pages spread
 * across the id space with retries, and callers assert on a measured sample size.
 */

export type StoredAddress = {
  id: number;
  patientNumber: number;
  patientId: number;
  label: string | null;
  /** The preserved free text — the migration reads it and never writes it. */
  raw: string;
  street: string;
  postalCode: string;
  city: string;
  type: string;
  isBilling: boolean;
  contactPerson: string;
};

export type SplitResult = {
  outcome: 'clean' | 'no_house_number' | 'unsplittable';
  street: string;
  postalCode: string;
  city: string;
};

const MARKER_BEFORE_PLZ = /(?:(?<=^)|(?<=,)|(?<=,\s))DE?(?=[,\s]+\d{5}(?!\d))/gi;
const MARKER_TRAILING = /(?:(?<=^)|(?<=,)|(?<=\s))DE?[\s,]*$/gi;
/** "<street><, or space><5-digit PLZ> <city>", the PLZ not part of a longer digit run. */
const SPLIT_PATTERN = /^(.*?)[,\s]+(\d{5})(?!\d)\s+(.+)$/u;
/** #3372 enforces Assert\Length(max: 60); an over-long part goes to review, never truncated. */
const MAX_PART_LENGTH = 60;

function trimChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start++;
  while (end > start && chars.includes(value[end - 1])) end--;
  return value.slice(start, end);
}

/** Port of `AddressNormalizer::stripCountryMarker()`. */
export function stripCountryMarker(address: string | null): string {
  if (address === null || address.trim() === '') return '';
  let result = address.replace(MARKER_BEFORE_PLZ, '').replace(MARKER_TRAILING, '');
  result = result.replace(/,[\s,]*,/g, ',').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ');
  return trimChars(result, ' \t\n\r\0\v,');
}

/** Port of `PatientAddressSplitter::split()`. */
export function split(address: string | null): SplitResult {
  const empty = { street: '', postalCode: '', city: '' };
  const cleaned = stripCountryMarker(address);
  if (cleaned === '') return { outcome: 'unsplittable', ...empty };

  const match = SPLIT_PATTERN.exec(cleaned);
  if (!match) return { outcome: 'unsplittable', ...empty };

  const street = trimChars(match[1], ' \t,');
  const city = trimChars(match[3], ' \t,');
  if (street === '' || city === '') return { outcome: 'unsplittable', ...empty };
  if ([...street].length > MAX_PART_LENGTH || [...city].length > MAX_PART_LENGTH) {
    return { outcome: 'unsplittable', ...empty };
  }

  // AC4: a street with no digit has no house number recorded — still written, flagged for review.
  return {
    outcome: /\d/.test(street) ? 'clean' : 'no_house_number',
    street,
    postalCode: match[2],
    city,
  };
}

/**
 * A marker that survived into a structured field, judged by the normalizer's OWN anchors so a
 * house-number suffix or a street name containing "de" is never reported.
 */
export function carriesCountryMarker(value: string): boolean {
  return /^DE?([\s,]|$)/i.test(value) || /(?<=,)\s*DE?[\s,]*$/i.test(value) || /(?<=,\s)DE?([\s,]|$)/i.test(value);
}

export class PatientAddressMigrationPage {
  static readonly API = 'https://api.staging.therapios.de';
  /** The billing validation this ticket adds. */
  static readonly CHECK = { id: 53, description: 'billing_address_complete', timing: 'billing' };

  constructor(
    private request: APIRequestContext,
    private token: string,
  ) {}

  private async json(path: string): Promise<any> {
    const response = await this.request.get(`${PatientAddressMigrationPage.API}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
      timeout: 180_000,
    });
    expect(response.status(), `GET ${path}`).toBe(200);
    return await response.json();
  }

  private static members(body: any): any[] {
    return body?.member ?? body?.['hydra:member'] ?? [];
  }

  private static shape(patient: any, address: any): StoredAddress {
    const text = (value: unknown) => (value === null || value === undefined ? '' : String(value).trim());
    return {
      id: address.id,
      patientNumber: patient.patientId,
      patientId: patient.id,
      label: address.label ?? null,
      raw: text(address.address),
      street: text(address.street),
      postalCode: text(address.postalCode),
      city: text(address.city),
      type: String(address.type ?? ''),
      isBilling: address.isBilling === true,
      contactPerson: text(address.contactPerson),
    };
  }

  /**
   * Addresses from pages spread across the patient collection. `every` controls the stride —
   * a contiguous walk is what times out, so the default takes every fifth page.
   */
  async sampleAddresses(opts: { perPage?: number; every?: number; maxPages?: number } = {}): Promise<StoredAddress[]> {
    const perPage = opts.perPage ?? 40;
    const every = opts.every ?? 5;
    const maxPages = opts.maxPages ?? 45;
    const rows: StoredAddress[] = [];
    const seen = new Set<number>();

    for (let page = 1, taken = 0; taken < maxPages; page += every, taken++) {
      let body: any = null;
      for (let attempt = 1; attempt <= 3 && body === null; attempt++) {
        try {
          body = await this.json(`/patients?page=${page}&itemsPerPage=${perPage}`);
        } catch {
          // Staging 504s this collection under load; a retry after a pause usually lands.
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      }
      if (body === null) continue;
      const patients = PatientAddressMigrationPage.members(body);
      if (patients.length === 0) break;
      for (const patient of patients) {
        for (const address of patient.patientAddresses ?? []) {
          if (address && typeof address === 'object' && address.id !== undefined && !seen.has(address.id)) {
            seen.add(address.id);
            rows.push(PatientAddressMigrationPage.shape(patient, address));
          }
        }
      }
    }
    return rows;
  }

  /** Every address of one patient, for resolving which row the billing check will read. */
  async addressesOfPatient(patientId: number): Promise<StoredAddress[]> {
    const patient = await this.json(`/patients/${patientId}`);
    return (patient.patientAddresses ?? [])
      .filter((address: any) => address && typeof address === 'object' && address.id !== undefined)
      .map((address: any) => PatientAddressMigrationPage.shape(patient, address));
  }

  /**
   * `Patient::getResidenceAddress()` — the row the billing check and the regulatory exports read:
   * the first Care Home address with no contact person, else any Care Home address, else the
   * billing row. The contact-person preference is what keeps a guardian row (#3187) from being
   * mistaken for the patient's residence.
   */
  static residenceAddress(addresses: StoredAddress[]): StoredAddress | null {
    const careHomes = addresses.filter((address) => address.type === 'care_home');
    return careHomes.find((address) => address.contactPerson === '') ?? careHomes[0] ?? addresses.find((a) => a.isBilling) ?? null;
  }

  /** What `checkBillingAddressComplete()` decides: postal code AND city non-empty on that row. */
  static billingAddressComplete(addresses: StoredAddress[]): boolean {
    const residence = PatientAddressMigrationPage.residenceAddress(addresses);
    return residence !== null && residence.postalCode !== '' && residence.city !== '';
  }

  /** The validation catalogue row this ticket adds. */
  async validationCatalogue(): Promise<{ id: number; description: string; timing: string; category: string }[]> {
    const body = await this.json('/validations?pagination=false&scope=vo');
    return PatientAddressMigrationPage.members(body).map((row: any) => ({
      id: row.id,
      description: row.description,
      timing: row.timing,
      category: row.category,
    }));
  }

  /** The stored verdicts of one check on one VO. */
  async verdicts(prescriptionId: number, validationId: number): Promise<boolean[]> {
    const body = await this.json(
      `/prescription_validations?pagination=false&prescription=%2Fprescriptions%2F${prescriptionId}&validation=${validationId}`,
    );
    return PatientAddressMigrationPage.members(body).map((row: any) => row.passed === true);
  }

  /** One VO by its number, with the patient id the address lookup needs. */
  async prescription(voNumber: string): Promise<{ id: number; patientId: number } | null> {
    const body = await this.json(
      `/prescriptions?page=1&itemsPerPage=5&exact%5BprescriptionId%5D=${encodeURIComponent(voNumber)}`,
    );
    const row = PatientAddressMigrationPage.members(body)[0];
    return row ? { id: row.id, patientId: row.patient?.id } : null;
  }
}
