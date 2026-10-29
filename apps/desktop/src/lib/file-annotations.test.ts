import { describe, expect, test } from "bun:test";
import {
	appendToComposerValue,
	CHAT_COMPOSER_INSERT_EVENT,
	countLines,
	decodeViewerText,
	excerptLines,
	FILE_ANNOTATION_MAX_EXCERPT_LINES,
	FILE_VIEWER_MAX_CHARS,
	type FileAnnotationNote,
	formatFileAnnotationsForChat,
	formatLineLabel,
	normalizeLineRange,
	requestChatComposerInsert,
} from "./file-annotations.ts";

const note = (overrides: Partial<FileAnnotationNote>): FileAnnotationNote => ({
	comment: "",
	endLine: 1,
	excerpt: "",
	id: "note",
	startLine: 1,
	...overrides,
});

describe("normalizeLineRange", () => {
	test("orders a bottom-up drag and clamps it to the file", () => {
		expect(normalizeLineRange({ start: 9, end: 3 }, 5)).toEqual({
			startLine: 3,
			endLine: 5,
		});
	});

	test("keeps a selection past the end of the file ordered", () => {
		expect(normalizeLineRange({ start: 12, end: 14 }, 10)).toEqual({
			startLine: 10,
			endLine: 10,
		});
	});

	test("rejects an empty selection or file", () => {
		expect(normalizeLineRange(null, 10)).toBeNull();
		expect(normalizeLineRange({ start: 1, end: 1 }, 0)).toBeNull();
		expect(normalizeLineRange({ start: 0, end: 0 }, 10)).toBeNull();
	});
});

describe("decodeViewerText", () => {
	const encode = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

	test("decodes UTF-8 text", () => {
		const bytes = [...new TextEncoder().encode("héllo → world")];
		expect(decodeViewerText(encode(bytes))).toEqual({
			kind: "text",
			text: "héllo → world",
		});
	});

	test("rejects NUL bytes and invalid UTF-8 as binary", () => {
		expect(decodeViewerText(encode([0x50, 0x4b, 0x00, 0x03]))).toEqual({
			kind: "binary",
		});
		expect(decodeViewerText(encode([0xff, 0xfe, 0x41]))).toEqual({
			kind: "binary",
		});
	});

	test("refuses text past the viewer limit", () => {
		const large = btoa("a".repeat(FILE_VIEWER_MAX_CHARS + 1));
		expect(decodeViewerText(large)).toEqual({ kind: "too-large" });
	});
});

test("countLines matches the viewer's numbering of a trailing newline", () => {
	expect(countLines("")).toBe(0);
	expect(countLines("a")).toBe(1);
	expect(countLines("a\nb")).toBe(2);
	expect(countLines("a\nb\n")).toBe(3);
});

describe("excerptLines", () => {
	test("returns the inclusive range", () => {
		expect(
			excerptLines("one\ntwo\nthree\nfour", { startLine: 2, endLine: 3 })
		).toBe("two\nthree");
	});

	test("caps long selections and reports what was omitted", () => {
		const total = FILE_ANNOTATION_MAX_EXCERPT_LINES + 3;
		const contents = Array.from({ length: total }, (_, i) => `l${i + 1}`).join(
			"\n"
		);
		const excerpt = excerptLines(contents, { startLine: 1, endLine: total });
		expect(excerpt.split("\n")).toHaveLength(
			FILE_ANNOTATION_MAX_EXCERPT_LINES + 1
		);
		expect(excerpt.endsWith("… 3 more lines")).toBe(true);
	});
});

test("formatLineLabel distinguishes one line from a range", () => {
	expect(formatLineLabel({ startLine: 4, endLine: 4 })).toBe("line 4");
	expect(formatLineLabel({ startLine: 4, endLine: 9 })).toBe("lines 4–9");
});

describe("formatFileAnnotationsForChat", () => {
	test("quotes a single note with its language and comment", () => {
		expect(
			formatFileAnnotationsForChat("src/app.ts", [
				note({
					comment: "  Why is this async?  ",
					endLine: 12,
					excerpt: "async function main() {}",
					startLine: 10,
				}),
			])
		).toBe(
			"`src/app.ts` lines 10–12:\n```ts\nasync function main() {}\n```\nWhy is this async?"
		);
	});

	test("numbers several notes in file order", () => {
		const text = formatFileAnnotationsForChat("README", [
			note({ id: "b", startLine: 8, endLine: 8, excerpt: "later" }),
			note({
				id: "a",
				startLine: 2,
				endLine: 2,
				excerpt: "earlier",
				comment: "fix",
			}),
		]);
		expect(text.startsWith("Notes on `README` (2 selections):\n\n")).toBe(true);
		expect(text.indexOf("1. `README` line 2:")).toBeLessThan(
			text.indexOf("2. `README` line 8:")
		);
		// No extension, so the fence is untagged; an empty comment adds no line.
		expect(text).toContain("```\nlater\n```");
		expect(text.endsWith("```\nlater\n```")).toBe(true);
	});

	test("lengthens the fence past backtick runs in the excerpt", () => {
		const text = formatFileAnnotationsForChat("doc.md", [
			note({ excerpt: "````js\ncode\n````" }),
		]);
		expect(text).toContain("`````md\n````js\ncode\n````\n`````");
	});
});

test("appendToComposerValue keeps the existing draft above the quote", () => {
	expect(appendToComposerValue("", "quote")).toBe("quote\n\n");
	expect(appendToComposerValue("Look at this:  \n", "quote")).toBe(
		"Look at this:\n\nquote\n\n"
	);
});

test("requestChatComposerInsert reports whether a composer accepted it", () => {
	expect(requestChatComposerInsert("nobody listening")).toBe(false);
	let received = "";
	const accept = (event: Event) => {
		received = (event as CustomEvent<{ text: string }>).detail.text;
		event.preventDefault();
	};
	globalThis.addEventListener(CHAT_COMPOSER_INSERT_EVENT, accept);
	try {
		expect(requestChatComposerInsert("hello")).toBe(true);
		expect(received).toBe("hello");
	} finally {
		globalThis.removeEventListener(CHAT_COMPOSER_INSERT_EVENT, accept);
	}
});
