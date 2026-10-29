import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import styles from "./core.module.css";
import { CoreProductScene } from "./core.tsx";

describe("CoreProductScene", () => {
	it("server-renders the same decorative orchestration map every time", () => {
		const first = renderToStaticMarkup(<CoreProductScene />);
		const second = renderToStaticMarkup(<CoreProductScene />);

		expect(first).toBe(second);
		expect(first).toContain('aria-hidden="true"');
		expect(first).toContain('data-scene="core"');
		expect(first).toContain('data-testid="realm-visual-core"');
		// No generated ids or React useId tokens to mismatch on hydrate.
		expect(first).not.toMatch(/\sid="/);
		expect(first).not.toMatch(/:r[0-9a-z]+:|«r/);
		for (const label of [
			"claude code",
			"codex",
			"gemini",
			"openai",
			"mcp",
			"memory",
			"git",
			"core",
			"task",
		]) {
			expect(first).toContain(`>${label}</text>`);
		}
	});

	it("ships a compiled stylesheet whose motion respects reduced motion", async () => {
		expect(styles.root).toBeTruthy();
		expect(styles.packet).toBeTruthy();

		const stylesheet = await Bun.file(
			new URL("./core.module.css", import.meta.url)
		).text();
		expect(stylesheet).toContain("prefers-reduced-motion: no-preference");
		expect(stylesheet).toContain(".root:not([data-inview]) *");
		expect(stylesheet).toContain("animation-play-state: paused");
		expect(stylesheet).not.toContain("prefers-reduced-motion: reduce");
		// A CSS-module compiler leaves a keyframe name unscoped inside an
		// `animation` shorthand that holds a var(), so only longhands are used.
		expect(stylesheet).not.toMatch(/animation:[^;]*var\(/);
	});
});
