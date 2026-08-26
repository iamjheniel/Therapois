import { test, expect } from '@playwright/test';
import {
  BoardFiltersPage,
  LOCATION_PASSTHROUGH,
  PATIENT_TYPE_PASSTHROUGH,
  PERIOD_FROM,
  PERIOD_TO,
  PROVIDERS,
  PROVIDER_KEYS,
  ProviderKey,
  REVENUE_PROVIDERS,
} from '../../../Pages/superadmin/sa.board-filters.page';

/**
 * RC 3.11 #3311 — "Consolidate the Board Providers' Copy-Pasted Filter Parsing into One Shared
 * Resolver" (`ManagementFilterResolver`).
 *
 * A pure refactor with zero behaviour change as its hard constraint: nine verbatim copies of
 * `resolveInsuranceTypes()` and the shared filter-parse block became one service. AC1 (no private
 * copy survives), AC2 (the backend integration suites pass unedited) and AC3 (cache keys are
 * byte-identical) are all source-level and are `fixme`'d at the bottom — they were verified by code
 * grep, not from a browser.
 *
 * What these tests measure is the externally observable form of the same property, and of the exact
 * failure the ticket exists to prevent: **all nine providers must answer the same filter the same
 * way.** The ticket's own words for the risk — "missing one produces a board that quietly disagrees
 * with the others: no error, no failing test, just two screens showing different numbers for the
 * same filter". Four of the nine report treated revenue by four independent routes, so that
 * disagreement is directly measurable.
 *
 * **Read-only.** Every endpoint here is a GET and nothing on this surface writes; the one mutating
 * route on the board (`POST /kpis/management/export`) is deliberately not touched.
 *
 * Note the resolver's documented `null` / `''` / `'all'` passthrough is **not reachable from the
 * UI** — the "Alle Patienten" control simply sends no parameter — so those forms are exercised by
 * calling the endpoints directly.
 */
test.describe('Board filter resolver — one shared parse for nine providers (#3311)', () => {
  let boards: BoardFiltersPage;

  test.beforeEach(async ({ page }) => {
    boards = new BoardFiltersPage(page);
    await boards.open();
  });

  test(
    'AC1 — all nine provider endpoints are live and answer the shared filter set',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FilterResolver'] },
    async () => {
      test.setTimeout(300_000);

      const failures: string[] = [];
      for (const key of PROVIDER_KEYS) {
        const spec = PROVIDERS[key];
        const res = await boards.fetch(key, '&patientType=gkv&location=einrichtung');
        console.log(
          `[#3311] ${spec.provider.padEnd(34)} ${spec.path.padEnd(38)} ${res.status} ` +
            `${String(res.bytes).padStart(8)}B ${res.ms}ms`,
        );
        if (res.status !== 200) failures.push(`${spec.provider} → ${spec.path} answered ${res.status}: ${res.canonical}`);
      }

      expect(PROVIDER_KEYS.length, 'AC1 names exactly nine providers').toBe(9);
      expect(failures, 'every provider that consumes the resolver must still serve its board').toEqual([]);
    },
  );

  test(
    "AC2 — the patientType passthrough (absent / '' / 'all' / unknown) is identical on all nine",
    { tag: ['@SuperAdmin', '@FlowBoards', '@FilterResolver'] },
    async () => {
      test.setTimeout(600_000);

      const divergent: string[] = [];
      for (const key of PROVIDER_KEYS) {
        const digests: string[] = [];
        for (const variant of PATIENT_TYPE_PASSTHROUGH) {
          const res = await boards.fetch(key, variant.query);
          expect(res.status, `${PROVIDERS[key].path} ${variant.label}`).toBe(200);
          digests.push(res.digest);
        }
        const agreed = new Set(digests).size === 1;
        console.log(
          `[#3311] ${PROVIDERS[key].provider.padEnd(34)} ${agreed ? 'agree' : 'DIVERGE'} ` +
            PATIENT_TYPE_PASSTHROUGH.map((v, i) => `${v.label}=${digests[i]}`).join(' '),
        );
        if (!agreed) divergent.push(`${PROVIDERS[key].provider}: ${digests.join(' vs ')}`);
      }

      // One resolver means one answer to "no insurance filter", whichever way it is spelled. Nine
      // copies drifting apart is precisely what would show up here.
      expect(divergent, "every provider must treat absent / '' / 'all' / an unknown value alike").toEqual([]);
    },
  );

  test(
    'AC2 — the location passthrough is identical on all nine',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FilterResolver'] },
    async () => {
      test.setTimeout(600_000);

      const divergent: string[] = [];
      for (const key of PROVIDER_KEYS) {
        const digests: string[] = [];
        for (const variant of LOCATION_PASSTHROUGH) {
          const res = await boards.fetch(key, variant.query);
          expect(res.status, `${PROVIDERS[key].path} ${variant.label}`).toBe(200);
          digests.push(res.digest);
        }
        const agreed = new Set(digests).size === 1;
        console.log(`[#3311] ${PROVIDERS[key].provider.padEnd(34)} location ${agreed ? 'agree' : 'DIVERGE'} ${digests.join(' ')}`);
        if (!agreed) divergent.push(`${PROVIDERS[key].provider}: ${digests.join(' vs ')}`);
      }

      expect(divergent, 'the same parse block handles location — it must fall back identically too').toEqual([]);
    },
  );

  test(
    'every provider actually reads the filter — gkv, pkv and unfiltered differ on all nine',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FilterResolver'] },
    async () => {
      test.setTimeout(600_000);

      const ignored: string[] = [];
      for (const key of PROVIDER_KEYS) {
        const all = await boards.fetch(key);
        const gkv = await boards.fetch(key, '&patientType=gkv');
        const pkv = await boards.fetch(key, '&patientType=pkv');
        const distinct = new Set([all.digest, gkv.digest, pkv.digest]).size;
        console.log(`[#3311] ${PROVIDERS[key].provider.padEnd(34)} all=${all.digest} gkv=${gkv.digest} pkv=${pkv.digest}`);
        if (distinct !== 3) ignored.push(`${PROVIDERS[key].provider}: only ${distinct} distinct results`);
      }

      // The board's UI only drives five of the nine endpoints, so a provider could silently ignore
      // patientType and no screen would show it. Consuming the shared resolver means all nine read it.
      expect(ignored, 'a provider whose payload does not move with patientType is not consuming the resolver').toEqual([]);
    },
  );

  test(
    'four providers report the same treated revenue under every filter',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FilterResolver'] },
    async () => {
      test.setTimeout(600_000);

      const filters = [
        { label: 'unfiltered', query: '' },
        { label: 'patientType=gkv', query: '&patientType=gkv' },
        { label: 'patientType=pkv', query: '&patientType=pkv' },
        { label: 'location=einrichtung', query: '&location=einrichtung' },
        { label: 'location=praxis', query: '&location=praxis' },
      ];

      const disagreements: string[] = [];
      for (const filter of filters) {
        const readings: Record<string, number | null> = {};
        for (const key of REVENUE_PROVIDERS) {
          const res = await boards.fetch(key, filter.query);
          expect(res.status, `${PROVIDERS[key].path} ${filter.label}`).toBe(200);
          readings[PROVIDERS[key].provider] = BoardFiltersPage.revenue(key, res.body);
        }
        const values = Object.values(readings);
        console.log(`[#3311] ${filter.label.padEnd(22)} ${JSON.stringify(readings)}`);
        if (new Set(values).size !== 1) disagreements.push(`${filter.label}: ${JSON.stringify(readings)}`);
      }

      // This is the ticket's motivating failure made measurable: one number, four independent
      // providers, one shared definition of what the filter means.
      expect(disagreements, 'four providers reporting the same period must not disagree under any filter').toEqual([]);
    },
  );

  test(
    'GKV and PKV partition the unfiltered revenue exactly',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FilterResolver'] },
    async () => {
      test.setTimeout(600_000);

      const mismatches: string[] = [];
      for (const key of REVENUE_PROVIDERS) {
        const all = BoardFiltersPage.revenue(key, (await boards.fetch(key)).body);
        const gkv = BoardFiltersPage.revenue(key, (await boards.fetch(key, '&patientType=gkv')).body);
        const pkv = BoardFiltersPage.revenue(key, (await boards.fetch(key, '&patientType=pkv')).body);
        const sum = Number(((gkv ?? 0) + (pkv ?? 0)).toFixed(2));
        console.log(`[#3311] ${PROVIDERS[key].provider.padEnd(34)} gkv ${gkv} + pkv ${pkv} = ${sum} vs all ${all}`);
        if (Math.abs(sum - (all ?? 0)) > 0.01) mismatches.push(`${PROVIDERS[key].provider}: ${gkv} + ${pkv} = ${sum} ≠ ${all}`);
      }

      // "Privat / Kasse / alle" is the helper the ticket is named after. If the two halves stop
      // summing to the whole on any one provider, that provider's mapping has drifted.
      expect(mismatches, 'gkv + pkv must reconstruct the unfiltered total on every revenue provider').toEqual([]);
    },
  );

  test(
    'AC3 (proxy) — identical requests return identical payloads on all nine',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FilterResolver'] },
    async () => {
      test.setTimeout(600_000);

      const unstable: string[] = [];
      for (const key of PROVIDER_KEYS) {
        const first = await boards.fetch(key, '&patientType=gkv');
        const second = await boards.fetch(key, '&patientType=gkv');
        console.log(`[#3311] ${PROVIDERS[key].provider.padEnd(34)} ${first.digest} / ${second.digest} (${first.ms}ms, ${second.ms}ms)`);
        if (first.digest !== second.digest) unstable.push(`${PROVIDERS[key].provider}: ${first.digest} ≠ ${second.digest}`);
      }

      // Cache keys are built from the resolver's parsed values, so a provider that answered the same
      // request two different ways would mean those parsed values are not stable. This is the
      // closest external stand-in for AC3 — it cannot inspect the key itself.
      expect(unstable, 'the parsed filter values must be stable for identical requests').toEqual([]);
    },
  );

  /**
   * AC1's real wording ("no provider retains a private `resolveInsuranceTypes()`"), AC2's ("the
   * existing integration suites pass unchanged") and AC3's ("each provider's cache key is
   * byte-identical") are all statements about the API source tree and its PHPUnit suite. None is
   * observable over HTTP: identical responses are consistent with one shared resolver *and* with
   * nine copies that still happen to agree, and a cache key is never exposed in a response.
   *
   * The PM verified all three by grep on 2026-08-11 (`ManagementFilterResolver.php` exists in
   * `api/src/Service/Kpi/` and is consumed by exactly nine providers, with zero private copies left
   * in `api/src/State/`). The tests above cover the behavioural half — that the nine agree today,
   * and will fail loudly if a future provider goes back to its own copy.
   */
  test.fixme(
    'AC1/AC2/AC3 — no private resolveInsuranceTypes remains, suites unedited, cache keys byte-identical',
    { tag: ['@SuperAdmin', '@FlowBoards', '@FilterResolver'] },
    async () => {
      // Source-level: needs the api/ tree and its PHPUnit suite, neither reachable from the browser.
    },
  );

  test.afterAll(() => {
    console.log(`[#3311] period under test: ${PERIOD_FROM} … ${PERIOD_TO} (read-only; every request a GET)`);
  });
});
