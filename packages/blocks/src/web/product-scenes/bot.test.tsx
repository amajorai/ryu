import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BotScene } from "./bot.tsx";

describe("BotScene", () => {
	it("server renders a decorative, deterministic thread", () => {
		const html = renderToStaticMarkup(<BotScene />);

		expect(html).toContain('data-testid="realm-visual-bot"');
		expect(html).toContain('aria-hidden="true"');
		expect(html).not.toContain("data-inview");
		expect(html).toContain("<svg");
		expect(html).toContain(">brief</text>");
		expect(html).not.toMatch(/\sid="/);
		expect(html).not.toMatch(/:R[\w-]*:|«r|\bclip-path=|url\(#/);
		expect(renderToStaticMarkup(<BotScene />)).toBe(html);
	});

	it("draws the amber review state and the emerald done check", () => {
		const html = renderToStaticMarkup(<BotScene />);

		expect(html).toContain("fill-realm-review-marker");
		expect(html).toContain("stroke-realm-complete");
		expect(html).toContain("dark:stroke-realm-complete-dark");
	});

	it("animates only with motion allowed and pauses off screen", async () => {
		const stylesheet = await Bun.file(
			new URL("./bot.module.css", import.meta.url)
		).text();

		expect(stylesheet).toContain("prefers-reduced-motion: no-preference");
		expect(stylesheet).toContain(".scene:not([data-inview]) *");
		expect(stylesheet).toContain("animation-play-state: paused");
		expect(stylesheet).toContain("7.6s");
	});
});
