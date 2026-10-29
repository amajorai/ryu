// The AppIcon tile's theme-preview branch: a theme listing that ships no art of
// its own paints its palette (the same bg/surface/primary bars the Appearance
// tab's preset picker shows) instead of the generative dither avatar. The swatch
// is the theme's identity, and the whole point is that it must NOT be a
// random-hue avatar.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AppIcon from "./app-icon.tsx";

const THEME_PREVIEW = {
	bg: "#0b0e14",
	surface: "#141926",
	primary: "#7c9cff",
	text: "#e6e9f0",
	mode: "dark",
};

function swatchBarStyles(html: string): string[] {
	// Read each bar's palette input from the owned stylesheet variable (the
	// legacy direct background-color remains accepted for the same contract).
	// React renders the style without a trailing semicolon.
	return [
		...html.matchAll(/(?:background-color|--catalog-swatch-color):([^"']+)/g),
	].flatMap((m) => (m[1] ? [m[1]] : []));
}

describe("AppIcon theme preview", () => {
	test("paints the theme's palette as the tile when the item ships no art", () => {
		const html = renderToStaticMarkup(
			<AppIcon
				name="Midnight"
				seedId="@acme/midnight"
				themePreview={THEME_PREVIEW}
			/>
		);
		// All three swatch colours are painted as inline backgrounds.
		expect(swatchBarStyles(html)).toEqual(["#0b0e14", "#141926", "#7c9cff"]);
	});

	test("does not paint a dither avatar for a theme with a preview", () => {
		const html = renderToStaticMarkup(
			<AppIcon
				name="Midnight"
				seedId="@acme/midnight"
				themePreview={THEME_PREVIEW}
			/>
		);
		// The generative avatar renders a seeded canvas; the swatch branch must not
		// reach it.
		expect(html).not.toContain("<canvas");
	});

	test("paints a stable material and monogram for an art-less non-theme", () => {
		const html = renderToStaticMarkup(
			<AppIcon name="Something" seedId="@acme/x" />
		);
		expect(swatchBarStyles(html)).toEqual([]);
		// The avatar is a seeded canvas, not a colour swatch.
		expect(html).not.toContain("<canvas");
		expect(html).toContain('data-app-icon="fallback"');
	});

	test("paints a seeded plate behind glyph art when requested", () => {
		const html = renderToStaticMarkup(
			<AppIcon iconId="chat-01" name="Chat" seedId="@ryu/chat" seedPlate />
		);

		expect(html).not.toContain("<canvas");
		expect(html).toContain('data-app-icon="fallback"');
		// The plate is painted from the seeded material, and the glyph is the
		// registered Icon: its class owns the CSS mask and its variable names the
		// requested art.
		expect(html).toContain("--catalog-icon-material:url(");
		expect(html).toContain("ryu-registered-icon");
		expect(html).toContain(
			"--ryu-icon-mask:url(&quot;https://api.iconify.design/hugeicons/chat-01.svg"
		);
	});

	test("applies manifest padding to raster logo art", () => {
		const html = renderToStaticMarkup(
			<AppIcon
				iconPadding="md"
				iconUrl="https://cdn.example.test/logo.png"
				name="Padded logo"
			/>
		);

		expect(html).toContain("object-contain p-1.5");
	});
});

describe("unframed engine logos", () => {
	test("removes tile surfaces, rings and shadows in cards and heroes", () => {
		for (const variant of ["card", "hero"] as const) {
			const html = renderToStaticMarkup(
				<AppIcon
					iconAppearance="bare"
					iconBackground="#fff"
					iconUrl="/logo.svg"
					variant={variant}
				/>
			);
			expect(html).not.toMatch(
				/bg-muted|bg-background|shadow-lg|ring-white|background:/
			);
			expect(html).toContain("object-contain");
		}
	});
	test("monochrome marks invert in dark mode and on dark hero bands", () => {
		const card = renderToStaticMarkup(
			<AppIcon iconAppearance="monochrome" iconUrl="/logo.svg" />
		);
		expect(card).toContain("dark:invert");
		const hero = renderToStaticMarkup(
			<AppIcon iconAppearance="monochrome" iconUrl="/logo.svg" variant="hero" />
		);
		expect(hero).toContain("invert");
		expect(hero).not.toContain("dark:invert");
		const color = renderToStaticMarkup(
			<AppIcon iconAppearance="bare" iconUrl="/logo.svg" />
		);
		expect(color).not.toContain("invert");
	});
});

test("explicit dark brand art follows the app theme without inversion", () => {
	const html = renderToStaticMarkup(
		<AppIcon
			iconAppearance="bare"
			iconUrl="/light.png"
			iconUrlDark="/dark.png"
		/>
	);
	expect(html).toContain("/light.png");
	expect(html).toContain("/dark.png");
	expect(html).toContain("dark:hidden");
	expect(html).toContain("dark:block");
	expect(html).not.toContain("invert");
});
