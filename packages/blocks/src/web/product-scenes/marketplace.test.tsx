import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketplaceScene } from "./marketplace.tsx";

describe("MarketplaceScene", () => {
	it("server-renders a decorative still frame", () => {
		const html = renderToStaticMarkup(<MarketplaceScene />);

		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('data-testid="realm-visual-marketplace"');
		expect(html).not.toContain("data-inview");
		for (const char of "review") {
			expect(html).toContain(`>${char}</text>`);
		}
		expect(html.match(/<rect[^>]*width="44"/g)?.length).toBeGreaterThanOrEqual(
			15
		);
	});

	it("has no generated ids and renders identically every time", () => {
		const first = renderToStaticMarkup(<MarketplaceScene />);

		expect(first).not.toMatch(/\sid="/);
		expect(first).not.toContain("url(#");
		expect(renderToStaticMarkup(<MarketplaceScene />)).toBe(first);
	});

	it("pauses offscreen and keeps reduced motion on the still frame", async () => {
		const stylesheet = await Bun.file(
			new URL("./marketplace.module.css", import.meta.url)
		).text();

		expect(stylesheet).toContain(".root:not([data-inview])");
		expect(stylesheet).toContain("animation-play-state: paused");
		expect(stylesheet).toContain("prefers-reduced-motion: reduce");
	});
});
