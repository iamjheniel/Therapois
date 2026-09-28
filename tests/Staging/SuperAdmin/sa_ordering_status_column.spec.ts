import { test, expect } from '@playwright/test';
import {
  OrderingStatusColumnPage,
  ORDERING_STATUSES,
  LABELS,
  ADMIN_SETTABLE,
  FACILITY_DRIVEN,
  RANKED_ASC,
  LEXICOGRAPHIC_ASC,
  COLUMN_HEADER,
  FIXTURES,
  type OrderingStatus,
} from '../../../Pages/admin/admin.ordering-status-column.page';
import { STAGING_CREDENTIALS } from '../../../Pages/util/api-token';

/**
 * RC 3.14 #3749 — the Admin Board's Bestell-Status column hid two of the four ordering statuses
 * and let an admin overwrite a value it had never shown them.
 *
 * READ-ONLY. The one editor this file opens is closed with Escape; no ordering status is ever
 * written, because #3749 AC3's own subject is the confirmation step that follows a selection.
 */

const S = OrderingStatusColumnPage;

test.describe('#3749 Bestell-Status column shows all four ordering statuses', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let api: OrderingStatusColumnPage;

  test.beforeEach(({ page }) => {
    api = new OrderingStatusColumnPage(page);
  });

  test(
    'AC5 deployment — the sort is the ranked one, not the lexicographic one it replaced',
    { tag: ['@SuperAdmin', '@OrderingStatusColumn', '@ReadOnly'] },
    async () => {
      // The two candidate orders are DISJOINT at both ends, which is what makes one page of one
      // row decide the question. `/status` cannot: it reports the release, not the commit (#3704),
      // and `14bd9aff4` landed on release/3.14.0 under a `Ref` trailer with no PR of its own.
      for (const resource of ['prescriptions', 'v2/prescriptions'] as const) {
        const asc = await api.sortedFirstValue('asc', resource);
        const desc = await api.sortedFirstValue('desc', resource);
        console.log(`#3749 /${resource}: order[orderingStatus] asc → "${asc}", desc → "${desc}"`);
        console.log(
          `#3749   ranked oracle expects ${RANKED_ASC[0]} / ${RANKED_ASC[3]}; ` +
            `the pre-fix lexicographic one expects ${LEXICOGRAPHIC_ASC[0]} / ${LEXICOGRAPHIC_ASC[3]}`,
        );
        expect(asc, `/${resource} ascending is still the pre-fix lexicographic order`).toBe(RANKED_ASC[0]);
        expect(desc, `/${resource} descending is still the pre-fix lexicographic order`).toBe(RANKED_ASC[3]);
        // The stock OrderFilter entry was removed on both resources and the dedicated filter
        // registers the key itself — so the board's own request shape is unchanged.
        expect(await api.advertisesOrderKey(resource), `/${resource} no longer advertises the sort`).toBe(true);
      }
    },
  );

  test(
    'AC5 the whole book sorts into the four ranked blocks, and nothing sorts as if it were empty',
    { tag: ['@SuperAdmin', '@OrderingStatusColumn', '@ReadOnly'] },
    async () => {
      const counts = new Map<OrderingStatus, number>();
      for (const status of ORDERING_STATUSES) counts.set(status, await api.countOf(status));
      const total = await api.countOf(null);
      const summed = [...counts.values()].reduce((a, b) => a + b, 0);
      console.log(`#3749 population: ${JSON.stringify(Object.fromEntries(counts))} = ${summed} of ${total} VOs`);

      // AC5's "no prescription sorts as if its value were empty" is a property of the DATA as much
      // as of the filter: the four groups account for the whole book, so there is no null to sink.
      expect(summed, 'some VO carries an ordering status outside the four').toBe(total);

      // Walk the block boundaries by ordinal. `itemsPerPage=1&page=N` addresses one row by
      // position, so the entire ordering of ~35k rows is provable in eight requests rather than a
      // full walk (which takes minutes and times out at 500 rows a page).
      let offset = 0;
      for (const status of RANKED_ASC) {
        const size = counts.get(status)!;
        if (size === 0) continue;
        const first = offset + 1;
        const last = offset + size;
        const [atFirst, atLast] = [await api.statusAtPosition(first), await api.statusAtPosition(last)];
        console.log(`#3749 ascending positions ${first}–${last} must all be "${status}": got "${atFirst}" … "${atLast}"`);
        expect(atFirst, `position ${first}`).toBe(status);
        expect(atLast, `position ${last}`).toBe(status);
        offset = last;
      }
      expect(offset).toBe(total);
    },
  );

  test(
    'AC1/AC2 all four values render, and the facility-driven two open no editor',
    { tag: ['@SuperAdmin', '@OrderingStatusColumn', '@ReadOnly'] },
    async () => {
      // The column ships OFF — AC1 is explicit that it is reached through the Spalten chooser.
      await api.openBoardWithColumn(STAGING_CREDENTIALS.superadmin);
      expect(await api.board.headerLabels()).toContain(COLUMN_HEADER);

      const cases: { vo: string; status: OrderingStatus }[] = [
        { vo: FIXTURES.praxis, status: 'Praxis' },
        { vo: FIXTURES.er, status: 'ER bestellt selbst' },
        { vo: FIXTURES.byAdmin, status: 'By Admin' },
        { vo: FIXTURES.byTherapist, status: 'By Therapist' },
        // AC4's Super-Admin half rides along: a billing-validated VO stays editable for a Super
        // Admin, which is also what stops "read-only" being explained by the lock instead.
        { vo: FIXTURES.validatedByAdmin, status: 'By Admin' },
      ];

      for (const { vo, status } of cases) {
        // The stored value is re-read rather than trusted: a fixture whose ordering status has
        // been changed on staging would otherwise report the board as broken.
        const stored = await api.voByNumber(vo);
        expect(stored?.orderingStatus, `fixture ${vo} no longer carries ${status}`).toBe(status);

        await api.showOnly(vo);
        const cell = await api.orderingCell();
        const facilityDriven = FACILITY_DRIVEN.includes(status);
        console.log(
          `#3749 ${vo} (${status}) → painted "${cell.text}", editor=${cell.editable}, ` +
            `aria-label=${cell.ariaLabel}, aria-disabled=${cell.ariaDisabled}, cursor=${cell.cursor}`,
        );

        // AC1: the label, for all four — this is the defect itself.
        expect(cell.text, `${vo} still paints the dash instead of ${LABELS[status]}`).toBe(LABELS[status]);
        expect(cell.text).not.toBe('-');
        expect(cell.text).not.toBe('—');

        // AC2: facility-driven values render a read-only pill — no button, no pointer, so there is
        // nothing that a later change could re-enable. The two admin-settable ones keep theirs.
        expect(cell.editable, `${vo} (${status}) editor presence`).toBe(!facilityDriven);
        if (facilityDriven) {
          expect(cell.cursor, `${vo} still looks clickable`).not.toBe('pointer');
          expect(cell.ariaLabel).toBeNull();
        } else {
          expect(cell.ariaLabel).toBe(`Status: ${LABELS[status]}`);
          expect(cell.ariaDisabled, `${vo} is editable for a Super Admin`).not.toBe('true');
        }
      }
    },
  );

  test(
    'AC3 an admin-settable value still opens its editor, offering exactly the two settable values',
    { tag: ['@SuperAdmin', '@OrderingStatusColumn', '@ReadOnly'] },
    async () => {
      await api.openBoardWithColumn(STAGING_CREDENTIALS.superadmin);
      await api.showOnly(FIXTURES.byAdmin);

      const before = await api.orderingCell();
      expect(before.editable).toBe(true);
      const options = await api.openEditorOptions();
      console.log(`#3749 editor on ${FIXTURES.byAdmin} offers: ${JSON.stringify(options)}`);

      // #2614's rule still holds and this ticket keeps it: the editor offers the two an admin may
      // set and neither facility-driven value — which is exactly why the display had to be fixed
      // somewhere other than the options array.
      expect(new Set(options)).toEqual(new Set(ADMIN_SETTABLE.map((s) => LABELS[s])));
      for (const status of FACILITY_DRIVEN) {
        expect(options, `the editor must never offer ${LABELS[status]}`).not.toContain(LABELS[status]);
      }

      // Nothing is selected: a selection raises the confirmation step and then writes, and this
      // file does not move a real VO's ordering status.
      await api.closeEditor();
      const after = await api.orderingCell();
      expect(after.text).toBe(before.text);
      expect((await api.voByNumber(FIXTURES.byAdmin))?.orderingStatus).toBe('By Admin');
    },
  );

  test(
    'AC4 a billing-validated VO stays locked for an admin, with the editor present but disabled',
    { tag: ['@SuperAdmin', '@OrderingStatusColumn', '@ReadOnly'] },
    async ({ page }) => {
      // Signed in as a plain ROLE_ADMIN — the lock is `validationStatus === 'validated' && !isSuper`,
      // so a Super Admin cannot demonstrate it (their half is asserted in the AC1/AC2 test).
      const asAdmin = new OrderingStatusColumnPage(page);
      await asAdmin.openBoardWithColumn(STAGING_CREDENTIALS.admin);

      // Prove the role before reading the lock: with the Super Admin's stored user left in place
      // the board renders `isSuper` and every cell is editable, which reads as "AC4 failed".
      const roles = await asAdmin.currentRoles();
      console.log(`#3749 board opened as ${STAGING_CREDENTIALS.admin.email} with roles ${JSON.stringify(roles)}`);
      expect(roles, 'the board is not running as a plain admin').toContain('ROLE_ADMIN');
      expect(roles, 'the board is running as a Super Admin, so AC4 cannot be measured').not.toContain(
        'ROLE_SUPER_ADMIN',
      );

      await asAdmin.showOnly(FIXTURES.validatedByAdmin);
      const locked = await asAdmin.orderingCell();
      console.log(
        `#3749 admin on ${FIXTURES.validatedByAdmin} (validated) → "${locked.text}", ` +
          `editor=${locked.editable}, aria-disabled=${locked.ariaDisabled}, cursor=${locked.cursor}`,
      );
      expect(locked.text).toBe(LABELS['By Admin']);
      expect(locked.editable, 'the lock is a disabled editor, not a removed one').toBe(true);
      expect(locked.ariaDisabled, 'a billing-validated VO is not locked for a plain admin').toBe('true');
      expect(locked.cursor).not.toBe('pointer');
      // The lock is real, not decorative: clicking it opens nothing.
      expect(await asAdmin.openEditorOptions()).toEqual([]);

      // The control that makes the lock attributable to billing validation rather than to the role:
      // the same admin, on a VO with the same By Admin status and no validation, gets the editor.
      await asAdmin.showOnly(FIXTURES.byAdmin);
      const open = await asAdmin.orderingCell();
      console.log(`#3749 admin on ${FIXTURES.byAdmin} (not validated) → editor=${open.editable}, aria-disabled=${open.ariaDisabled}`);
      expect(open.editable).toBe(true);
      expect(open.ariaDisabled).not.toBe('true');

      // AC2 holds for a plain admin too — a facility-driven value is read-only for every role.
      await asAdmin.showOnly(FIXTURES.praxis);
      const readOnly = await asAdmin.orderingCell();
      console.log(`#3749 admin on ${FIXTURES.praxis} → "${readOnly.text}", editor=${readOnly.editable}`);
      expect(readOnly.text).toBe(LABELS.Praxis);
      expect(readOnly.editable).toBe(false);
    },
  );

  test(
    'AC5 on screen — sorting the column puts the ranked order in front of the admin',
    { tag: ['@SuperAdmin', '@OrderingStatusColumn', '@ReadOnly'] },
    async () => {
      // No search in this test: the board's search box goes readonly after Enter and the only
      // reset is a reload, which a minted session cannot survive (#3460).
      await api.openBoardWithColumn(STAGING_CREDENTIALS.superadmin);

      const unsorted = await api.columnValues();
      console.log(`#3749 unsorted first page: ${JSON.stringify(unsorted.slice(0, 8))}`);
      expect(unsorted.length).toBeGreaterThan(0);

      await api.sortByColumn();
      const asc = await api.columnValues();
      console.log(`#3749 after one click: ${JSON.stringify(asc.slice(0, 8))}`);
      expect(asc[0], 'ascending must open on the facility-driven block').toBe(LABELS['ER bestellt selbst']);
      expect(asc[0], 'this is the pre-fix lexicographic order').not.toBe(LABELS['By Admin']);

      await api.sortByColumn();
      const desc = await api.columnValues();
      console.log(`#3749 after two clicks: ${JSON.stringify(desc.slice(0, 8))}`);
      expect(desc[0]).toBe(LABELS['By Therapist']);
      expect(desc[0], 'this is the pre-fix lexicographic order').not.toBe(LABELS.Praxis);

      // Whatever the direction, every painted value is one of the four labels — nothing renders
      // as a dash or an empty cell, which is AC5's second half on the surface it is about.
      for (const [name, values] of [['asc', asc], ['desc', desc]] as const) {
        const strays = values.filter((v) => !Object.values(LABELS).includes(v));
        console.log(`#3749 ${name}: ${values.length} cells painted, ${strays.length} outside the four labels`);
        expect(strays).toEqual([]);
      }
    },
  );

  test(
    'evidence — the hidden population this ticket was raised for',
    { tag: ['@SuperAdmin', '@OrderingStatusColumn', '@ReadOnly'] },
    async () => {
      const rows: string[] = [];
      for (const status of ORDERING_STATUSES) {
        const all = await api.countOf(status);
        const body = await api.voByNumber(
          status === 'Praxis' ? FIXTURES.praxis : status === 'ER bestellt selbst' ? FIXTURES.er : FIXTURES.byAdmin,
        );
        rows.push(`${status} → "${LABELS[status]}": ${all} VOs${body ? '' : ''}`);
      }
      console.log(`#3749 ${rows.join(' | ')}`);

      // The ticket quotes 945 Praxis and 61 ER from a 17 September dump and calls them estimates.
      // Reported rather than asserted — the figure moves, the fact that the hidden set is large
      // does not.
      const praxis = await api.countOf('Praxis');
      const er = await api.countOf('ER bestellt selbst');
      console.log(
        `#3749 the two values the column used to hide now stand at ${praxis} (Praxis) and ${er} (ER bestellt selbst); ` +
          `the ticket's 17 Sep dump recorded 945 and 61.`,
      );
      expect(praxis + er).toBeGreaterThan(0);

      // Both repro VOs still sit on facilities whose ordering MODE is the source of the value —
      // which is the ticket's reason for making them read-only rather than merely displaying them.
      for (const [vo, mode] of [[FIXTURES.praxis, 'praxis_vo'], [FIXTURES.er, 'er_bestellt_selbst']] as const) {
        const row = await api.voByNumber(vo);
        console.log(`#3749 ${vo}: ordering status "${row?.orderingStatus}" from facility ${row?.elderlyCareHome?.name} (orderingMode ${row?.elderlyCareHome?.orderingMode})`);
        expect(row?.elderlyCareHome?.orderingMode).toBe(mode);
      }
    },
  );
});
