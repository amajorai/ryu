import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	DESKTOP_WALLPAPER,
	HERO_BACKGROUNDS,
	HeroBackground,
} from "./hero-background.tsx";
import { StageSection } from "./stage-section.tsx";

function effectOf(id: keyof typeof HERO_BACKGROUNDS): unknown {
	return (HERO_BACKGROUNDS[id]() as ReactElement).type;
}

describe("hero backgrounds", () => {
	test("Bot opens on the starfield", () => {
		expect(effectOf("bot")).toBe(effectOf("page-startups"));
	});

	test("Desktop opens on a Color Bends wallpaper in its own palette", () => {
		const desktop = HERO_BACKGROUNDS.desktop() as ReactElement<{
			colors: string[];
		}>;
		expect<unknown>(desktop.type).toBe(effectOf("chrome-extension"));
		expect(desktop.props.colors).toBe(DESKTOP_WALLPAPER);
		for (const id of Object.keys(HERO_BACKGROUNDS) as Array<
			keyof typeof HERO_BACKGROUNDS
		>) {
			const other = HERO_BACKGROUNDS[id]() as ReactElement<{
				colors?: string[];
			}>;
			if (id !== "desktop" && other.type === desktop.type) {
				expect(other.props.colors).not.toEqual(DESKTOP_WALLPAPER);
			}
		}
	});

	test("the backdrop layer is decorative", () => {
		const html = renderToStaticMarkup(<HeroBackground id="desktop" />);
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('data-hero-background="desktop"');
	});
});

test("a hero backdrop server-renders gated, with no effect mounted", () => {
	const html = renderToStaticMarkup(<HeroBackground id="core" />);

	expect(html).toContain('data-hero-background="core"');
	expect(html).toContain('data-backdrop="pending"');
	expect(html).not.toContain("<canvas");
});

test("a stage section keeps its dark stage while the backdrop is gated", () => {
	const html = renderToStaticMarkup(
		<StageSection backdrop="page-contact">
			<h1>Contact</h1>
		</StageSection>
	);

	expect(html).toContain('data-stage-section="page-contact"');
	expect(html).toContain('data-backdrop="pending"');
	expect(html).toContain("<h1>Contact</h1>");
	expect(html).not.toContain("<canvas");
});
