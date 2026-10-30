"use client";
import {
	BANNER_COLORS,
	BANNER_DIRECTIONS,
	BANNER_PRESETS,
	type BannerColor,
	type BannerPreset,
	bannerGradientCss,
	bannerPresetById,
	DITHER_BANNER_PRESET_ID,
} from "@ryu/ui/components/banner-presets";
import {
	DitherGradient,
	type GradientDirection,
} from "@ryu/ui/components/dither-kit/gradient";
import type { DitherColor } from "@ryu/ui/components/dither-kit/palette";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties } from "react";
import styles from "./agent-banner-dialog.module.css";
import type { AgentBannerPrefs } from "./agent-banner-dialog-prefs.ts";

/** The slab the wash is painted over — the banner's own base, so the dialog's
 *  preview is the real thing rather than an approximation of it. */
export const AGENT_BANNER_BASE =
	"linear-gradient(135deg, hsl(222 18% 7%), hsl(222 12% 13%) 58%, hsl(224 10% 22%))";

/** Swatch fills for the colour picker — indicative only for the dither style,
 *  whose real fill is a dithered canvas that cannot be shown in a 16px dot. */
export const BANNER_SWATCHES = {
	purple: "#b497cf",
	blue: "#7aa2f7",
	green: "#9ece6a",
	pink: "#e39ac7",
	orange: "#e0a363",
	red: "#e06c75",
	grey: "#9aa0a6",
} satisfies Record<DitherColor, string>;

/** Stable 32-bit hash of a string — same seed in, same banner out. */
function bannerHash(seed: string): number {
	let h = 2_166_136_261;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16_777_619);
	}
	return Math.abs(h);
}

/** Hex (#rrggbb) → hue, so the shared color picker can drive the wash. Only the
 *  hue is kept: saturation and lightness come from the style itself, which is
 *  what keeps a custom colour looking like part of the same system. */
export function hexToHue(hex: string): number {
	const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
	if (!m?.[1]) {
		return 0;
	}
	const n = Number.parseInt(m[1], 16);
	const r = ((n >> 16) & 255) / 255;
	const g = ((n >> 8) & 255) / 255;
	const b = (n & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	if (d === 0) {
		return 0;
	}
	let h: number;
	if (max === r) {
		h = ((g - b) / d) % 6;
	} else if (max === g) {
		h = (b - r) / d + 2;
	} else {
		h = (r - g) / d + 4;
	}
	return Math.round((((h * 60) % 360) + 360) % 360);
}

/** Hue → hex, so the colour input shows the currently-selected custom hue. */
export function bannerSwatchHex(color: BannerColor): string {
	return isNativeNumber(color) ? hueToHex(color) : BANNER_SWATCHES[color];
}

export function hueToHex(hue: number): string {
	const h = ((hue % 360) + 360) % 360;
	const s = 0.85;
	const l = 0.58;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] =
		h < 60
			? [c, x, 0]
			: h < 120
				? [x, c, 0]
				: h < 180
					? [0, c, x]
					: h < 240
						? [0, x, c]
						: h < 300
							? [x, 0, c]
							: [c, 0, x];
	const to = (v: number) =>
		Math.round((v + m) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${to(r)}${to(g)}${to(b)}`;
}

/** Everything needed to paint one banner, with every default already resolved. */
export interface ResolvedAgentBanner {
	color: BannerColor;
	direction: GradientDirection;
	preset: BannerPreset;
}

/**
 * Fold the stored prefs (and any explicit prop override) onto the per-agent
 * deterministic default. "Random" here means DETERMINISTICALLY random: colour
 * and direction are derived from the agent name, so every agent gets a different
 * wash but the same agent looks the same on every render and every machine.
 */
export function resolveAgentBanner(
	agent: string,
	prefs: AgentBannerPrefs,
	overrides?: { color?: BannerColor; direction?: GradientDirection }
): ResolvedAgentBanner {
	const color =
		overrides?.color ??
		prefs.color ??
		BANNER_COLORS[bannerHash(agent) % BANNER_COLORS.length];
	const direction =
		overrides?.direction ??
		prefs.direction ??
		BANNER_DIRECTIONS[bannerHash(`${agent}:dir`) % BANNER_DIRECTIONS.length];
	const preset =
		bannerPresetById(prefs.preset) ??
		bannerPresetById(DITHER_BANNER_PRESET_ID) ??
		BANNER_PRESETS[0];
	if (color === undefined || direction === undefined || preset === undefined) {
		throw new Error("Agent banner presets are unavailable");
	}
	return { color, direction, preset };
}

/**
 * The wash itself — the single painter for every banner surface, so the header,
 * the dialog preview, and the style tiles cannot disagree about what a preset
 * looks like. A gradient preset paints as CSS; the dither preset paints on
 * dither-kit's canvas.
 */
export interface BannerPaintStyle extends CSSProperties {
	"--agent-banner-opacity"?: number;
	"--agent-banner-paint"?: string;
	"--agent-banner-swatch"?: string;
}
export function AgentBannerWash({
	banner,
	className,
	opacity = 0.55,
}: {
	banner: ResolvedAgentBanner;
	className?: string;
	opacity?: number;
}) {
	const gradient = bannerGradientCss(banner.preset, banner.color);
	if (gradient) {
		return (
			<div
				aria-hidden
				className={cn("absolute inset-0", styles.wash, className)}
				style={
					{
						"--agent-banner-paint": gradient,
						"--agent-banner-opacity": opacity,
					} satisfies BannerPaintStyle as BannerPaintStyle
				}
			/>
		);
	}
	return (
		<DitherGradient
			className={cn("absolute inset-0", className)}
			direction={banner.direction}
			from={banner.color}
			opacity={opacity}
		/>
	);
}

/** Feather the profile banner into the card surface below it. */
export function AgentProfileBannerFade() {
	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-card via-card/70 to-transparent"
		/>
	);
}
