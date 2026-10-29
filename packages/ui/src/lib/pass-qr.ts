import { hueFill } from "../components/dither-kit/pixel.ts";

export interface PassQrColors {
	foreground: string;
	glow: string;
	surface: string;
}

type Rgb = readonly [number, number, number];

const hex = ([red, green, blue]: Rgb): string =>
	`#${[red, green, blue]
		.map((channel) => channel.toString(16).padStart(2, "0"))
		.join("")}`;

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [
	Math.round(from[0] + (to[0] - from[0]) * amount),
	Math.round(from[1] + (to[1] - from[1]) * amount),
	Math.round(from[2] + (to[2] - from[2]) * amount),
];

/**
 * A QR palette that borrows the pass's seeded hue without sacrificing the
 * luminance contrast a camera needs. The surface is a quiet tint of the card
 * face; the modules move only a fifth of the way toward that hue, keeping the
 * code integrated rather than pasted on.
 */
export function passQrColors(hue: number, isDark: boolean): PassQrColors {
	const accent = hueFill(hue);
	const surface = mix(isDark ? [39, 40, 46] : [249, 250, 252], accent, 0.16);
	const foreground = mix(isDark ? [246, 249, 255] : [17, 20, 28], accent, 0.22);

	return {
		foreground: hex(foreground),
		glow: `rgba(${accent.join(",")}, ${isDark ? "0.24" : "0.14"})`,
		surface: hex(surface),
	};
}
