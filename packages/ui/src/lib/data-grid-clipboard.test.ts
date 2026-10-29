import { expect, test } from "bun:test";
import { parseTsv } from "./data-grid.ts";
import {
	clipboardFileEntriesSchema,
	clipboardStringListSchema,
	clipboardTextValueSchema,
	describeClipboardTextValue,
	isCutOnClipboard,
} from "./data-grid-clipboard.ts";
import { serializeTsv, transposeMatrix } from "./data-grid-fill.ts";

test("multi-select clipboard arrays retain all string entries without coercion", () => {
	expect(
		clipboardStringListSchema.parse([
			"Alpha",
			null,
			12,
			false,
			{ label: "Beta" },
			["Gamma"],
			"",
			"Delta",
			Number.POSITIVE_INFINITY,
		])
	).toEqual(["Alpha", "", "Delta"]);
	for (const value of [null, {}, "Alpha", 12]) {
		expect(clipboardStringListSchema.safeParse(value).success).toBe(false);
	}
});

test("file clipboard entries preserve complete valid objects and invalid positions", () => {
	const file = {
		id: "file",
		name: "notes",
		size: 12,
		type: "text/plain",
		url: "https://example.com/notes",
		future: { key: "retained" },
	};
	const parsed = clipboardFileEntriesSchema.parse([
		file,
		{ id: "partial" },
		null,
		{ ...file, size: "12" },
	]);
	expect(parsed.length).toBe(4);
	expect(parsed[0]).toBe(file);
	expect(parsed.slice(1)).toEqual([undefined, undefined, undefined]);
	expect(clipboardFileEntriesSchema.parse([])).toEqual([]);
	expect(clipboardFileEntriesSchema.safeParse({ file }).success).toBe(false);
});

test("structured clipboard text retains the existing list and checkbox presentation", () => {
	const file = { id: "file", name: "notes", size: 12, type: "text/plain" };
	for (const [value, expected] of [
		[true, "Checked"],
		[false, "Unchecked"],
		[[], ""],
		[["Alpha", "Beta"], "Alpha, Beta"],
		[[file], "notes"],
	] satisfies [boolean | string[] | (typeof file)[], string][]) {
		expect(
			describeClipboardTextValue(clipboardTextValueSchema.parse(value))
		).toBe(expected);
	}
});

test("other JSON keeps its literal text instead of pretending to be a typed list", () => {
	for (const value of [null, {}, 12, ["Alpha", false], [{ id: "partial" }]]) {
		expect(clipboardTextValueSchema.safeParse(value).success).toBe(false);
	}
});

test("a cut stays current while the raw clipboard holds its TSV, including a transposed paste", () => {
	const cutText = "a\tb\tc";
	expect(isCutOnClipboard(cutText, "a\tb\tc")).toBe(true);
	// Clipboards may rewrite line endings between write and read.
	expect(isCutOnClipboard("a\tb\nc\td", "a\tb\r\nc\td")).toBe(true);

	// "Paste transposed" pastes a transform of the clipboard, which no longer
	// equals the cut TSV; that is why the paste passes the raw text it read.
	const transposed = serializeTsv(transposeMatrix(parseTsv(cutText, 3)));
	expect(transposed).toBe("a\nb\nc");
	expect(isCutOnClipboard(cutText, transposed)).toBe(false);
});

test("a cut superseded by other clipboard content, or no cut, does not move cells", () => {
	expect(isCutOnClipboard("a\tb\tc", "something else")).toBe(false);
	expect(isCutOnClipboard(null, "a\tb\tc")).toBe(false);
});
