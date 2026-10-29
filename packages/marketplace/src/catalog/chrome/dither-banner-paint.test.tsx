import { readFileSync } from "node:fs";
// DitherBanner hands its colour and grain to CSS custom properties; only the
// shared visual module turns them into paint. Under `bun test` a CSS module
// resolves to an empty object, so a dropped class would render no difference.
// Stand in a module whose class names echo their keys, then prove that each
// element carrying a custom property also carries the class consuming it.

import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("../../marketplace-visual.module.css", () => ({
	default: new Proxy(
		{},
		{
			get: (_target, key) =>
				typeof key === "string" ? `visual-${key}` : undefined,
		}
	),
}));

const { default: DitherBanner } = await import("./dither-banner.tsx");

const visualCss = readFileSync(
	new URL("../../marketplace-visual.module.css", import.meta.url),
	"utf8"
);

/** The opening tag of the first element whose inline style declares `property`. */
function tagDeclaring(html: string, property: string): string {
	const match = html.match(
		new RegExp(`<[a-z]+\\b[^>]*style="[^"]*${property}:[^>]*>`)
	);
	if (!match) {
		throw new Error(`no element declares ${property}`);
	}
	return match[0];
}

function classesOf(tag: string): string[] {
	return tag.match(/class="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
}

describe("DitherBanner paint reaches the visual module", () => {
	test("the background class consumes the background property", () => {
		expect(visualCss).toMatch(
			/\.background\s*\{\s*background:\s*var\(--marketplace-background\);/
		);
	});

	test("the opacity class consumes the opacity property", () => {
		expect(visualCss).toMatch(
			/\.opacity\s*\{\s*opacity:\s*var\(--marketplace-opacity\);/
		);
	});

	test("a declared background is painted by the background class", () => {
		const tag = tagDeclaring(
			renderToStaticMarkup(<DitherBanner banner={{ background: "#0099ff" }} />),
			"--marketplace-background"
		);
		expect(tag).toContain("--marketplace-background:#0099ff");
		expect(classesOf(tag)).toContain("visual-background");
	});

	test("a colour ramp and the flat fallback share the same paint path", () => {
		const ramp = tagDeclaring(
			renderToStaticMarkup(
				<DitherBanner banner={{ colors: ["#111111", "#222222"] }} />
			),
			"--marketplace-background"
		);
		expect(ramp).toContain("linear-gradient(135deg, #111111, #222222)");
		expect(classesOf(ramp)).toContain("visual-background");

		const fallback = tagDeclaring(
			renderToStaticMarkup(<DitherBanner fallback="#ff00ff" />),
			"--marketplace-background"
		);
		expect(classesOf(fallback)).toContain("visual-background");
	});

	test("no declared background leaves the muted floor, not an empty paint", () => {
		const html = renderToStaticMarkup(<DitherBanner />);
		expect(html).not.toContain("--marketplace-background");
		expect(html).not.toContain("visual-background");
		expect(html).toContain("bg-muted");
	});

	test("declared grain is painted by the opacity class", () => {
		const tag = tagDeclaring(
			renderToStaticMarkup(
				<DitherBanner
					banner={{ background: "#0099ff", noise: { opacity: 50 } }}
				/>
			),
			"--marketplace-opacity"
		);
		expect(tag.startsWith("<svg")).toBe(true);
		expect(tag).toContain("--marketplace-opacity:0.5");
		expect(classesOf(tag)).toContain("visual-opacity");
	});
});
