import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const SCENE_DIR = new URL("./", import.meta.url);
const STYLESHEETS = readdirSync(SCENE_DIR).filter((file) =>
	file.endsWith(".module.css")
);
const MOTION_GATE = "@media (prefers-reduced-motion: no-preference)";
const COMMENT = /\/\*[\s\S]*?\*\//g;

/** The body of every block that opens with `prefix`, braces matched. */
function blocks(css: string, prefix: RegExp): string[] {
	const bodies: string[] = [];
	for (const match of css.matchAll(prefix)) {
		const open = css.indexOf("{", match.index);
		let depth = 0;
		for (let index = open; index < css.length; index += 1) {
			if (css[index] === "{") {
				depth += 1;
			} else if (css[index] === "}") {
				depth -= 1;
				if (depth === 0) {
					bodies.push(css.slice(open + 1, index));
					break;
				}
			}
		}
	}
	return bodies;
}

/** Property names declared in a block of CSS. */
const properties = (css: string) =>
	[...css.matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1] ?? "");

/** Every `animation:` shorthand value in a stylesheet, joined across lines. */
const animationShorthands = (css: string) =>
	[...css.matchAll(/(?<![-\w])animation:\s*([^;]+);/g)].map((match) =>
		(match[1] ?? "").replace(/\s+/g, " ").trim()
	);

describe("product scene stylesheets", () => {
	it("covers every scene module plus the shared one", () => {
		expect(STYLESHEETS).toContain("scene.module.css");
		expect(STYLESHEETS.length).toBeGreaterThanOrEqual(11);
	});

	it("leaves the scene placement to SceneStage", () => {
		// SceneStage centres every canvas; a stylesheet that pins or pads the
		// stage would pull the scenes off centre again.
		const shared = readFileSync(new URL("scene.module.css", SCENE_DIR), "utf8");
		expect(shared).not.toMatch(
			/padding(-top)?\s*:|(?<![-\w])inset\s*:|position\s*:/
		);
	});

	for (const file of STYLESHEETS) {
		const css = readFileSync(new URL(file, SCENE_DIR), "utf8").replace(
			COMMENT,
			""
		);

		describe(file, () => {
			it("animates transform and opacity only", () => {
				const keyframes = blocks(css, /@keyframes\s+[\w-]+\s*\{/g);
				expect(keyframes.length).toBeGreaterThan(0);
				for (const body of keyframes) {
					for (const property of properties(body)) {
						expect(["transform", "opacity"]).toContain(property);
					}
				}
				expect(css).not.toContain("stroke-dash");
			});

			it("attaches motion only in view and with motion allowed", () => {
				// Everything outside the gate is the still: no animation there, so
				// the server frame, offscreen frame and reduced-motion frame match.
				const gated = blocks(
					css,
					/@media \(prefers-reduced-motion: no-preference\)\s*\{/g
				);
				expect(gated).toHaveLength(1);
				const outside = css.slice(0, css.indexOf(MOTION_GATE));
				expect(outside).not.toMatch(/(?<![-\w])animation(-[a-z-]+)?\s*:/);
				expect(css.slice(css.indexOf(MOTION_GATE))).not.toContain("@keyframes");
				for (const selector of (gated[0] ?? "").match(/[^{}]+(?=\{)/g) ?? []) {
					expect(selector).toContain("[data-inview]");
				}
			});

			it("keeps every animation shorthand compilable", () => {
				// Lightning CSS cannot scope a keyframe name inside a shorthand that
				// also holds a var(), and drops a shorthand with no name.
				for (const value of animationShorthands(css)) {
					expect(value).not.toContain("var(");
					expect(value).not.toMatch(/^[\d.]+m?s\b/);
				}
			});

			it("sets no label below the shared 11px and no colour of its own", () => {
				for (const match of css.matchAll(/font-size:\s*([\d.]+)px/g)) {
					expect(Number(match[1])).toBeGreaterThanOrEqual(11);
				}
				expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|oklch\(/i);
				expect(css).not.toContain("--color-realm");
			});
		});
	}
});
