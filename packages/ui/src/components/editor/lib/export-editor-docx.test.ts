import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { strFromU8, unzipSync } from "fflate";
import type { Value } from "platejs";
import {
	exportEditorDocx,
	serializeEditorDocxHtml,
} from "./export-editor-docx.ts";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const fixture: Value = [
	{ type: "h1", id: "one", children: [{ text: "First heading" }] },
	{ type: "h2", id: "two", children: [{ text: "Second heading" }] },
	{ type: "h3", id: "three", children: [{ text: "Third heading" }] },
	{ type: "toc", children: [{ text: "" }] },
	{
		type: "code_block",
		lang: "plaintext",
		children: [
			{
				type: "code_line",
				children: [
					{ text: "  keyword", className: "hljs-keyword", code_syntax: true },
					{ text: " italic", className: "hljs-emphasis", code_syntax: true },
					{ text: " strong", className: "hljs-strong", code_syntax: true },
				],
			},
		],
	},
	{
		type: "column_group",
		children: [
			{
				type: "column",
				width: "35%",
				children: [{ type: "p", children: [{ text: "Left column" }] }],
			},
			{
				type: "column",
				width: 200,
				children: [{ type: "p", children: [{ text: "Right column" }] }],
			},
		],
	},
];

test("Plate and juice retain concrete syntax, column widths, and TOC depth", async () => {
	const html = await serializeEditorDocxHtml(fixture);
	const document = new DOMParser().parseFromString(html, "text/html");
	const cells = document.querySelectorAll<HTMLTableCellElement>(
		'td[data-slate-type="column"]'
	);
	expect(Array.from(cells, (cell) => cell.style.width)).toEqual([
		"35%",
		"200px",
	]);
	const toc = document.querySelectorAll<HTMLParagraphElement>(
		'[data-docx-style="editortocNodeStatic2"]'
	);
	expect(Array.from(toc, (item) => item.style.marginLeft)).toEqual([
		"0px",
		"24pt",
		"48pt",
	]);
	const syntax = document.querySelector<HTMLElement>(
		'[data-docx-style="editorcodeBlockNodeStatic3"]'
	);
	if (!syntax) {
		throw new Error("DOCX syntax renderer did not serialize the code leaf");
	}
	expect(syntax.textContent).toBe("\u00a0\u00a0keyword");
	expect(["#d73a49", "rgb(215, 58, 73)"]).toContain(syntax.style.color);
	for (const element of document.querySelectorAll<HTMLElement>("[style]")) {
		for (const property of Array.from(element.style)) {
			if (!property.startsWith("--")) {
				expect(element.style.getPropertyValue(property)).not.toContain("var(");
			}
		}
	}
});

test("native Word conversion retains formatting and layout fields", async () => {
	const blob = await exportEditorDocx(fixture);
	const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
	expect(entries["word/document.xml"]).toBeDefined();
	const xml = strFromU8(entries["word/document.xml"]!);
	expect(xml).toContain('w:color w:val="d73a49"');
	expect(xml).toContain('w:ascii="Courier New"');
	const document = new DOMParser().parseFromString(xml, "application/xml");
	const runs = Array.from(document.getElementsByTagName("w:r"));
	const italic = runs.find((run) => run.textContent.includes("italic"));
	const strong = runs.find((run) => run.textContent.includes("strong"));
	expect(italic?.getElementsByTagName("w:i").length).toBe(1);
	expect(strong?.getElementsByTagName("w:b").length).toBe(1);
	expect(xml).toContain('w:tcW w:w="1750" w:type="pct"');
	expect(xml).toContain('w:tcW w:w="3000" w:type="dxa"');
	expect(xml).toContain('w:ind w:left="480"');
	expect(xml).toContain('w:ind w:left="960"');
	expect(xml).toContain('w:anchor="three"');
});
