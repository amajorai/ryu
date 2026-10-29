import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const SCENE_DIR = new URL("./", import.meta.url);
const STYLESHEETS = readdirSync(SCENE_DIR).filter((file) =>
	file.endsWith(".module.css")
);

/** Every `animation:` shorthand value in a stylesheet, joined across lines. */
function animationShorthands(css: string): string[] {
	return [...css.matchAll(/(?<![-\w])animation:\s*([^;]+);/g)].map((match) =>
		(match[1] ?? "").replace(/\s+/g, " ").trim()
	);
}

describe("product scene stylesheets", () => {
	it("covers every scene module", () => {
		expect(STYLESHEETS.length).toBeGreaterThanOrEqual(10);
	});

	// The CSS-modules compiler (Lightning CSS, under both Turbopack and Bun)
	// cannot scope a keyframe name inside a shorthand that also holds a var(),
	// and it drops a shorthand with no name, leaving a 0s duration. Either way
	// the scene stops animating, so timings with variables or without a name
	// must be written as longhands.
	for (const file of STYLESHEETS) {
		it(`${file} keeps every animation shorthand compilable`, () => {
			const css = readFileSync(new URL(file, SCENE_DIR), "utf8");
			for (const value of animationShorthands(css)) {
				if (value === "none" || value.startsWith("none ")) {
					continue;
				}
				expect(value).not.toContain("var(");
				expect(value).not.toMatch(/^[\d.]+m?s\b/);
			}
		});

		it(`${file} pauses off screen and honours reduced motion`, () => {
			const css = readFileSync(new URL(file, SCENE_DIR), "utf8");
			expect(css).toContain("[data-inview]");
			expect(css).toContain("prefers-reduced-motion");
		});
	}
});
