import { describe, expect, test } from "bun:test";
import {
	groupByCategory,
	normalizeCategory,
	STORE_CATEGORY_ORDER,
	UNCATEGORIZED_LABEL,
} from "./categories.ts";

/** Terse fixture: an item is just its category, so the assertions read as data. */
const item = (category: string | null | undefined) => ({ category });
const labelsOf = (sections: { label: string }[]) =>
	sections.map((s) => s.label);
const group = (categories: (string | null | undefined)[]) =>
	groupByCategory(categories.map(item), (i) => i.category);

describe("normalizeCategory", () => {
	test("folds case and separators onto the canonical label", () => {
		for (const raw of [
			"Developer Tools",
			"developer tools",
			"developer-tools",
			"DEVELOPER_TOOLS",
			"  Developer   Tools  ",
		]) {
			expect(normalizeCategory(raw)).toBe("Developer Tools");
		}
	});

	test("an ampersand shelf survives the separator fold", () => {
		// "Knowledge & Memory" keys to "knowledge memory" — the & is a separator, so
		// a manifest that wrote "knowledge-memory" must land on the same shelf and
		// not spawn a near-duplicate heading.
		expect(normalizeCategory("knowledge-memory")).toBe("Knowledge & Memory");
		expect(normalizeCategory("Knowledge and Memory")).not.toBe(
			"Knowledge & Memory"
		);
	});

	test("blank, whitespace and absent all mean uncategorised", () => {
		for (const raw of [undefined, null, "", "   "]) {
			expect(normalizeCategory(raw)).toBe(UNCATEGORIZED_LABEL);
		}
	});

	test("an unknown category is kept verbatim, not folded away", () => {
		// Degrade-don't-break: a satellite may ship a shelf this build predates.
		expect(normalizeCategory("Robotics")).toBe("Robotics");
		expect(normalizeCategory("  Robotics  ")).toBe("Robotics");
	});
});

describe("groupByCategory", () => {
	test("orders shelves editorially, not alphabetically", () => {
		// Fed in reverse-editorial order, so a stable sort or an alphabetical one
		// would both produce something other than the expected result.
		expect(labelsOf(group(["Security", "Automation", "Browsers"]))).toEqual([
			"Browsers",
			"Automation",
			"Security",
		]);
	});

	test("unknown shelves sort after every known one, alphabetically", () => {
		expect(labelsOf(group(["Zebras", "Search", "Robotics"]))).toEqual([
			"Search",
			"Robotics",
			"Zebras",
		]);
	});

	test("uncategorised is always last, even behind unknown shelves", () => {
		expect(labelsOf(group([null, "Robotics", "Browsers"]))).toEqual([
			"Browsers",
			"Robotics",
			UNCATEGORIZED_LABEL,
		]);
	});

	test("preserves input order within a shelf", () => {
		// The caller already ranked/paginated these; regrouping must not reshuffle.
		const items = [
			{ id: "c", category: "Search" },
			{ id: "a", category: "Browsers" },
			{ id: "b", category: "Search" },
		];
		const sections = groupByCategory(items, (i) => i.category);
		const search = sections.find((s) => s.label === "Search");
		expect(search?.items.map((i) => i.id)).toEqual(["c", "b"]);
	});

	test("variant spellings collapse into ONE shelf", () => {
		const sections = group(["Developer Tools", "developer-tools", "Search"]);
		expect(labelsOf(sections)).toEqual(["Search", "Developer Tools"]);
		expect(
			sections.find((s) => s.label === "Developer Tools")?.items
		).toHaveLength(2);
	});

	test("Interfaces is a known shelf right after Themes", () => {
		// Both ride in on ordinary plugins rather than a catalog kind, so the shelf
		// is how an interface plugin is findable; it must not sort as "unknown".
		expect(normalizeCategory("interfaces")).toBe("Interfaces");
		expect(
			labelsOf(group(["Media & Voice", "Interfaces", "Themes", "Robotics"]))
		).toEqual(["Themes", "Interfaces", "Media & Voice", "Robotics"]);
	});

	test("no items means no shelves (the caller renders its own empty state)", () => {
		expect(groupByCategory([], () => "Search")).toEqual([]);
	});

	test("every canonical shelf round-trips through grouping", () => {
		// Guards a typo in STORE_CATEGORY_ORDER itself: if a label did not survive
		// its own normalization, it would render as an "unknown" shelf sorted after
		// the known ones instead of in its editorial slot.
		expect(labelsOf(group([...STORE_CATEGORY_ORDER]))).toEqual([
			...STORE_CATEGORY_ORDER,
		]);
	});
});
