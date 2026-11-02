// Right-to-left layout guards for the chat transcript, composer and Settings
// navigation. These surfaces must use logical utilities (`ps-*`, `border-s`,
// `text-start`, `end-*`) so an Arabic or Hebrew reply puts list markers, quote
// bars and the composer's corner control on the correct side, and their
// directional arrows must mirror.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MARKDOWN_COMPONENTS } from "./markdown-renderers.tsx";

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
