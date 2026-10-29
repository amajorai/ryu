import type { CSSProperties } from "react";
import type { CinemaArtSpec, CinemaLight } from "./cinema-model.ts";

/**
 * Cinema's palette. Cinema commits to a dark screening room in every theme,
 * the way streaming catalogues do, so it sets its own surface tokens here and
 * keeps only the theme's primary (focus rings, progress). Key art is coloured
 * by each title's lead agent, using the same hue as that agent's avatar.
 *
 * This is the one Cinema file allowed to spell color functions.
 */
export const CINEMA_SURFACE = {
	"--accent": "oklch(0.27 0.004 286)",
	"--accent-foreground": "oklch(0.97 0 0)",
	"--background": "oklch(0.155 0.003 286)",
	"--border": "oklch(1 0 0 / 0.12)",
	"--card": "oklch(0.2 0.004 286)",
	"--card-foreground": "oklch(0.97 0 0)",
	"--destructive": "oklch(0.66 0.2 25)",
	"--foreground": "oklch(0.97 0 0)",
	"--input": "oklch(1 0 0 / 0.16)",
	"--muted": "oklch(0.25 0.004 286)",
	"--muted-foreground": "oklch(0.74 0.004 286)",
	"--popover": "oklch(0.2 0.004 286)",
	"--popover-foreground": "oklch(0.97 0 0)",
	"--ring": "oklch(0.92 0 0)",
	"--secondary": "oklch(0.27 0.004 286)",
	"--secondary-foreground": "oklch(0.97 0 0)",
	"--success": "oklch(0.72 0.17 150)",
	"--success-foreground": "oklch(0.18 0.03 150)",
	colorScheme: "dark",
} as CSSProperties;

/** Where each lighting set-up puts its key light, in percent of the frame. */
const LIGHT_AT: Record<CinemaLight, { x: number; y: number }> = {
	"lower-right": { x: 88, y: 92 },
	"upper-left": { x: 12, y: 8 },
	"upper-right": { x: 84, y: 10 },
};

/** What the key art is drawn for: a 16:9 card, a 2:3 poster, or the billboard. */
export type CinemaFrame = "card" | "hero" | "poster";

/**
 * Yellows and limes only read as themselves when they are light; at the
 * depths a dark field needs they turn olive. Lift them so every agent's
 * colour stays recognisable.
 */
function lift(spec: CinemaArtSpec, lightness: number): number {
	if (spec.neutral || lightness < 0.4) {
		return lightness;
	}
	const distance = Math.abs(((spec.hue - 100 + 540) % 360) - 180);
	const boost = Math.max(0, 1 - distance / 50) * 0.14;
	return Math.min(0.95, lightness + boost);
}

function toneAlpha(
	spec: CinemaArtSpec,
	lightness: number,
	chroma: number,
	alpha = 1
): string {
	const scaled = spec.neutral ? chroma * 0.08 : chroma;
	const level = lift(spec, lightness).toFixed(3);
	const color = `${level} ${scaled.toFixed(3)} ${spec.hue.toString()}`;
	return alpha === 1
		? `oklch(${color})`
		: `oklch(${color} / ${alpha.toString()})`;
}

function tone(spec: CinemaArtSpec, lightness: number, chroma: number): string {
	return toneAlpha(spec, lightness, chroma);
}

/**
 * The lit field behind a title: a key light in the agent's colour falling
 * into deep shade, with a cooler rim from the opposite side.
 */
export function cinemaField(spec: CinemaArtSpec, frame: CinemaFrame): string {
	const light =
		frame === "hero"
			? { x: 74, y: 30 }
			: (LIGHT_AT[spec.light] ?? LIGHT_AT["upper-right"]);
	const rimX = 100 - light.x;
	const rimY = 100 - light.y;
	const reach = frame === "hero" ? "60% 80%" : "85% 95%";
	return [
		`radial-gradient(${reach} at ${light.x.toString()}% ${light.y.toString()}%, ${tone(spec, 0.6, 0.16)} 0%, ${toneAlpha(spec, 0.42, 0.13, 0.55)} 38%, transparent 72%)`,
		`radial-gradient(60% 70% at ${rimX.toString()}% ${rimY.toString()}%, ${toneAlpha(spec, 0.34, 0.06, 0.45)} 0%, transparent 70%)`,
		`linear-gradient(180deg, ${tone(spec, 0.22, 0.03)} 0%, ${tone(spec, 0.13, 0.012)} 100%)`,
	].join(", ");
}

/** The monogram's fill: lit at the top, falling into the shade at its foot. */
export function cinemaMonogramFill(spec: CinemaArtSpec, quiet = false): string {
	const top = quiet ? 0.26 : 0.62;
	const middle = quiet ? 0.1 : 0.26;
	return `linear-gradient(180deg, ${toneAlpha(spec, 0.86, 0.11, top)} 0%, ${toneAlpha(spec, 0.7, 0.14, middle)} 50%, ${toneAlpha(spec, 0.5, 0.1, 0.02)} 100%)`;
}

/** The billboard's wall of title type: lit where the key light falls. */
export function cinemaWallFill(spec: CinemaArtSpec): string {
	return `linear-gradient(200deg, ${toneAlpha(spec, 0.88, 0.1, 0.55)} 0%, ${toneAlpha(spec, 0.68, 0.15, 0.3)} 40%, ${toneAlpha(spec, 0.45, 0.1, 0.06)} 85%)`;
}

/** The thin outline echo that sits just off the monogram. */
export function cinemaMonogramLine(spec: CinemaArtSpec, quiet = false): string {
	return toneAlpha(spec, 0.85, 0.12, quiet ? 0.12 : 0.22);
}

/** Shade that keeps the title legible where it sits on the art. */
export function cinemaShade(direction: "bottom" | "left" | "top"): string {
	const deep = "oklch(0.12 0.003 286 / 0.88)";
	const clear = "oklch(0.12 0.003 286 / 0)";
	if (direction === "left") {
		return `linear-gradient(90deg, ${deep} 0%, oklch(0.12 0.003 286 / 0.55) 40%, ${clear} 72%)`;
	}
	if (direction === "top") {
		return `linear-gradient(180deg, ${deep} 0%, ${clear} 55%)`;
	}
	return `linear-gradient(0deg, ${deep} 0%, oklch(0.12 0.003 286 / 0.3) 38%, ${clear} 62%)`;
}

/** The agent colour as type: the kicker over each title. */
export function cinemaAgentInk(spec: CinemaArtSpec): string {
	return spec.neutral ? "oklch(0.8 0 0)" : tone(spec, 0.82, 0.12);
}
