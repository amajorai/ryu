import { type CapturedFrame, rgbToHex } from "@opentui/core";

// WCAG 2.x relative-luminance contrast, shared by the theme-token guard and the
// rendered-frame checks that prove muted text is actually legible on screen.
export const MIN_TEXT_CONTRAST = 4.5;

function channel(value: number): number {
	const scaled = value / 255;
	return scaled <= 0.039_28
		? scaled / 12.92
		: ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
	const digits = hex.replace("#", "");
	const red = Number.parseInt(digits.slice(0, 2), 16);
	const green = Number.parseInt(digits.slice(2, 4), 16);
	const blue = Number.parseInt(digits.slice(4, 6), 16);
	return (
		0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
	);
}

export function contrastRatio(first: string, second: string): number {
	const a = luminance(first);
	const b = luminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Find the first rendered span whose text contains `label` and return the
 * contrast between its painted foreground and background colours.
 */
export function renderedContrast(frame: CapturedFrame, label: string): number {
	for (const line of frame.lines) {
		for (const span of line.spans) {
			if (span.text.includes(label)) {
				return contrastRatio(rgbToHex(span.fg), rgbToHex(span.bg));
			}
		}
	}
	throw new Error(`No rendered span contains "${label}"`);
}
