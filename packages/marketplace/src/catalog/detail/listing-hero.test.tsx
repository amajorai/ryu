import { readFileSync } from "node:fs";
// Card and hero share icon identity and material. The detail hero adds elevation,
// never a second icon tile. Banner behavior is independent of icon material.

import { describe, expect, test } from "bun:test";
import { resolveAnimatedGradient } from "@ryu/ui/components/motion/animated-gradient.tsx";
import { renderToStaticMarkup } from "react-dom/server";
import AppIcon from "../chrome/app-icon.tsx";
import DitherBanner from "../chrome/dither-banner.tsx";
import { safeCssBackground } from "../safe-url.ts";
import {
	LISTING_HERO_NO_ART_BACKGROUND,
	ListingHero,
} from "./listing-detail-shell.tsx";

/** The standard wash every packaged manifest declares: covers the near end of the
 *  square and dissolves to whatever is behind the far end. */
const DISSOLVING = { direction: "down", from: 250, to: "transparent" } as const;

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("native layered icon identity", () => {
	test("card and hero display the same completed light and dark artwork", () => {
		const card = renderToStaticMarkup(
			<AppIcon iconId="bulb" seedId="@ryu/advisor" />
		);
		const hero = renderToStaticMarkup(
			<AppIcon iconId="bulb" seedId="@ryu/advisor" variant="hero" />
		);
		const sources = (html: string) =>
			[...html.matchAll(/src="([^"]+)"/g)].map((match) => match[1]);
		expect(sources(card)).toHaveLength(2);
		expect(sources(hero)).toEqual(sources(card));
		for (const html of [card, hero]) {
			expect(html).toContain('data-app-icon="layered"');
			expect(html).not.toContain("mask-image");
			expect(html).not.toContain("ryu-registered-icon");
			expect(html).not.toContain("background-image");
			expect(html).not.toContain("ring-white");
		}
	});
	test("supplied complete artwork has no extra icon frame", () => {
		const html = renderToStaticMarkup(
			<AppIcon iconPadding="none" iconUrl="https://example.com/native.png" />
		);
		expect(html).toContain('data-app-icon="image"');
		expect(html).not.toMatch(/rounded-|bg-muted|background-image/);
	});
	test("custom flat backgrounds remain supported for unregistered icons", () => {
		const html = renderToStaticMarkup(
			<AppIcon iconBackground="#123456" iconId="bulb" seedId="@custom/test" />
		);
		expect(html).toContain("background:#123456");
	});
});

describe("ListingHero", () => {
	test("uses one complete native tile for a shipped app", () => {
		const html = renderToStaticMarkup(
			<ListingHero
				dither={DISSOLVING}
				iconId="bulb"
				iconName="Advisor"
				name="Advisor"
				seedId="@ryu/advisor"
			/>
		);
		expect(occurrences(html, 'data-app-icon="layered"')).toBe(1);
		expect(html).not.toContain("mask-image");
		expect(html).not.toContain("ryu-registered-icon");
	});
	test("retains custom fallback content", () => {
		const html = renderToStaticMarkup(
			<ListingHero
				icon={<span data-testid="custom-mark">E</span>}
				name="Example"
			/>
		);
		expect(html).toContain('data-testid="custom-mark">E</span>');
	});
	test("keeps the banner scrim and feathers into the detail body", () => {
		const html = renderToStaticMarkup(
			<ListingHero banner={{ background: "#ffffff" }} name="Example" />
		);
		expect(html).toContain('data-testid="listing-hero-scrim"');
		const css = readFileSync(
			new URL("../../marketplace-visual.module.css", import.meta.url),
			"utf8"
		);
		expect(css).toContain("rgb(0 0 0 / 68%)");
		expect(css).toContain("var(--background)");
	});
	test("titles a dialog hero with an h2 and a page hero with an h1", () => {
		const dialog = renderToStaticMarkup(<ListingHero name="Example" />);
		expect(dialog).toContain("<h2");
		expect(dialog).not.toContain("<h1");
		const page = renderToStaticMarkup(
			<ListingHero name="Example" titleAs="h1" />
		);
		expect(page).toContain("<h1");
		expect(page).not.toContain("<h2");
	});
	test("an art-less hero paints the dark default under its white copy", () => {
		// `bg-muted` is near-white in light theme; the title and tagline are fixed
		// white in both themes.
		const html = renderToStaticMarkup(<ListingHero name="Example" />);
		expect(html).toContain(
			`--marketplace-background:${LISTING_HERO_NO_ART_BACKGROUND}`
		);
		expect(html).not.toContain('class="absolute inset-0 bg-muted"');
	});
	test("a caller's own background still outranks the dark default", () => {
		const html = renderToStaticMarkup(
			<ListingHero iconBackground="#123456" name="Example" />
		);
		expect(html).toContain("--marketplace-background:#123456");
		expect(html).not.toContain(LISTING_HERO_NO_ART_BACKGROUND);
	});
	test("a banner image paints over the dark default", () => {
		const html = renderToStaticMarkup(
			<ListingHero
				banner={{ imageUrl: "https://cdn.test/banner.png" }}
				name="Example"
			/>
		);
		expect(html).toContain('src="https://cdn.test/banner.png"');
		expect(html).toContain(LISTING_HERO_NO_ART_BACKGROUND);
	});
	test("below sm the title keeps its own line and the actions wrap under it", () => {
		const html = renderToStaticMarkup(
			<ListingHero
				actions={<button type="button">Get</button>}
				name="Example"
			/>
		);
		expect(html).toMatch(/class="[^"]*\bflex-wrap\b[^"]*\bsm:flex-nowrap\b/);
		expect(html).toMatch(/<h2 class="[^"]*\bbasis-full\b[^"]*\bsm:basis-0\b/);
		// A minimum height, not a fixed one, so the wrapped stack grows the band
		// instead of clipping the name off its top.
		expect(html).toContain("min-h-56");
		expect(html).not.toMatch(/[\s"]h-56\b/);
	});
});

describe("DitherBanner — an item-declared banner outranks the derived wash", () => {
	test("without a banner the hero derives its wash from icon_dither", () => {
		const html = renderToStaticMarkup(<DitherBanner dither={DISSOLVING} />);
		expect(html).toContain("canvas");
	});

	test("a flat `background` wins over the derived wash", () => {
		const html = renderToStaticMarkup(
			<DitherBanner banner={{ background: "#0099ff" }} dither={DISSOLVING} />
		);
		expect(html).toContain("--marketplace-background:#0099ff");
		expect(html).not.toContain("canvas");
	});

	test("`background` also wins over `colors`, and over the flat fallback", () => {
		const html = renderToStaticMarkup(
			<DitherBanner
				banner={{ background: "#0099ff", colors: ["#111", "#222"] }}
				fallback="#ff00ff"
			/>
		);
		expect(html).toContain("--marketplace-background:#0099ff");
		expect(html).not.toContain("linear-gradient");
	});

	test("an `imageUrl` paints over the background, and outranks the wash", () => {
		const html = renderToStaticMarkup(
			<DitherBanner
				banner={{ background: "#0099ff", imageUrl: "https://cdn.test/b.png" }}
				dither={DISSOLVING}
			/>
		);
		expect(html).toContain('src="https://cdn.test/b.png"');
		expect(html).toContain("object-cover");
		expect(html).toContain("--marketplace-background:#0099ff");
		expect(html).not.toContain("canvas");
	});

	test("`colors` still ramp 135° when no `background` is declared", () => {
		const html = renderToStaticMarkup(
			<DitherBanner banner={{ colors: ["#111111", "#222222"] }} />
		);
		expect(html).toContain("linear-gradient(135deg, #111111, #222222)");
	});

	test("`style: dither` keeps its noise overlay", () => {
		const html = renderToStaticMarkup(
			<DitherBanner
				banner={{ colors: ["#111111"], seed: 7, style: "dither" }}
			/>
		);
		expect(html).toContain("feTurbulence");
	});
});

describe("DitherBanner — the animated gradient degrades to a static paint", () => {
	/** The minimum an author writes: the style token and nothing else. No
	 *  `background`, no `colors`, no `imageUrl` — which is exactly the shape that
	 *  used to fall through to the derived wash. */
	const ANIMATED = { style: "animated-gradient" } as const;

	test("a gradient banner outranks the derived wash", () => {
		// The regression this pins: `explicitBanner` tested only background /
		// imageUrl / colors / dither, so a listing declaring ONLY the new style
		// painted its icon_dither and the gradient never rendered at all.
		const html = renderToStaticMarkup(
			<DitherBanner banner={ANIMATED} dither={DISSOLVING} />
		);
		expect(html).not.toContain("canvas");
		expect(html).toContain("linear-gradient");
	});

	test("without `live` it is a painted div — no canvas, no WebGL context", () => {
		// Cards, grids and list rows never pass `live`, so this IS their rendering.
		const html = renderToStaticMarkup(<DitherBanner banner={ANIMATED} />);
		expect(html).not.toContain("canvas");
		expect(html).toContain("radial-gradient");
	});

	test("`live` still paints the static background under the shader", () => {
		// The floor an evicted or refused context falls back to. It is on the
		// wrapper, so it survives whether or not the canvas ever mounts — and SSR
		// mounts no canvas either way.
		const html = renderToStaticMarkup(<DitherBanner banner={ANIMATED} live />);
		expect(html).toContain("linear-gradient");
		expect(html).not.toContain("canvas");
	});

	test("an unknown preset falls back to prism rather than painting nothing", () => {
		const html = renderToStaticMarkup(
			<DitherBanner banner={{ ...ANIMATED, gradient: { preset: "nope" } }} />
		);
		const prism = renderToStaticMarkup(
			<DitherBanner banner={{ ...ANIMATED, gradient: { preset: "prism" } }} />
		);
		expect(html).toBe(prism);
	});

	test("declared colours reach the static paint", () => {
		const html = renderToStaticMarkup(
			<DitherBanner
				banner={{
					...ANIMATED,
					gradient: {
						color1: "#111111",
						color2: "#222222",
						color3: "#333333",
					},
				}}
			/>
		);
		expect(html).toContain("#111111");
		expect(html).toContain("#222222");
		expect(html).toContain("#333333");
	});

	test("one fetching colour drops the WHOLE gradient to the derived wash", () => {
		// Same all-or-nothing rule `colors` follows: the three stops are one ramp,
		// and the colours feed a shader uniform as well as a CSS background.
		const html = renderToStaticMarkup(
			<DitherBanner
				banner={{
					...ANIMATED,
					gradient: {
						color1: "#111111",
						color2: "url(https://tracker.test/p.png)",
					},
				}}
				dither={DISSOLVING}
			/>
		);
		expect(html).not.toContain("tracker.test");
		expect(html).toContain("canvas");
	});

	test("a hostile number cannot reach a shader uniform unclamped", () => {
		// `swirlIterations: 1e6` is a GPU loop, not an ugly banner. The clamp lives
		// in the resolver both the shader and this paint read, so asserting the
		// resolved value here covers both.
		const resolved = resolveAnimatedGradient({
			config: {
				proportion: Number.POSITIVE_INFINITY,
				scale: 1e9,
				swirlIterations: 1e6,
			},
		});
		expect(resolved.swirlIterations).toBe(20);
		expect(resolved.scale).toBe(4);
		expect(resolved.proportion).toBe(0.35);
	});

	test("noise is the ONE overlay — the gradient reuses the dither texture", () => {
		const html = renderToStaticMarkup(
			<DitherBanner banner={{ ...ANIMATED, noise: { opacity: 50 } }} />
		);
		expect(html).toContain("feTurbulence");
		expect(html).toContain("--marketplace-opacity:0.5");
		// A declared zero means "no grain", not "grain at the default".
		const none = renderToStaticMarkup(
			<DitherBanner banner={{ ...ANIMATED, noise: { opacity: 0 } }} />
		);
		expect(none).not.toContain("feTurbulence");
	});
});

describe("DitherBanner — the untrusted values are guarded before paint", () => {
	test("a non-http(s) imageUrl never reaches an <img>", () => {
		for (const bad of ["javascript:alert(1)", "data:image/svg+xml,<svg/>"]) {
			const html = renderToStaticMarkup(
				<DitherBanner banner={{ imageUrl: bad }} />
			);
			expect(html).not.toContain("<img");
		}
	});

	test("a background that would fetch is dropped to the derived wash", () => {
		const html = renderToStaticMarkup(
			<DitherBanner
				banner={{ background: "url(https://tracker.test/pixel.png)" }}
				dither={DISSOLVING}
			/>
		);
		expect(html).not.toContain("tracker.test");
		// Dropped, so the item falls back to the tier it would have had anyway.
		expect(html).toContain("canvas");
	});

	test("one fetching stop drops the WHOLE ramp, not just that stop", () => {
		const html = renderToStaticMarkup(
			<DitherBanner
				banner={{ colors: ["#111111", "url(https://tracker.test/p.png)"] }}
			/>
		);
		expect(html).not.toContain("linear-gradient");
		expect(html).not.toContain("tracker.test");
	});
});

describe("safeCssBackground", () => {
	test("passes the colour forms authors actually use", () => {
		for (const ok of [
			"#0099ff",
			"rgb(0 153 255 / 40%)",
			"oklch(0.62 0.19 250)",
			"color-mix(in oklch, #0099ff, black)",
			"var(--brand)",
			"linear-gradient(135deg, #111, #222)",
		]) {
			expect(safeCssBackground(ok)).toBe(ok);
		}
	});

	test("drops every value that would make the browser fetch", () => {
		for (const bad of [
			"url(https://tracker.test/p.png)",
			"URL('https://tracker.test/p.png')",
			"url ( https://tracker.test/p.png )",
			"image-set(https://tracker.test/p.png 1x)",
			"linear-gradient(#111, #222), url(https://tracker.test/p.png)",
			"cross-fade(url(https://tracker.test/p.png), red)",
			"expression(alert(1))",
		]) {
			expect(safeCssBackground(bad)).toBeNull();
		}
	});

	test("treats blank and absent alike", () => {
		expect(safeCssBackground("   ")).toBeNull();
		expect(safeCssBackground(null)).toBeNull();
		expect(safeCssBackground(undefined)).toBeNull();
	});
});
