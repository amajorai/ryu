// Unit tests for the collaborative data-grid Yjs model. These exercise the pure
// shared-type model on plain `Y.Doc`s (no transport): seeding, the snapshot
// round-trip, the mutators, and — the convergence guarantee the whole design
// rests on — that two peers applying concurrent edits in either order reach the
// same rows in the same order (fractional `__order` + `__id` tiebreak).

import { describe, expect, test } from "bun:test";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import {
	addColumn,
	addRow,
	applyCellEdits,
	type DatabaseDoc,
	isDatabaseEmpty,
	orderKeyBetween,
	removeColumn,
	removeRows,
	seedDatabase,
	snapshotDatabase,
} from "./yjs-database.ts";

/** Two-way sync `a` and `b` to convergence (small docs, one round is enough). */
function sync(a: Doc, b: Doc): void {
	applyUpdate(b, encodeStateAsUpdate(a));
	applyUpdate(a, encodeStateAsUpdate(b));
}

const SAMPLE: DatabaseDoc = {
	columns: [
		{ id: "col_name", label: "Name", cell: { variant: "short-text" } },
		{ id: "col_done", label: "Done", cell: { variant: "checkbox" } },
	],
	rows: [
		{ col_name: "Alpha", col_done: false },
		{ col_name: "Beta", col_done: true },
	],
};

describe("yjs-database model", () => {
	test("seed then snapshot round-trips columns and rows in order", () => {
		const doc = new Doc();
		expect(isDatabaseEmpty(doc)).toBe(true);
		seedDatabase(doc, SAMPLE);
		expect(isDatabaseEmpty(doc)).toBe(false);

		const snap = snapshotDatabase(doc);
		expect(snap.columns.map((c) => c.id)).toEqual(["col_name", "col_done"]);
		expect(snap.rows.map((r) => r.col_name)).toEqual(["Alpha", "Beta"]);
		// Every snapshot row carries a stable id for addressing later edits.
		expect(snap.rows.every((r) => typeof r.__id === "string")).toBe(true);
	});

	test("seedDatabase is idempotent on column id (no duplicate columns)", () => {
		const doc = new Doc();
		seedDatabase(doc, SAMPLE);
		// A second seed (e.g. if two seeds ever raced past the server claim) must NOT
		// re-add columns whose stable id already exists — duplicate `col_name` ids
		// would corrupt react keys / tanstack column ids.
		seedDatabase(doc, SAMPLE);
		expect(snapshotDatabase(doc).columns.map((c) => c.id)).toEqual([
			"col_name",
			"col_done",
		]);
	});

	test("cell edit addresses the row by stable id, not position", () => {
		const doc = new Doc();
		seedDatabase(doc, SAMPLE);
		const before = snapshotDatabase(doc);
		const betaId = before.rows[1]?.__id as string;

		applyCellEdits(doc, [
			{ rowId: betaId, columnId: "col_name", value: "Beta!" },
		]);

		const after = snapshotDatabase(doc);
		expect(after.rows[1]?.col_name).toBe("Beta!");
		expect(after.rows[0]?.col_name).toBe("Alpha");
	});

	test("add/remove row and add/remove column mutate the doc", () => {
		const doc = new Doc();
		seedDatabase(doc, SAMPLE);

		const newId = addRow(doc, snapshotDatabase(doc).columns);
		expect(snapshotDatabase(doc).rows).toHaveLength(3);
		expect(snapshotDatabase(doc).rows[2]?.__id).toBe(newId);

		removeRows(doc, [newId]);
		expect(snapshotDatabase(doc).rows).toHaveLength(2);

		addColumn(doc, {
			id: "col_notes",
			label: "Notes",
			cell: { variant: "long-text" },
		});
		const withCol = snapshotDatabase(doc);
		expect(withCol.columns.map((c) => c.id)).toContain("col_notes");
		// New column backfilled on existing rows (empty long-text => "").
		expect(withCol.rows[0]?.col_notes).toBe("");

		removeColumn(doc, "col_notes");
		expect(snapshotDatabase(doc).columns.map((c) => c.id)).not.toContain(
			"col_notes"
		);
	});

	test("concurrent edits to different cells merge", () => {
		const base = new Doc();
		seedDatabase(base, SAMPLE);
		const a = new Doc();
		const b = new Doc();
		applyUpdate(a, encodeStateAsUpdate(base));
		applyUpdate(b, encodeStateAsUpdate(base));

		const ids = snapshotDatabase(a).rows.map((r) => r.__id as string);
		// Peer A edits Alpha's name; peer B (concurrently) toggles Beta's checkbox.
		applyCellEdits(a, [
			{ rowId: ids[0] as string, columnId: "col_name", value: "Alpha-A" },
		]);
		applyCellEdits(b, [
			{ rowId: ids[1] as string, columnId: "col_done", value: false },
		]);
		sync(a, b);

		const snapA = snapshotDatabase(a);
		const snapB = snapshotDatabase(b);
		expect(snapA.rows[0]?.col_name).toBe("Alpha-A");
		expect(snapA.rows[1]?.col_done).toBe(false);
		// Both peers converge to identical content.
		expect(snapB.rows.map((r) => r.col_name)).toEqual(
			snapA.rows.map((r) => r.col_name)
		);
	});

	test("concurrent appends converge to the same order on both peers", () => {
		const base = new Doc();
		seedDatabase(base, SAMPLE);
		const a = new Doc();
		const b = new Doc();
		applyUpdate(a, encodeStateAsUpdate(base));
		applyUpdate(b, encodeStateAsUpdate(base));

		// Each peer appends a row from the same baseline: both compute the SAME
		// __order, so convergence relies on the __id tiebreak in the snapshot sort.
		addRow(a, snapshotDatabase(a).columns);
		addRow(b, snapshotDatabase(b).columns);
		sync(a, b);

		const orderA = snapshotDatabase(a).rows.map((r) => r.__id);
		const orderB = snapshotDatabase(b).rows.map((r) => r.__id);
		expect(orderA).toEqual(orderB);
		expect(orderA).toHaveLength(4);
	});

	test("orderKeyBetween yields strictly increasing append keys", () => {
		let prev: string | null = null;
		const keys: string[] = [];
		for (let i = 0; i < 50; i += 1) {
			const key = orderKeyBetween(prev, null);
			keys.push(key);
			prev = key;
		}
		const sorted = [...keys].sort();
		expect(keys).toEqual(sorted);
		// A midpoint insert between two neighbours sorts strictly between them.
		const mid = orderKeyBetween(keys[0] as string, keys[1] as string);
		expect((keys[0] as string) < mid).toBe(true);
		expect(mid < (keys[1] as string)).toBe(true);
	});
});
