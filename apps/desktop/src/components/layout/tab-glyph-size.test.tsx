// TabGlyph forwards its className to whatever it renders. The Hugeicons
// fallback (built-in page tabs, unloaded tabs) and the busy Spinner carry no
// size of their own (24px / size-4 by default), so every tab strip must pass
// the slot size to TabGlyph itself rather than only to a wrapper.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";

// TitleBar.tsx pulls in stores that read localStorage at module load.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

const { TabGlyph } = await import("./TitleBar.tsx");

describe("TabGlyph sizing", () => {
	test("puts the slot size on the Hugeicons fallback glyph", () => {
		const html = renderToStaticMarkup(
			<TabGlyph className="size-3" logoSize="12px" path="/settings" />
		);
		expect(html).toMatch(/<svg[^>]*class="[^"]*\bsize-3\b/);
	});

	test("puts the slot size on the unloaded Zzz glyph", () => {
		const html = renderToStaticMarkup(
			<TabGlyph className="size-3.5" logoSize="14px" path="/chat" unloaded />
		);
		expect(html).toMatch(/<svg[^>]*class="[^"]*\bsize-3\.5(?![\w.-])/);
	});

	test("overrides the busy Spinner's default size-4", () => {
		const html = renderToStaticMarkup(
			<TabGlyph busy className="size-3" logoSize="12px" path="/chat" />
		);
		expect(html).toContain('role="status"');
		expect(html).toMatch(/class="[^"]*\bsize-3\b/);
		expect(html).not.toMatch(/class="[^"]*\bsize-4\b/);
	});
});

/** A literal `className` carrying a Tailwind `size-*` token. */
const SIZED_CLASS_NAME = /className="[^"]*(?<![\w-])size-[\w.]+/;

/**
 * Every `<TabGlyph ... />` element in a source file. Throws when an element
 * does not fit the self-closing, `>`-free prop shape this scan reads, so a new
 * call site cannot slip past the guard unscanned.
 */
function tabGlyphElements(name: string, source: string): string[] {
	const elements = source.match(/<TabGlyph\b[^>]*\/>/g) ?? [];
	const openings = source.match(/<TabGlyph\b/g)?.length ?? 0;
	if (elements.length !== openings) {
		throw new Error(
			`${name}: found ${openings} <TabGlyph> elements but could scan ${elements.length}; update tab-glyph-size.test.tsx`
		);
	}
	return elements;
}

describe("TabGlyph call sites", () => {
	// The shell frame's tab strips were split out of `layout/` into
	// `shell/<part>/` modules, so scan both trees.
	const componentsDir = join(import.meta.dir, "..");
	const sources = ["layout", "shell"]
		.flatMap((dir) =>
			readdirSync(join(componentsDir, dir), { recursive: true }).map((name) =>
				join(dir, String(name))
			)
		)
		.filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
		.map((name) => ({
			name,
			elements: tabGlyphElements(
				name,
				readFileSync(join(componentsDir, name), "utf8")
			),
		}))
		.filter(({ elements }) => elements.length > 0);

	test("finds the tab strips that render TabGlyph", () => {
		expect(sources.map(({ name }) => name)).toContain(
			join("shell", "title-bar", "regular-tab.tsx")
		);
	});

	test("every call site hands TabGlyph a size class", () => {
		const unsized = sources.flatMap(({ name, elements }) =>
			elements
				.filter((element) => !SIZED_CLASS_NAME.test(element))
				.map((element) => `${name}: ${element.replaceAll(/\s+/g, " ")}`)
		);
		expect(unsized).toEqual([]);
	});
});
