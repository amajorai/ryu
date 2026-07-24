// Unit tests for the pure output helpers (cli/output.ts): the column-table
// formatter, the ellipsis truncator, and the typed-lifecycle-error renderers. These
// are exercised indirectly by the dispatcher tests, but the boundary cases (ragged
// rows, the truncate ellipsis threshold, non-Error thrown values, the lifecycle
// shape defaults) live here so a regression names the exact helper.

import { expect, test } from "bun:test";
import {
	errorToJson,
	formatError,
	formatTable,
	truncate,
} from "../cli/output.ts";

// ── formatTable ───────────────────────────────────────────────────────────────

test("formatTable pads each column to its widest cell and trims trailing space", () => {
	const out = formatTable(
		["ID", "NAME"],
		[
			["a", "Alpha"],
			["bb", "B"],
		]
	);
	const lines = out.split("\n");
	expect(lines).toHaveLength(3);
	// Header: "ID" padded to width 2 (max of "ID"/"a"/"bb"), two spaces, "NAME".
	expect(lines[0]).toBe("ID  NAME");
	expect(lines[1]).toBe("a   Alpha");
	// Trailing padding on the last column is trimmed (no spaces after "B").
	expect(lines[2]).toBe("bb  B");
});

test("formatTable header width grows to fit a header wider than any cell", () => {
	const out = formatTable(["LONGHEADER", "X"], [["a", "b"]]);
	const [header, row] = out.split("\n");
	expect(header).toBe("LONGHEADER  X");
	// "a" padded to the 10-char header width, then the second column.
	expect(row).toBe("a           b");
});

test("formatTable handles a ragged row (missing cell treated as empty)", () => {
	// A row shorter than the header must not throw; the absent cell pads to width 0
	// and the trailing empty is trimmed away.
	const out = formatTable(["A", "B"], [["only"]]);
	const [header, row] = out.split("\n");
	expect(header).toBe("A     B");
	expect(row).toBe("only");
});

test("formatTable with no rows emits just the header line", () => {
	expect(formatTable(["A", "B"], [])).toBe("A  B");
});

// ── truncate ──────────────────────────────────────────────────────────────────

test("truncate leaves a string at or under the limit untouched", () => {
	expect(truncate("hello", 5)).toBe("hello");
	expect(truncate("hi", 10)).toBe("hi");
});

test("truncate replaces the overflow with an ellipsis, keeping max-1 chars + …", () => {
	// "abcdef" (len 6) at max 5 → first 4 chars + ellipsis = "abcd…" (len 5).
	const t = truncate("abcdef", 5);
	expect(t).toBe("abcd…");
	expect(t).toHaveLength(5);
});

test("truncate boundary: a string exactly at the limit is not truncated", () => {
	expect(truncate("abcde", 5)).toBe("abcde");
	// One over the limit triggers truncation.
	expect(truncate("abcdef", 5).endsWith("…")).toBe(true);
});

// ── formatError ─────────────────────────────────────────────────────────────

test("formatError returns a plain Error's message", () => {
	expect(formatError(new Error("boom"))).toBe("boom");
});

test("formatError stringifies a non-Error thrown value", () => {
	expect(formatError("just a string")).toBe("just a string");
	expect(formatError(42)).toBe("42");
	expect(formatError(null)).toBe("null");
});

test("formatError appends a lifecycle hint in parentheses when present", () => {
	const err = Object.assign(new Error("Cannot disable Meetings."), {
		gatewayUnreachable: false,
		hint: "pass --cascade",
	});
	expect(formatError(err)).toBe("Cannot disable Meetings. (pass --cascade)");
});

test("formatError omits the parenthetical when a lifecycle error has no hint", () => {
	const err = Object.assign(new Error("Blocked."), {
		grantsDenied: true,
	});
	expect(formatError(err)).toBe("Blocked.");
});

// ── errorToJson ─────────────────────────────────────────────────────────────

test("errorToJson emits a flat {error} for a plain Error", () => {
	expect(errorToJson(new Error("nope"))).toEqual({ error: "nope" });
});

test("errorToJson stringifies a non-Error into {error}", () => {
	expect(errorToJson("raw")).toEqual({ error: "raw" });
});

test("errorToJson expands the full lifecycle shape with defaults", () => {
	const err = Object.assign(new Error("dep block"), {
		dependencyError: {
			code: "blocked_by_dependents",
			plugin: "whiteboard",
			dependents: ["meetings"],
		},
		hint: "pass --cascade",
	});
	// Only dependencyError + hint were set; the three booleans default.
	expect(errorToJson(err)).toEqual({
		error: "dep block",
		dependencyError: {
			code: "blocked_by_dependents",
			plugin: "whiteboard",
			dependents: ["meetings"],
		},
		gatewayUnreachable: false,
		grantsDenied: false,
		builtIn: false,
		hint: "pass --cascade",
	});
});

test("errorToJson defaults a lifecycle error's optional fields to null/false", () => {
	// The `builtIn` marker alone is enough to trigger the lifecycle branch; every
	// other field must fill its documented default rather than leak `undefined`.
	const err = Object.assign(new Error("built-in"), { builtIn: true });
	const json = errorToJson(err);
	expect(json.error).toBe("built-in");
	expect(json.builtIn).toBe(true);
	expect(json.dependencyError).toBeNull();
	expect(json.gatewayUnreachable).toBe(false);
	expect(json.grantsDenied).toBe(false);
	expect(json.hint).toBeNull();
});
