// Right-to-left layout guards for the chat transcript, composer and Settings
// navigation. These surfaces must use logical utilities (`ps-*`, `border-s`,
// `text-start`, `end-*`) so an Arabic or Hebrew reply puts list markers, quote
// bars and the composer's corner control on the correct side, and their
// directional arrows must mirror.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BIDI_AUTO, bidiAutoFor, withBidiAuto } from "./bidi-text.ts";
import { MARKDOWN_COMPONENTS } from "./markdown-renderers.tsx";
import { UserMessageEditor } from "./user-message-editor.tsx";

const here = (path: string) => new URL(path, import.meta.url);
const source = (path: string) => readFileSync(here(path), "utf8");

function renderMarkdownElement(tag: string, text = "item"): string {
	const component = MARKDOWN_COMPONENTS[
		tag as keyof typeof MARKDOWN_COMPONENTS
	] as FunctionComponent<{ children?: ReactNode }>;
	return renderToStaticMarkup(createElement(component, null, text));
}

/** Physical direction utilities inside a class string, ignoring centering. */
const PHYSICAL_UTILITY =
	/(?:^|[\s"'`:])-?(?:ml|mr|pl|pr|left|right|border-l|border-r|text-left|text-right|rounded-(?:l|r|tl|tr|bl|br))-(?!1\/2)[\w.[\]/-]+/u;

function physicalUtilities(path: string): string[] {
	const found: string[] = [];
	for (const line of source(path).split("\n")) {
		const trimmed = line.trim();
		if (/^(?:\/\/|\/\*|\*)/u.test(trimmed)) {
			continue;
		}
		const match = PHYSICAL_UTILITY.exec(line);
		if (match) {
			found.push(match[0].trim());
		}
	}
	return found;
}

describe("chat markdown", () => {
	test("lists pad the inline start, where the markers sit", () => {
		expect(renderMarkdownElement("ul")).toContain("ps-4");
		expect(renderMarkdownElement("ol")).toContain("ps-5");
		expect(renderMarkdownElement("li")).toContain("ps-0.5");
		for (const tag of ["ul", "ol", "li"]) {
			expect(renderMarkdownElement(tag)).not.toMatch(/\bpl-/u);
		}
	});

	test("a blockquote draws its bar on the inline start", () => {
		const markup = renderMarkdownElement("blockquote");
		expect(markup).toContain("border-s-2");
		expect(markup).toContain("ps-3");
		expect(markup).not.toContain("border-l-2");
	});

	test("table headers align to the inline start", () => {
		expect(renderMarkdownElement("th")).toContain("text-start");
	});
});

describe("chat text direction follows its content", () => {
	test("prose blocks resolve their own direction", () => {
		for (const tag of [
			"p",
			"li",
			"h1",
			"h2",
			"h3",
			"h4",
			"blockquote",
			"th",
			"td",
		]) {
			expect(renderMarkdownElement(tag, "مرحبا")).toContain('dir="auto"');
		}
	});

	test("list containers and inline runs keep the inherited direction", () => {
		for (const tag of ["ul", "ol", "strong"]) {
			expect(renderMarkdownElement(tag)).not.toContain('dir="auto"');
		}
	});

	test("an explicit direction from the markdown pipeline still wins", () => {
		const Paragraph: FunctionComponent<{
			children?: ReactNode;
			dir?: string;
		}> = (props) => createElement("p", props);
		const { p } = withBidiAuto({ p: Paragraph });
		expect(renderToStaticMarkup(createElement(p, null, "x"))).toContain(
			'dir="auto"'
		);
		expect(
			renderToStaticMarkup(createElement(p, { dir: "ltr" }, "x"))
		).toContain('dir="ltr"');
	});

	test("the user bubble text resolves its own direction", () => {
		expect(source("./user-message.tsx")).toMatch(
			/data-slot="bubble-content"\s*\{\.\.\.BIDI_AUTO\}/u
		);
		expect(BIDI_AUTO).toEqual({ dir: "auto" });
	});

	test("a text field follows its first letter in any script", () => {
		for (const text of ["مرحبا", "שלום", "こんにちは", "Grüße", "  Hello"]) {
			expect(bidiAutoFor(text)).toEqual({ dir: "auto" });
		}
	});

	test("an empty or letterless field keeps the interface direction", () => {
		for (const text of ["", "   ", "123", "🙂", "?!"]) {
			expect(bidiAutoFor(text)).toEqual({});
		}
	});

	test("the edit box resolves an Arabic message and inherits when empty", () => {
		const render = (initialText: string) =>
			renderToStaticMarkup(createElement(UserMessageEditor, { initialText }));
		expect(render("مرحبا")).toMatch(/<textarea[^>]*dir="auto"/u);
		expect(render("Guten Tag")).toMatch(/<textarea[^>]*dir="auto"/u);
		expect(render("")).not.toContain('dir="auto"');
	});

	test("the composer textarea and its overlay share one direction", () => {
		for (const file of [
			"./input-bar-editor.tsx",
			"./input-bar-input-content.tsx",
		]) {
			const text = source(file);
			expect(text).toMatch(
				/aria-hidden="true"\s*\{\.\.\.bidiAutoFor\(input\)\}\s*className="[^"]*absolute inset-0 whitespace-pre-wrap/u
			);
			expect(text).toMatch(
				/<textarea\s*aria-label=\{textareaAriaLabel\}\s*\{\.\.\.bidiAutoFor\(input\)\}[\s\S]*?value=\{input\}/u
			);
		}
	});

	test("the question answer box resolves its own direction", () => {
		expect(source("./question/question-prompt.tsx")).toMatch(
			/<textarea\s*aria-label="[^"]+"\s*\{\.\.\.bidiAutoFor\(textValue\)\}[\s\S]*?value=\{textValue\}/u
		);
	});
});

describe("transcript, composer and Settings sources", () => {
	const files = [
		"./markdown-renderers.tsx",
		"./quote.tsx",
		"./input-bar-editor.tsx",
		"./input-bar-input-content.tsx",
		"./input-bar-surface.tsx",
		"./message-actions.tsx",
		"./message-bubble.ts",
		"./message-reaction-badge.tsx",
		"./message-reactions.tsx",
		"../settings-nav.tsx",
		"../resizable-settings-layout.tsx",
	];
	for (const file of files) {
		test(`${file} uses logical direction utilities`, () => {
			expect(physicalUtilities(file)).toEqual([]);
		});
	}

	test("the expanded composer reserves room for its corner control at the inline end", () => {
		for (const file of [
			"./input-bar-editor.tsx",
			"./input-bar-input-content.tsx",
		]) {
			expect(source(file)).toContain("ps-5 pe-14");
		}
		expect(source("./input-bar-surface.tsx")).toContain("absolute end-2 top-2");
	});

	test("back, next and branch arrows mirror in right-to-left layouts", () => {
		for (const file of [
			"./message-actions.tsx",
			"../settings-nav.tsx",
			"./image-lightbox-stage.tsx",
			"../../web/link-arrow.tsx",
		]) {
			const text = source(file);
			expect(text).toContain("DirectionalIcon");
			expect(text).not.toMatch(
				/<HugeiconsIcon[^>]*icon=\{Arrow(?:Left|Right)0[12]Icon\}/u
			);
		}
	});

	test("a closed tool-row chevron points toward the inline end", () => {
		expect(source("./tools/tool-row-base.module.css")).toMatch(
			/\.chevron:dir\(rtl\)\s*\{\s*rotate:\s*180deg;/u
		);
	});
});
