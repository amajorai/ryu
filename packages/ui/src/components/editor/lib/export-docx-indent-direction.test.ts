import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { strFromU8, unzipSync } from "fflate";
import type { Value } from "platejs";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../i18n/src/active-locale.ts";
import docxStyles from "../docx-nodes.css?raw";
import {
	exportEditorDocx,
	serializeEditorDocxHtml,
} from "./export-editor-docx.ts";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const arabic = {
	direction: "rtl" as const,
	locale: "ar",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(fallback ?? id, values, "ar");
	},
};

let mounted = false;
afterEach(() => {
	if (mounted) {
		unregisterActiveI18nRuntime(arabic);
		mounted = false;
	}
});

function useArabic(): void {
	registerActiveI18nRuntime(arabic);
	mounted = true;
}

const nestedList: Value = [
	{ type: "p", listStyleType: "decimal", indent: 1, children: [{ text: "أ" }] },
	{ type: "p", listStyleType: "decimal", indent: 2, children: [{ text: "ب" }] },
];

const tableOfContents: Value = [
	{ type: "h1", id: "one", children: [{ text: "First" }] },
	{ type: "h2", id: "two", children: [{ text: "Second" }] },
	{ type: "toc", children: [{ text: "" }] },
];

async function inlineIndent(
	value: Value,
	style: string
): Promise<{ left: string; right: string }[]> {
	const html = await serializeEditorDocxHtml(value);
	const document = new DOMParser().parseFromString(html, "text/html");
	return Array.from(
		document.querySelectorAll<HTMLElement>(`[data-docx-style="${style}"]`),
		(element) => ({
			left: element.style.getPropertyValue("margin-left"),
			right: element.style.getPropertyValue("margin-right"),
		})
	);
}

async function wordXml(value: Value): Promise<string> {
	const blob = await exportEditorDocx(value);
	const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
	return strFromU8(entries["word/document.xml"] ?? new Uint8Array());
}

function listLevels(xml: string): string[] {
	return Array.from(
		xml.matchAll(/<w:ilvl w:val="(\d+)"\/>/g),
		(m) => m[1] ?? ""
	);
}

test("Word keeps nested list levels in a left-to-right export", async () => {
	expect(listLevels(await wordXml(nestedList))).toEqual(["0", "1"]);
});

test("Word keeps nested list levels in an Arabic export", async () => {
	useArabic();
	// The DOCX converter derives the level from margin-left in either direction.
	expect(
		(await inlineIndent(nestedList, "editorblockListStatic1")).at(-1)?.left
	).toBe("48px");
	expect(listLevels(await wordXml(nestedList))).toEqual(["0", "1"]);
});

test("TOC entries indent from the left in a left-to-right export", async () => {
	const entries = await inlineIndent(tableOfContents, "editortocNodeStatic2");
	expect(entries.at(-1)).toEqual({ left: "24pt", right: "0px" });
	expect(await wordXml(tableOfContents)).toContain('w:ind w:left="480"');
});

test("TOC entries indent from the right in an Arabic export", async () => {
	useArabic();
	const entries = await inlineIndent(tableOfContents, "editortocNodeStatic2");
	expect(entries.at(-1)).toEqual({ left: "0px", right: "24pt" });
	const xml = await wordXml(tableOfContents);
	expect(xml).toContain('w:right="480"');
	expect(xml).not.toContain('w:ind w:left="480"');
});

test("browsers indent static lists and TOC entries from the inline start", () => {
	// juice skips @media, so this block reaches browsers only and overrides the
	// physical Word-facing rules above it at any nesting depth.
	const browserOnly = docxStyles.slice(docxStyles.indexOf("@media all"));
	expect(browserOnly).toContain(
		"margin-inline: var(--editorblockListStatic1-margin-left) 0;"
	);
	expect(browserOnly).toContain(
		"margin-inline: var(--editortocNodeStatic2-margin-left) 0;"
	);
	expect(docxStyles).toContain(
		"padding-inline-start: var(--editortableNodeStatic1-padding-left);"
	);
});
