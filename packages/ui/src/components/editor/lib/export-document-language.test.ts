import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { Value } from "platejs";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../i18n/src/active-locale.ts";
import { serializeEditorDocxHtml } from "./export-editor-docx.ts";
import { buildStandaloneEditorHtml } from "./standalone-editor-html.ts";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const arabic = {
	direction: "rtl" as const,
	locale: "ar",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		const message =
			fallback === "Ryu document" ? "مستند Ryu" : (fallback ?? id);
		return formatMessage(message, values, "ar");
	},
};

let mounted = false;
afterEach(() => {
	if (mounted) {
		unregisterActiveI18nRuntime(arabic);
		mounted = false;
	}
});

function parse(html: string): Document {
	return new DOMParser().parseFromString(html, "text/html");
}

const editorHtml =
	'<div class="slate-editor"><h1>Title</h1><p>مرحبا</p><p dir="ltr">Kept</p><pre><code>x</code></pre></div>';

test("standalone HTML keeps English lang and direction without a provider", () => {
	const document = parse(buildStandaloneEditorHtml(editorHtml));
	expect(document.documentElement.getAttribute("lang")).toBe("en");
	expect(document.documentElement.getAttribute("dir")).toBe("ltr");
	expect(document.title).toBe("Ryu document");
});

test("standalone HTML declares the UI language, direction and per-block auto", () => {
	registerActiveI18nRuntime(arabic);
	mounted = true;
	const document = parse(buildStandaloneEditorHtml(editorHtml));
	expect(document.documentElement.getAttribute("lang")).toBe("ar");
	expect(document.documentElement.getAttribute("dir")).toBe("rtl");
	expect(document.title).toBe("مستند Ryu");
	const blocks = Array.from(document.querySelectorAll("h1, p"), (block) =>
		block.getAttribute("dir")
	);
	expect(blocks).toEqual(["auto", "auto", "ltr"]);
	expect(document.querySelector("pre")?.hasAttribute("dir")).toBe(false);
});

test("standalone HTML titles the export with the document name", () => {
	const html = buildStandaloneEditorHtml(editorHtml, document, {
		title: 'Q3 <plan> & "notes"',
	});
	expect(parse(html).title).toBe('Q3 <plan> & "notes"');
	expect(html).toContain(
		"<title>Q3 &lt;plan&gt; &amp; &quot;notes&quot;</title>"
	);
});

test("Word export HTML declares the UI language and per-block auto", async () => {
	registerActiveI18nRuntime(arabic);
	mounted = true;
	const value: Value = [
		{ type: "h1", children: [{ text: "عنوان" }] },
		{ type: "p", children: [{ text: "Mixed English and عربي" }] },
	];
	const document = parse(await serializeEditorDocxHtml(value));
	expect(document.documentElement.getAttribute("lang")).toBe("ar");
	expect(document.documentElement.getAttribute("dir")).toBe("rtl");
	const blocks = Array.from(
		document.querySelectorAll('h1, [data-slate-type="p"]')
	);
	expect(blocks.length).toBe(2);
	for (const block of blocks) {
		expect(block.getAttribute("dir")).toBe("auto");
	}
});
