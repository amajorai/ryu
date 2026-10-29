// packages/ui/src/components/banner-presets.ts
//
// The ONE catalog of banner styles a surface can offer a user: the generative
// dither wash the app has always painted, plus every gradient preset the shared
// animated-gradient table defines.
//
// It lives in `@ryu/ui` rather than next to either consumer because the two
// consumers cannot see each other. `packages/marketplace` depends on
// `@ryu/blocks`; `packages/blocks` does NOT depend on `@ryu/marketplace`, so a
// preset list defined in the marketplace package is structurally unreachable
// from the agent editor (which lives in blocks) — that is a dependency-graph
// fact, not a preference. `@ryu/ui` is the only package both already depend on.
//
// WHAT THIS FILE DOES NOT DO: define gradients. The gradient presets are
// `ANIMATED_GRADIENT_PRESETS` from `./motion/animated-gradient.tsx` — the same
// table the marketplace's listing banners paint from and the same one the WebGL
// shader reads. This module only ADAPTS them into a picker list and recolours
// them; adding a preset there adds it to the agent-banner dialog with no edit
// here, and there is exactly one place where "what does `prism` look like" is
// answered. A second, hand-rolled ramp table in this file would be the fork the
// shared table exists to prevent.
//
// The list is a discriminated union on `kind` so a surface can paint one without
// knowing which entry it got:
//
//   * `kind: "dither"` — painted with dither-kit's `DitherGradient` on a canvas.
//     One entry, because the dither style's variation is its COLOUR and
//     DIRECTION, not a per-variant recipe.
//   * `kind: "gradient"` — painted as a CSS background string from
//     `bannerGradientCss`.
//
// STATIC, NOT LIVE. `bannerGradientCss` returns the shader's static CSS
// approximation (`animatedGradientCss`), never a WebGL canvas. The agent-banner
// surfaces are a header, a dialog preview and a grid of style tiles — mounting a
// `<AnimatedGradient live>` for each would be ~8 GL contexts against a browser
// cap of ~16 that EVICTS the oldest to honour a new one, which is Sentry RUST-2A
// on this app. See that component's header; the rule there is that only a detail
// hero opts in, and a banner picker is not one.
//
// RECOLOURING. A gradient preset's three stops are literal colours, but the
// banner picker's colour control has to keep working across styles. So a preset
// is treated as a SHAPE plus a hue RELATIONSHIP: every stop is rotated by the
// same delta, taken from the preset's own signature stop to the user's chosen
// hue. Relative hue spacing, saturation and lightness all survive, so a
// recoloured `prism` still reads as prism — and a near-grey stop (`lava`'s
// near-black, `mist`'s off-white) barely moves, because rotating the hue of an
// unsaturated colour is close to a no-op. That is why the rotation is on hue
// alone and not a wholesale palette substitution.

import {
	isNativeNumber,
	isNativeText,
} from "../lib/native-primitive-observation.ts";
import type { GradientDirection } from "./dither-kit/gradient.tsx";
import { type DitherColor, PALETTE } from "./dither-kit/palette.ts";
import {
	ANIMATED_GRADIENT_PRESET_NAMES,
	ANIMATED_GRADIENT_PRESETS,
	type AnimatedGradientPreset,
	animatedGradientCss,
	isAnimatedGradientPreset,
	resolveAnimatedGradient,
} from "./motion/animated-gradient.tsx";

/** A banner colour: a dither-kit palette name, or a raw hue (0–360). Matches
 *  `PixelColor`, so it can be handed to `DitherGradient`'s `from` untouched. */
export type BannerColor = DitherColor | number;

/** The id of the built-in dither style. Exported because it is the DEFAULT a
 *  surface falls back to when no preset is stored, not because anyone should
 *  branch on it. */
export const DITHER_BANNER_PRESET_ID = "dither";

export interface BannerPreset {
	/** Stable id — what gets persisted. For a gradient this IS the shared
	 *  `AnimatedGradientPreset` name, so the two halves of the feature agree on
	 *  the vocabulary and a stored id means the same thing on both. */
	id: string;
	kind: "dither" | "gradient";
	/** Human label for the picker. */
	label: string;
}

/** `prism` → `Prism`. The shared table's names are the vocabulary; this is only
 *  their presentation, so a preset added there needs no label written here. */
const titleCase = (value: string): string =>
	value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Every style a banner can be painted in. Dither first: it is the default and
 * the one every existing agent already shows. The rest are the shared gradient
 * presets, in the shared table's own order.
 */
export const BANNER_PRESETS: readonly BannerPreset[] = [
	{ id: DITHER_BANNER_PRESET_ID, kind: "dither", label: "Dither" },
	...ANIMATED_GRADIENT_PRESET_NAMES.map(
		(name): BannerPreset => ({
			id: name,
			kind: "gradient",
			label: titleCase(name),
		})
	),
];

/** Look a preset up by its persisted id. Returns undefined for an id this build
 *  does not know — a stored preference from a newer build, or a hand-edited one.
 *  Callers fall back to the dither default rather than painting nothing. */
export const bannerPresetById = (
	id: string | null | undefined
): BannerPreset | undefined =>
	id ? BANNER_PRESETS.find((preset) => preset.id === id) : undefined;

/** True when `value` names a preset this build can paint. Persisted preferences
 *  MUST be run through this before they reach a renderer: dither-kit's `fillOf`
 *  throws on an unknown palette name, and the same class of bug (a stale id
 *  reaching a paint path) is what crashes an editor on open. */
export const isBannerPresetId = <T>(value: T): value is T & string =>
	isNativeText(value) && bannerPresetById(value) !== undefined;

/** The four directions a dither wash can run in. Re-exported here so a picker
 *  that already imports this module does not need a second import for the one
 *  control that is dither-specific. */
export const BANNER_DIRECTIONS: readonly GradientDirection[] = [
	"up",
	"down",
	"left",
	"right",
];

/** The palette colours offered as banner swatches. `grey` is deliberately
 *  absent: it is the charts' no-data fill, not a colour anyone picks. */
export const BANNER_COLORS: readonly DitherColor[] = [
	"purple",
	"blue",
	"green",
	"pink",
	"orange",
	"red",
];

interface Hsl {
	h: number;
	l: number;
	s: number;
}

/** rgb (0–1) → hsl, with `h` in degrees and `s`/`l` as 0–1. */
const rgbToHsl = (r: number, g: number, b: number): Hsl => {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	const l = (max + min) / 2;
	if (d === 0) {
		return { h: 0, l, s: 0 };
	}
	const s = d / (1 - Math.abs(2 * l - 1));
	let h: number;
	if (max === r) {
		h = ((g - b) / d) % 6;
	} else if (max === g) {
		h = (b - r) / d + 2;
	} else {
		h = (r - g) / d + 4;
	}
	return { h: (((h * 60) % 360) + 360) % 360, l, s };
};

/** `#rrggbb` (or `#rgb`) → hsl. Returns null for anything else, so a colour this
 *  cannot read is passed through untouched rather than turned into black. */
const hexToHsl = (hex: string): Hsl | null => {
	const raw = hex.trim().replace("#", "");
	const full =
		raw.length === 3
			? raw
					.split("")
					.map((c) => c + c)
					.join("")
			: raw;
	if (!/^[\da-f]{6}$/i.test(full)) {
		return null;
	}
	const n = Number.parseInt(full, 16);
	return rgbToHsl(
		((n >> 16) & 255) / 255,
		((n >> 8) & 255) / 255,
		(n & 255) / 255
	);
};

/** The base hue for a banner colour — a raw hue passes through, a palette name
 *  resolves to the hue of its chart fill so a gradient preset and a dither wash
 *  painted "purple" are the same purple. */
export const bannerColorHue = (color: BannerColor): number => {
	if (isNativeNumber(color)) {
		return ((color % 360) + 360) % 360;
	}
	const seed = PALETTE[color];
	if (!seed) {
		return 0;
	}
	const [r, g, b] = seed.fill;
	return rgbToHsl(r / 255, g / 255, b / 255).h;
};

/**
 * The preset's OWN hue — the anchor the user's hue is rotated onto.
 *
 * The most saturated stop wins, not the first one: several presets open on a
 * near-black or near-white stop whose hue is arbitrary (`lava`'s `#2a0a05`,
 * `mist`'s `#eef2f7`), and anchoring on one of those would rotate the ramp by a
 * meaningless amount and land the signature colour somewhere unrelated to what
 * the user picked.
 */
const presetAnchorHue = (stops: (Hsl | null)[]): number => {
	let best: Hsl | null = null;
	for (const stop of stops) {
		if (stop && (!best || stop.s > best.s)) {
			best = stop;
		}
	}
	return best?.h ?? 0;
};

const hslCss = ({ h, l, s }: Hsl, delta: number): string => {
	const hue = (((h + delta) % 360) + 360) % 360;
	return `hsl(${Math.round(hue)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
};

/**
 * Build the CSS background for a gradient preset at a given colour. Returns null
 * for a dither preset (which paints on a canvas, not in CSS) so a caller can use
 * the null as the "render the dither component instead" branch.
 *
 * The ramp, its angle, its midpoint and the two radial pools all come from
 * `animatedGradientCss`, so a banner and a marketplace card painted with the
 * same preset are the same picture. Only the three colours are ours.
 */
export const bannerGradientCss = (
	preset: BannerPreset,
	color: BannerColor
): string | null => {
	if (preset.kind !== "gradient" || !isAnimatedGradientPreset(preset.id)) {
		return null;
	}
	const name: AnimatedGradientPreset = preset.id;
	const base = ANIMATED_GRADIENT_PRESETS[name];
	const stops = [base.color1, base.color2, base.color3].map(hexToHsl);
	const delta = bannerColorHue(color) - presetAnchorHue(stops);
	const [color1, color2, color3] = stops.map((stop, index) =>
		stop
			? hslCss(stop, delta)
			: // Unreadable stop: keep the author's literal colour rather than
				// inventing one. Every preset in the table is plain hex today, so this
				// is a guard against a future entry, not a live path.
				[base.color1, base.color2, base.color3][index]
	);
	return animatedGradientCss(
		resolveAnimatedGradient({
			config: { color1, color2, color3 },
			preset: name,
		})
	);
};
