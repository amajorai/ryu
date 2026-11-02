import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Value } from "platejs";
import {
	alignRightToLeftBlocksForWord,
	firstStrongDirection,
} from "./export-docx-direction.ts";
import { serializeEditorDocxHtml } from "./export-editor-docx.ts";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

test("first strong character decides the direction", () => {
	expect(firstStrongDirection("12. مرحبا world")).toBe("rtl");
	expect(firstStrongDirection("« שלום »")).toBe("rtl");
	expect(firstStrongDirection("Mixed English and عربي")).toBe("ltr");
	expect(firstStrongDirection("日本語のテキスト")).toBe("ltr");
	expect(firstStrongDirection("123 — 456")).toBeNull();
});

test("right-to-left blocks are right-aligned for Word, others untouched", () => {
	const root = document.createElement("div");
	root.innerHTML = [
		'<p dir="auto">مرحبا</p>',
		'<p dir="auto">Hello</p>',
		'<p dir="rtl">Declared</p>',
		'<p dir="auto" style="text-align: center">مرحبا</p>',
		'<table><tr><td dir="auto" style="text-align: left">خلية</td></tr></table>',
		"<pre><code><p>مرحبا</p></code></pre>",
	].join("");
	alignRightToLeftBlocksForWord(root);
	const aligns = Array.from(
		root.querySelectorAll<HTMLElement>("p, td"),
		(block) => block.style.getPropertyValue("text-align")
	);
	expect(aligns).toEqual(["right", "", "right", "center", "right", ""]);
});

test("Word export HTML right-aligns Arabic blocks and leaves English ones", async () => {
	const value: Value = [
		{ type: "h1", children: [{ text: "عنوان" }] },
		{ type: "p", children: [{ text: "English paragraph" }] },
	];
	const parsed = new DOMParser().parseFromString(
		await serializeEditorDocxHtml(value),
		"text/html"
	);
	expect(parsed.querySelector<HTMLElement>("h1")?.style.textAlign).toBe(
		"right"
	);
	expect(
		parsed.querySelector<HTMLElement>('[data-slate-type="p"]')?.style
			.textAlign ?? ""
	).toBe("");
});
