import { describe, expect, test } from "bun:test";
import {
	baseMime,
	dataUrlByteSize,
	extensionForMime,
	FALLBACK_DOWNLOAD_NAME,
	fileExtension,
	filePreviewKind,
	fileTypeBadge,
	isTextLikeFile,
	MAX_DOWNLOAD_NAME_LENGTH,
	previewImageMime,
	safeDownloadName,
} from "./file-card-logic.ts";

describe("safeDownloadName", () => {
	test("keeps an ordinary name", () => {
		expect(safeDownloadName("Q3 deck.pptx")).toBe("Q3 deck.pptx");
	});

	test.each([
		["../../etc/passwd", "passwd"],
		["..\\..\\Windows\\System32\\drivers\\etc\\hosts", "hosts"],
		["C:\\Users\\dana\\Startup\\run.bat", "run.bat"],
		["/absolute/path/report.pdf", "report.pdf"],
		["folder/sub/../report.pdf", "report.pdf"],
		["\\\\server\\share\\report.pdf", "report.pdf"],
	])("drops every folder part of %s", (input, expected) => {
		expect(safeDownloadName(input)).toBe(expected);
	});

	test("never returns a path separator, a drive colon or a parent segment", () => {
		for (const input of [
			"../..",
			"..",
			"a/..",
			"C:",
			"C:report.pdf",
			"..\\..",
			"./.ssh/authorized_keys",
			"a\u0000/../b",
		]) {
			const safe = safeDownloadName(input);
			expect(safe).not.toMatch(/[\\/:]/u);
			expect(safe).not.toBe("..");
			expect(safe.startsWith(".")).toBe(false);
			expect(safe.length).toBeGreaterThan(0);
		}
	});

	test("falls back when nothing is left", () => {
		expect(safeDownloadName("")).toBe(FALLBACK_DOWNLOAD_NAME);
		expect(safeDownloadName(null)).toBe(FALLBACK_DOWNLOAD_NAME);
		expect(safeDownloadName("../")).toBe(FALLBACK_DOWNLOAD_NAME);
		expect(safeDownloadName(" . . ")).toBe(FALLBACK_DOWNLOAD_NAME);
	});

	test("removes hidden-file dots, trailing dots and spaces", () => {
		expect(safeDownloadName(".bashrc")).toBe("bashrc");
		expect(safeDownloadName("report.pdf. . ")).toBe("report.pdf");
	});

	test("removes control characters and bidi overrides", () => {
		expect(safeDownloadName("re\u0000po\nrt.pdf")).toBe("report.pdf");
		// A right-to-left override would show "invoice-fdp.exe" as "invoice-exe.pdf".
		expect(safeDownloadName("invoice-\u202Efdp.exe")).toBe("invoice-fdp.exe");
	});

	test("removes characters Windows refuses", () => {
		expect(safeDownloadName('a<b>c"d|e?f*g.txt')).toBe("abcdefg.txt");
	});

	test.each([
		"CON",
		"nul",
		"COM1",
		"LPT9",
		"aux.txt",
		"PRN.pdf",
	])("prefixes the Windows device name %s", (input) => {
		expect(safeDownloadName(input)).toBe(`_${input}`);
	});

	// COM and LPT with a superscript one, two or three, and the console names.
	test.each([
		"COM\u00B9",
		"com\u00B2.txt",
		"LPT\u00B3",
		"lpt\u00B9.log",
		"CONIN$",
		"conout$.txt",
	])("prefixes the Windows device name %s too", (input) => {
		expect(safeDownloadName(input)).toBe(`_${input}`);
	});

	test("leaves names that only start like a device name", () => {
		expect(safeDownloadName("COM\u00B9 report.txt")).toBe(
			"COM\u00B9 report.txt"
		);
		expect(safeDownloadName("console.txt")).toBe("console.txt");
		expect(safeDownloadName("CONIN.txt")).toBe("CONIN.txt");
	});

	test.each([
		["zero width space", "\u200B"],
		["zero width non-joiner", "\u200C"],
		["zero width joiner", "\u200D"],
		["left-to-right mark", "\u200E"],
		["right-to-left mark", "\u200F"],
		["word joiner", "\u2060"],
		["function application", "\u2061"],
		["invisible times", "\u2062"],
		["invisible separator", "\u2063"],
		["invisible plus", "\u2064"],
		["Arabic letter mark", "\u061C"],
		["soft hyphen", "\u00AD"],
		["byte order mark", "\uFEFF"],
		["Braille blank", "\u2800"],
		["Hangul filler", "\u3164"],
		["Hangul first filler", "\u115F"],
		["Hangul second filler", "\u1160"],
		["half-width Hangul filler", "\uFFA0"],
	])("removes the invisible %s", (_label, invisible) => {
		// Forty of them would push ".exe" out of sight in a save dialog.
		const padded = `invoice.pdf${invisible.repeat(40)}.e${invisible}xe`;
		expect(safeDownloadName(padded)).toBe("invoice.pdf.exe");
	});

	test("an invisible character cannot hide a device name or a hidden file", () => {
		expect(safeDownloadName("C\u200BON.txt")).toBe("_CON.txt");
		expect(safeDownloadName("\u200B.bashrc")).toBe("bashrc");
	});

	test("a name of invisible characters only falls back", () => {
		expect(safeDownloadName("\u200B\u3164\u2800")).toBe(FALLBACK_DOWNLOAD_NAME);
	});

	test("a type that is the name of an object member adds no ending", () => {
		for (const type of ["constructor", "__proto__", "toString"]) {
			expect(extensionForMime(type)).toBe("");
			expect(safeDownloadName("report", type)).toBe("report");
			expect(fileTypeBadge("report", type)).toBeNull();
		}
	});

	test("adds the extension of the type when the name has none", () => {
		expect(safeDownloadName("report", "application/pdf")).toBe("report.pdf");
		expect(safeDownloadName("", "text/csv; charset=utf-8")).toBe(
			`${FALLBACK_DOWNLOAD_NAME}.csv`
		);
		// A name that has an extension keeps it, whatever the type says.
		expect(safeDownloadName("report.docx", "application/pdf")).toBe(
			"report.docx"
		);
	});

	test("cuts a long name and keeps its extension", () => {
		const safe = safeDownloadName(`${"a".repeat(400)}.pdf`);
		expect(safe.length).toBe(MAX_DOWNLOAD_NAME_LENGTH);
		expect(safe.endsWith(".pdf")).toBe(true);
	});

	test("the cut never splits a character in two", () => {
		// The stem ends at code unit 116. With one "a" in front, the emoji at
		// units 115 and 116 would be cut between its two halves.
		const safe = safeDownloadName(`a${"\u{1F4C4}".repeat(80)}.pdf`);
		expect(safe.length).toBeLessThanOrEqual(MAX_DOWNLOAD_NAME_LENGTH);
		expect(safe.endsWith(".pdf")).toBe(true);
		expect(safe).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
		expect(safe).toBe(`a${"\u{1F4C4}".repeat(57)}.pdf`);
	});
});

describe("type and preview rules", () => {
	test("baseMime drops parameters and case", () => {
		expect(baseMime("Text/CSV; charset=utf-8")).toBe("text/csv");
		expect(baseMime(undefined)).toBe("");
	});

	test("fileExtension reads the last extension only", () => {
		expect(fileExtension("archive.tar.GZ")).toBe("gz");
		expect(fileExtension("README")).toBe("");
		expect(fileExtension(null)).toBe("");
	});

	test("extensionForMime knows the office types", () => {
		expect(
			extensionForMime(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
			)
		).toBe("docx");
		expect(extensionForMime("application/x-unknown")).toBe("");
	});

	test("the badge is the upper-case extension, from the name first", () => {
		expect(fileTypeBadge("Q3 deck.pptx", "application/pdf")).toBe("PPTX");
		expect(fileTypeBadge("report", "application/pdf")).toBe("PDF");
		expect(fileTypeBadge("report", "application/x-unknown")).toBeNull();
		expect(fileTypeBadge(undefined)).toBeNull();
	});

	test("only raster images and PDF preview inline", () => {
		expect(filePreviewKind("a.bin", "application/pdf")).toBe("pdf");
		expect(filePreviewKind("a.pdf")).toBe("pdf");
		expect(filePreviewKind("chart", "image/png")).toBe("image");
		expect(filePreviewKind("photo.JPG")).toBe("image");
		// Formats that can carry script, and office files, never preview here.
		expect(filePreviewKind("logo.svg", "image/svg+xml")).toBeNull();
		expect(filePreviewKind("page.html", "text/html")).toBeNull();
		expect(
			filePreviewKind(
				"deck.pptx",
				"application/vnd.openxmlformats-officedocument.presentationml.presentation"
			)
		).toBeNull();
		// The declared type wins over the extension.
		expect(filePreviewKind("fake.png", "text/html")).toBeNull();
	});

	test("an image preview is decoded as the card's own raster type", () => {
		expect(previewImageMime("chart", "image/png")).toBe("image/png");
		expect(previewImageMime("chart.png", "Image/WebP; q=1")).toBe("image/webp");
		// Without a type the ending of the name decides.
		expect(previewImageMime("photo.JPG")).toBe("image/jpeg");
		expect(previewImageMime("scan.avif", "")).toBe("image/avif");
		// Never a type that can carry script, and never a member of an object.
		expect(previewImageMime("logo.svg", "image/svg+xml")).toBe("");
		expect(previewImageMime("fake.png", "text/html")).toBe("");
		expect(previewImageMime("report.pdf")).toBe("");
		expect(previewImageMime("a.valueof")).toBe("");
		for (const name of [
			"a.png",
			"a.jpg",
			"a.jpeg",
			"a.gif",
			"a.webp",
			"a.bmp",
		]) {
			expect(filePreviewKind(name)).toBe("image");
			expect(previewImageMime(name).startsWith("image/")).toBe(true);
		}
	});

	test("isTextLikeFile follows the type, then the extension", () => {
		expect(isTextLikeFile("a.bin", "text/plain")).toBe(true);
		expect(isTextLikeFile("a", "application/json")).toBe(true);
		expect(isTextLikeFile("notes.md")).toBe(true);
		expect(isTextLikeFile("a.txt", "application/pdf")).toBe(false);
		expect(isTextLikeFile("deck.pptx")).toBe(false);
	});
});

describe("dataUrlByteSize", () => {
	test("counts the decoded bytes of a base64 payload", () => {
		// "hello" is 5 bytes, "aGVsbG8=" in base64.
		expect(dataUrlByteSize("data:text/plain;base64,aGVsbG8=")).toBe(5);
		expect(dataUrlByteSize("data:application/pdf;base64,AAAA")).toBe(3);
		expect(dataUrlByteSize("data:application/pdf;base64,")).toBe(0);
	});

	test("counts a percent-encoded payload", () => {
		expect(dataUrlByteSize("data:text/plain,a%20b")).toBe(3);
	});

	test("is undefined for other URLs and broken data URLs", () => {
		expect(dataUrlByteSize("https://example.com/a.pdf")).toBeUndefined();
		expect(dataUrlByteSize("data:text/plain")).toBeUndefined();
		expect(dataUrlByteSize("data:text/plain,%E0%A4%A")).toBeUndefined();
	});
});
