import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConsoleScene } from "./console.tsx";

describe("ConsoleScene", () => {
	it("server-renders a decorative, deterministic still frame", () => {
		const markup = renderToStaticMarkup(<ConsoleScene />);

		expect(markup).toContain('aria-hidden="true"');
		expect(markup.split("realm-visual-console").length).toBe(2);
		expect(markup).toContain("12 nodes · 04 models · 28 agents");
		for (const label of ["support", "research", "triage", "audit"]) {
			expect(markup).toContain(`>${label}</text>`);
		}
		expect(markup).not.toMatch(/\sid="/);
		expect(markup).not.toMatch(/«r|:r[0-9a-z]+:|_r_[0-9a-z]+_/);
		expect(renderToStaticMarkup(<ConsoleScene />)).toBe(markup);
	});

	it("staggers ticks by index and keeps its motion pausable and reducible", async () => {
		const markup = renderToStaticMarkup(<ConsoleScene />);
		expect(markup).toContain("--i:5");

		const stylesheet = await Bun.file(
			new URL("./console.module.css", import.meta.url)
		).text();
		expect(stylesheet).toContain("prefers-reduced-motion: no-preference");
		expect(stylesheet).toContain(".root:not([data-inview]) *");
		expect(stylesheet).toContain("animation-play-state: paused");
		expect(stylesheet).toContain("calc(var(--i) * 0.36s)");
	});
});
