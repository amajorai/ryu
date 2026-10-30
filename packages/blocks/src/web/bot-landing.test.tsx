import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readSharedGlobals } from "../../../ui/src/styles/read-shared-globals.ts";
import BotLanding from "./bot-landing.tsx";
import { BotAppVisual } from "./bot-visual.tsx";

test("Bot landing includes the managed product story", () => {
	const html = renderToStaticMarkup(<BotLanding />);

	expect(html).toContain('data-testid="product-page-bot"');
	expect(html).toContain("data-product-hero-layout=");
	expect(html).toContain("data-product-bento-layout=");
	expect(html).toContain("Get work done with managed AI");
	expect(html).not.toContain("Hand Bot a task");
	expect(html).toContain("Bot");
	expect(html).not.toContain("Bot is here");
});

test("Bot product visual uses theme-aware surfaces", () => {
	const html = renderToStaticMarkup(<BotAppVisual />);

	expect(html).toContain("bg-card");
	expect(html).toContain("bg-background/60");
	expect(html).toContain("bg-background");
	for (const lightOnlySurface of [
		"bg-[#f1f1ef]",
		"bg-[#e8e8e5]",
		"bg-[#f8f8f6]",
		"bg-[#e7e7e5]",
		"bg-white",
		"border-black/10",
		"ring-black/10",
	]) {
		expect(html).not.toContain(lightOnlySurface);
	}
});

const AVATAR_PATTERN =
	/<span class="([^"]*)" style="--blocks-backgroundColor:var\(--([\w-]+)\)">/g;
const NEUTRAL_TOKEN_PATTERN = /--(chart-\d):\s*oklch\(([\d.]+) 0 0\)/g;
const WCAG_AA_TEXT = 4.5;

function contrastRatio(first: number, second: number): number {
	const lighter = Math.max(first, second);
	const darker = Math.min(first, second);
	return (lighter + 0.05) / (darker + 0.05);
}

test("Bot avatar initials keep AA contrast on their chart fills", () => {
	const theme = readSharedGlobals();
	// Neutral OKLCH greys: relative luminance is the cube of the lightness.
	// Keep every definition (light and dark) so a theme split is still checked.
	const luminancesByToken = new Map<string, number[]>();
	for (const [, token = "", lightness = ""] of theme.matchAll(
		NEUTRAL_TOKEN_PATTERN
	)) {
		const luminances = luminancesByToken.get(token) ?? [];
		luminances.push(Number(lightness) ** 3);
		luminancesByToken.set(token, luminances);
	}

	const avatars = [
		...renderToStaticMarkup(<BotAppVisual />).matchAll(AVATAR_PATTERN),
	];
	// Seven sidebar rows plus the open thread's header avatar.
	expect(avatars.length).toBe(8);

	for (const [, className = "", token = ""] of avatars) {
		const classes = className.split(" ");
		const ink = classes.includes("text-white") ? 1 : 0;
		expect(
			classes.includes("text-white") || classes.includes("text-black")
		).toBe(true);
		if (!token.startsWith("chart-")) {
			// Bright status fills (for example --warning) keep black initials.
			expect(classes).toContain("text-black");
			continue;
		}
		const fills = luminancesByToken.get(token) ?? [];
		// A chart token the theme no longer defines as a neutral grey must fail
		// here rather than skip the contrast check.
		expect(fills.length).toBeGreaterThan(0);
		for (const fill of fills) {
			expect(contrastRatio(fill, ink)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
		}
	}
});
