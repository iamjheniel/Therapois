import { Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { API_BASE, Credentials, STAGING_CREDENTIALS, apiBearerToken } from '../util/api-token';

/**
 * The one-time bulk link of unlinked patients to their InsuranceProvider by IK — RC 3.13 #3560
 * (`app:link-patients-by-ik`, PR #3586).
 *
 * 8,315 patients had no insurance provider linked, which makes `OpticaExportValidator` block any GKV
 * billing batch containing one of their VOs (#2973's pre-export check). The command reads a
 * PM-verified `patient id → 9-digit IK` mapping file, looks each IK up in the #2969 provider
 * catalog, and fills ONLY patients that currently have no provider.
 *
 * **Already applied on staging: 2026-09-10 00:34 UTC**, so the outcome is readable and this file
 * verifies it rather than the console. Read-only — every request is a GET.
 *
 * ## The method: re-derive the command's decisions, don't sample them
 *
 * The command's rules are short enough to port exactly, and its decision ORDER matters:
 *
 * 1. patient id not in the database → unmatched, reason `patient id not found`
 * 2. else patient already has `insurance_provider_id` → skipped (AC6) — **checked BEFORE the IK
 *    lookup**, so an already-linked patient with an unknown IK is reported as already-linked, not
 *    as an IK mismatch
 * 3. else IK not in the catalog → unmatched, reason `IK not in the insurance provider catalog`
 * 4. else → link
 *
 * Re-running that over today's state plus the run's own log trail settles AC2 through AC6 on the
 * whole population instead of on a spot-check. The discriminator for "did the RUN change this
 * patient" is the `PatientLog`: the command writes one `field_change` entry per linked patient with
 * `meta.field = insuranceProvider`, `meta.type = automatic`, `oldValue "null"`, `newValue` = the
 * provider's name, and a single run-wide `batchId`.
 *
 * ## What was measured on staging (2026-09-10)
 *
 * | | |
 * |---|---|
 * | mapping rows | 6,295 — 6,295 distinct patients, 157 distinct IKs, all 9 digits, none blank |
 * | IKs found in Flow's 1,084-provider catalog | **157 of 157** — so the ticket's projected "7 unmatched IKs" is a production figure that does not occur here |
 * | linked by the run | 5,876, every one to exactly the provider its mapped IK names |
 * | patient id not found | 378 today (379 at run time — see the off-by-one below) |
 * | already linked, left alone | 41 today (40 at run time), **all 41 holding a provider that differs from the file's** |
 *
 * **The off-by-one against the PM's counts is explained, not waved away:** patient 8484 "Naim
 * PascualTest" was created at 2026-09-10 05:21:59, 4h47m AFTER the run. It is in the mapping file,
 * so the run correctly reported it "patient id not found" (379) and today it exists and is linked
 * (378 + 41). Every count assertion here is therefore written against the run's log trail plus
 * today's state, never against the PM's recorded numbers.
 *
 * ## Traps
 *
 * - **`exists[insuranceProvider]` is accepted and silently IGNORED** — no ExistsFilter is registered
 *   for it, so both `=true` and `=false` return the full 8,370 patients. Counting unlinked patients
 *   needs a walk of the collection (~170 pages at 50/page).
 * - **`?id[]=` DOES work** on `/patients` and is the cheap way in: batches of 50 are reliable and
 *   the payload is ~6.7 KB per patient (not the 14 KB #3373 records — that was with addresses).
 * - **`insuranceProvider` is serialized as `null`, not omitted**, unlike most nullable fields here.
 * - **The mapping file is a GitHub issue attachment and needs an authenticated fetch** — a plain
 *   `curl` gets 404. `mappingRows()` uses `GITHUB_TOKEN` or `gh auth token`, and pins the file's
 *   sha256 so a silently-replaced attachment is caught rather than quietly changing the expectations.
 * - `/patient_logs` filters only by `patient` and `type` (no `batchId`, no meta field), so the run's
 *   entries are found by pulling `type=field_change` and filtering on `meta.field` client-side —
 *   7,700 rows, ~4 MB, one request.
 */

/** The applied run, as its log trail records it. */
export const RUN = {
  batchId: '6f0dc5a0-e056-f439-5eb7-db039c7de71d',
  at: '2026-09-10T00:34',
} as const;

/** The ticket's attachment, pinned by content so a replacement is noticed. */
export const MAPPING_FILE = {
  url: 'https://github.com/user-attachments/files/31632797/patient-ik-mapping-2026-08-31.csv',
  sha256: '06fa0e164b19a7a32e777e8ef52148daece8a7911f50da68e3a72c635e6e9d9c',
  rows: 6295,
  distinctIks: 157,
  /** What the command reads; `insurer_name` and `source_file` are informational and ignored. */
  header: 'flow_patient_id,ik,insurer_name,source_file',
} as const;

/** The PM's fixtures, from the ticket's test notes. */
export const FIXTURES = {
  /** In the mapping file, linked by the run. */
  linked: { patientId: 8413, name: 'Gudrun Mersetzky', ik: '101377508', providerId: 637, providerName: 'Techniker Krankenkasse' },
  /** Not in the mapping file — must still be unlinked (AC4). */
  untouched: { patientId: 1, name: 'Heidemarie Aagaard-Konopatzki' },
  /** Created after the run; explains the 379-vs-378 difference. */
  createdAfterTheRun: { patientId: 8484, createdAt: '2026-09-10T05:21:59+00:00' },
} as const;

export type MappingRow = { patientId: number; ik: string; insurerName: string; source: string };
export type PatientState = { id: number; name: string; providerId: number | null; providerIk: string | null; providerName: string | null; insuranceCompany: string | null };
export type ProviderRow = { id: number; ik: string; name: string };
export type RunLog = { patientId: number; batchId: string | null; createdAt: string; oldValue: string | null; newValue: string | null; metaType: string | null; createdBy: string | null };

/** The command's own outcome buckets, in its decision order. */
export type Outcome = {
  toLink: Map<number, ProviderRow>;
  notFound: number[];
  alreadyLinked: number[];
  unmatchedIk: Array<{ patientId: number; ik: string }>;
};

export class PatientIkLinkPage {
  private token = '';

  constructor(private page: Page) {}

  async connect(credentials: Credentials = STAGING_CREDENTIALS.superadmin): Promise<void> {
    this.token = (await apiBearerToken(this.page, { credentials })) ?? '';
    if (!this.token) throw new Error('#3560: no bearer token');
  }

  private async get(path: string, timeout = 240_000): Promise<any> {
    let last = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.page.request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/ld+json' },
        timeout,
      });
      if (res.ok()) {
        const body = await res.text();
        if (body.startsWith('{') || body.startsWith('[')) return JSON.parse(body);
        last = `non-JSON (${body.slice(0, 60)})`;
      } else last = `HTTP ${res.status()}`;
      await this.page.waitForTimeout(3_000 * (attempt + 1));
    }
    throw new Error(`GET ${path} → ${last}`);
  }

  async status(path: string): Promise<number> {
    const res = await this.page.request.get(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      timeout: 120_000,
    });
    return res.status();
  }

  // ─────────────────────────────── the command's INPUT ───────────────────────────────

  /**
   * The PM's mapping file, parsed the way `readMapping()` does: the patient-id column resolved by
   * alias, the IK stripped to digits, rows with no id or no IK dropped, and **the FIRST row wins**
   * for a duplicated patient id (file order — the preparation put the fresher source first).
   *
   * Returns `null` when no GitHub credential is available, so the file-dependent tests can gate
   * rather than fail for a reason unrelated to the ticket.
   */
  async mappingRows(): Promise<{ rows: MappingRow[]; mapping: Map<number, string>; sha256: string } | null> {
    const token = process.env.GITHUB_TOKEN ?? this.ghToken();
    if (!token) return null;

    const res = await this.page.request.get(MAPPING_FILE.url, {
      headers: { Authorization: `token ${token}` },
      timeout: 120_000,
    });
    if (!res.ok()) return null;
    const body = await res.body();
    const sha256 = createHash('sha256').update(body).digest('hex');
    const text = body.toString('utf8');

    const lines = text.split(/\r\n|\r|\n/).filter((line) => '' !== line.trim());
    const columns = lines[0].replace(/^﻿/, '').split(',').map((c) => c.trim().toLowerCase());
    const patientIndex = columns.findIndex((c) => ['flow_patient_id', 'patient_id', 'patientid', 'patient', 'id'].includes(c));
    const ikIndex = columns.findIndex((c) => ['ik', 'ik_number', 'iknumber', 'ik_nummer', 'iknummer'].includes(c));

    const rows: MappingRow[] = [];
    const mapping = new Map<number, string>();
    for (const line of lines.slice(1)) {
      const cells = PatientIkLinkPage.splitCsv(line);
      const patientId = Number.parseInt((cells[patientIndex] ?? '').trim(), 10);
      const ik = (cells[ikIndex] ?? '').replace(/\D+/g, '');
      if (!Number.isFinite(patientId) || patientId <= 0 || '' === ik) continue;
      rows.push({ patientId, ik, insurerName: (cells[2] ?? '').trim(), source: (cells[3] ?? '').trim() });
      if (!mapping.has(patientId)) mapping.set(patientId, ik);
    }
    return { rows, mapping, sha256 };
  }

  private ghToken(): string | null {
    try {
      return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  }

  /** A CSV line split that respects quoted fields — insurer names contain commas. */
  private static splitCsv(line: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if ('"' === ch) {
        if (quoted && '"' === line[i + 1]) {
          cur += '"';
          i += 1;
        } else quoted = !quoted;
      } else if (',' === ch && !quoted) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  // ─────────────────────────────── the catalogue and the patients ───────────────────────────────

  /** The #2969 provider catalog, keyed by IK. The column is unique, so an IK matches one provider. */
  async providersByIk(): Promise<Map<string, ProviderRow>> {
    const body = await this.get('/insurance_providers?pagination=false');
    const out = new Map<string, ProviderRow>();
    for (const p of body.member ?? []) out.set(String(p.ik), { id: p.id, ik: String(p.ik), name: p.name });
    return out;
  }

  /**
   * Current state of the given patients, batched through `?id[]=`.
   *
   * Absent ids simply do not come back — which IS the "patient id not found" signal, so the caller
   * compares the returned keys against what it asked for rather than probing each id.
   */
  async patientStates(ids: number[], chunkSize = 50, concurrency = 3): Promise<Map<number, PatientState>> {
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));

    const out = new Map<number, PatientState>();
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const chunk = chunks[cursor++];
        if (!chunk) return;
        const qs = chunk.map((id) => `id%5B%5D=${id}`).join('&');
        const body = await this.get(`/patients?${qs}&itemsPerPage=${chunk.length}`);
        for (const m of body.member ?? []) {
          const provider = m.insuranceProvider ?? null;
          out.set(m.id, {
            id: m.id,
            name: `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim(),
            providerId: provider?.id ?? null,
            providerIk: provider ? String(provider.ik) : null,
            providerName: provider?.name ?? null,
            insuranceCompany: m.insuranceCompany ?? null,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return out;
  }

  /**
   * Every patient's provider IK, by walking the collection.
   *
   * The only way to count the unlinked population: `exists[insuranceProvider]` is accepted and
   * silently ignored (both `true` and `false` return all 8,370), and no other filter exposes it.
   * ~170 pages at 50 per page.
   */
  async walkAllPatients(perPage = 50, concurrency = 3): Promise<Map<number, string | null>> {
    const first = await this.get(`/patients?itemsPerPage=1`);
    const total: number = first.totalItems ?? 0;
    const pages = Math.ceil(total / perPage);

    const out = new Map<number, string | null>();
    let cursor = 1;
    const worker = async () => {
      for (;;) {
        const page = cursor++;
        if (page > pages) return;
        const body = await this.get(`/patients?page=${page}&itemsPerPage=${perPage}`);
        for (const m of body.member ?? []) {
          const provider = m.insuranceProvider ?? null;
          out.set(m.id, provider ? String(provider.ik) : null);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return out;
  }

  // ─────────────────────────────── the run's own record ───────────────────────────────

  /**
   * The `insuranceProvider` field-change log entries — the command's record of what it changed.
   *
   * `/patient_logs` cannot filter on the meta field, so the whole `field_change` set is pulled once
   * (7,700 rows, ~4 MB) and narrowed here.
   */
  async insuranceProviderLogs(): Promise<RunLog[]> {
    const body = await this.get('/patient_logs?type=field_change&pagination=false', 300_000);
    const out: RunLog[] = [];
    for (const row of body.member ?? []) {
      if ('insuranceProvider' !== (row.meta ?? {}).field) continue;
      out.push({
        patientId: Number(String(row.patient).split('/').pop()),
        batchId: row.batchId ?? null,
        createdAt: row.createdAt,
        oldValue: row.oldValue ?? null,
        newValue: row.newValue ?? null,
        metaType: (row.meta ?? {}).type ?? null,
        createdBy: row.createdBy?.fullName ?? null,
      });
    }
    return out;
  }

  /** Every log entry of one patient, for the per-patient checks. */
  async logsFor(patientId: number): Promise<Array<{ type: string; createdAt: string; meta: Record<string, unknown> }>> {
    const body = await this.get(`/patient_logs?patient=%2Fpatients%2F${patientId}&itemsPerPage=100`);
    return (body.member ?? []).map((m: any) => ({ type: m.type, createdAt: m.createdAt, meta: m.meta ?? {} }));
  }

  // ─────────────────────────────── the oracle ───────────────────────────────

  /**
   * The command's decisions, re-derived. `changedByRun` is the set the log trail names — needed
   * because a patient the run linked now HAS a provider, which would otherwise put it in the
   * already-linked bucket on a second evaluation (that is the idempotency the command relies on).
   */
  static decide(
    mapping: Map<number, string>,
    patients: Map<number, PatientState>,
    providers: Map<string, ProviderRow>,
    changedByRun: Set<number>,
  ): Outcome {
    const outcome: Outcome = { toLink: new Map(), notFound: [], alreadyLinked: [], unmatchedIk: [] };
    for (const [patientId, ik] of mapping) {
      const patient = patients.get(patientId);
      if (!patient) {
        outcome.notFound.push(patientId);
        continue;
      }
      if (!changedByRun.has(patientId) && null !== patient.providerId) {
        outcome.alreadyLinked.push(patientId);
        continue;
      }
      const provider = providers.get(ik);
      if (!provider) {
        outcome.unmatchedIk.push({ patientId, ik });
        continue;
      }
      outcome.toLink.set(patientId, provider);
    }
    return outcome;
  }
}
