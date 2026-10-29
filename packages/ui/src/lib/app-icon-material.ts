import type { CSSProperties } from "react";
import { z } from "zod";

/** Shared by live tiles and the PNG exporter. Existing iconDither colors remain
 * the identity source; banners can still use their original dither treatment. */
const HUES = new Map([
	["green", 145],
	["blue", 212],
	["purple", 263],
	["pink", 322],
	["orange", 30],
	["red", 0],
	["grey", 240],
]);

const iconHueDegreesSchema = z.number().finite();
const iconHueTokenSchema = z.string();

export function normalizeIconHue(
	value: Parameters<typeof iconHueDegreesSchema.safeParse>[0]
): number | null {
	const degrees = iconHueDegreesSchema.safeParse(value);
	if (degrees.success) {
		return ((degrees.data % 360) + 360) % 360;
	}
	const token = iconHueTokenSchema.safeParse(value);
	return token.success ? (HUES.get(token.data) ?? null) : null;
}

export function iconSeedHue(seed: string): number {
	let hash = 2_166_136_261;
	for (const char of seed) {
		hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619);
	}
	return (hash >>> 0) % 360;
}

export interface IconMaterialInput {
	from?: unknown;
	seed: string;
	to?: unknown;
}

function color(h: number, saturation: number, lightness: number): string {
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = lightness - chroma / 2;
	const rgb =
		h < 60
			? [chroma, x, 0]
			: h < 120
				? [x, chroma, 0]
				: h < 180
					? [0, chroma, x]
					: h < 240
						? [0, x, chroma]
						: h < 300
							? [x, 0, chroma]
							: [chroma, 0, x];
	return `#${rgb
		.map((value) =>
			Math.round((value + m) * 255)
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
}

/** One vector material for browser tiles and raster exports. Coordinates scale
 * with the tile, so highlights remain proportional in a sidebar or at 1024px. */
export function appIconMaterialSvg(
	{ seed, from, to }: IconMaterialInput,
	appearance: "light" | "dark" | "mono" = "light"
): string {
	const primary = normalizeIconHue(from) ?? iconSeedHue(seed);
	const secondary = normalizeIconHue(to) ?? (primary + 24) % 360;
	const dark = appearance === "dark";
	const saturation = appearance === "mono" || from === "grey" ? 0 : 0.76;
	const top = color(primary, saturation, dark ? 0.31 : 0.5);
	const bottom = color(secondary, saturation, dark ? 0.14 : 0.3);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><defs><linearGradient id="base" x2="0" y2="1"><stop stop-color="${dark ? "#282a31" : appearance === "mono" ? "#fafafa" : "#fafbfe"}"/><stop offset="1" stop-color="${dark ? "#16171c" : appearance === "mono" ? "#e8e8e8" : "#e8ecf3"}"/></linearGradient></defs><rect width="256" height="256" rx="58" fill="url(#base)"/><circle cx="128" cy="128" r="82" fill="${top}" opacity=".15"/><circle cx="128" cy="128" r="64" fill="${bottom}" opacity=".12"/></svg>`;
}

export function appIconMaterial(
	input: IconMaterialInput,
	appearance: "light" | "dark" | "mono" = "light"
): CSSProperties {
	return {
		backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(appIconMaterialSvg(input, appearance))}")`,
		backgroundSize: "100% 100%",
		borderRadius: "24%",
	};
}

export const APP_ICON_FALLBACK_GLYPH: CSSProperties = {
	color: "currentColor",
};
