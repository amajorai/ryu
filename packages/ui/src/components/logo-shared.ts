import type React from "react";

export interface LogoDimensionsStyle extends React.CSSProperties {
	"--logo-size": string;
}
export interface LogoClipStyle extends React.CSSProperties {
	"--logo-clip": string;
}
export interface LogoMaterialStyle extends LogoDimensionsStyle, LogoClipStyle {
	"--animation-duration": string;
	"--bg": string;
	"--blur-amount": string;
	"--c1": string;
	"--c2": string;
	"--c3": string;
	"--contrast-amount": number;
	"--dot-size": string;
	"--mask-radius": string;
	"--shadow-spread": string;
}

// Declared in logo.tsx, where the UI docs generator reads the component props.
import type { LogoProps } from "./logo.tsx";

export type { LogoProps };

/** A gaze offset in SVG units, applied to both eyes. */
export interface EyePosition {
	x: number;
	y: number;
}

/** Callback ref for the element the eyes track the pointer from. */
export type OrbRef = React.Ref<HTMLDivElement>;

export const isExpressiveVariant = (variant: LogoProps["variant"]): boolean =>
	variant === "expressive" || variant === "outline-muted";

/** Rendered size in px parsed from a `NNpx` size string. */
export const parseLogoSize = (size: string): number =>
	Number.parseInt(size.replace("px", ""), 10);

/**
 * Shared ghost path d-string (no path() wrapper), scaled from the 24-unit
 * source geometry. Used for the SVG path and the clip-path.
 */
export const ghostPathD = (scaleFactor: number): string =>
	`M${12 * scaleFactor},${24 * scaleFactor}c${9.2 * scaleFactor},0,${12.9 * scaleFactor}-${4.8 * scaleFactor},${12.4 * scaleFactor}-${14.6 * scaleFactor}C${24.1 * scaleFactor},${0.3 * scaleFactor},${12.8 * scaleFactor}-${3.7 * scaleFactor},${8.8 * scaleFactor},${5.4 * scaleFactor}c-${2.2 * scaleFactor},${5.7 * scaleFactor},${1.1 * scaleFactor},${7.9 * scaleFactor}-${2.9 * scaleFactor},${12.6 * scaleFactor}c-${0.9 * scaleFactor},${1.1 * scaleFactor}-${1.8 * scaleFactor},${2 * scaleFactor}-${2.7 * scaleFactor},${3.1 * scaleFactor}c-${1.2 * scaleFactor},${1.3 * scaleFactor},${0.7 * scaleFactor},${2.2 * scaleFactor},${1.9 * scaleFactor},${2.2 * scaleFactor}C${7.4 * scaleFactor},${23.3 * scaleFactor},${9.7 * scaleFactor},${24 * scaleFactor},${12 * scaleFactor},${24 * scaleFactor}z`;

// Corner-mask radius for the default variant's dotted overlay, widening with the
// rendered size. Extracted from `Logo` to keep its cognitive complexity in budget.
export const computeMaskRadius = (sizeValue: number): string => {
	if (sizeValue < 30) {
		return "0%";
	}
	if (sizeValue < 50) {
		return "5%";
	}
	if (sizeValue < 100) {
		return "15%";
	}
	return "25%";
};

export const computeFinalContrast = (
	sizeValue: number,
	contrastAmount: number
): number => {
	if (sizeValue < 30) {
		return 1.1;
	}
	if (sizeValue < 50) {
		return Math.max(contrastAmount * 1.2, 1.3);
	}
	return contrastAmount;
};
