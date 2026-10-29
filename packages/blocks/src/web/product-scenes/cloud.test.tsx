import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CloudScene } from "./cloud.tsx";

describe("CloudScene", () => {
	it("server renders a stable, decorative frame", () => {
		const first = renderToStaticMarkup(<CloudScene />);
		const second = renderToStaticMarkup(<CloudScene />);

		expect(first).toBe(second);
		expect(first).toContain('data-testid="realm-visual-cloud"');
		expect(first).toContain('aria-hidden="true"');
		expect(first).toContain("<svg");
		expect(first).toContain("EU · SG");
		expect(first).toContain("models");
	});

	it("draws no ids, so several cards can share a page", () => {
		const markup = renderToStaticMarkup(<CloudScene />);

		expect(markup).not.toMatch(/\sid="/);
		expect(markup).not.toMatch(/«r|:r[0-9a-z]+:/);
		expect(markup).not.toContain("url(#");
	});

	it("keeps a still pose and pauses off screen", async () => {
		const stylesheet = await Bun.file(
			new URL("./cloud.module.css", import.meta.url)
		).text();

		expect(stylesheet).toContain("prefers-reduced-motion: reduce");
		expect(stylesheet).toContain(".root:not([data-inview]) *");
		expect(stylesheet).toContain("animation-play-state: paused");
		expect(stylesheet).toContain("transform-box: fill-box");
	});
});
