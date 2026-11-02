// Palette, font and measuring helpers shared by every pass face. Split from
// `paint.ts`, which re-exports them.

import { FIT_STEP_PX } from "../waitlist-pass.tsx";

export interface PassPalette {
	border: string;
	card: string;
	cardForeground: string;
	mutedForeground: string;
	primary: string;
}

/**
 * Resolve the design tokens the card uses into something canvas accepts.
 *
 * Read off a probe element rather than `getPropertyValue("--card")`, because
 * the raw custom property in this repo is an `oklch(...)` string that older
 * canvas implementations reject outright — and because the probe picks up
 * whichever theme class is actually on the tree, so a card drawn while the app
 * is in dark mode comes out dark without being told.
 */
export function readPassPalette(host: HTMLElement): PassPalette {
	const probe = document.createElement("div");
	probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden";
	host.appendChild(probe);
	const read = (token: string): string => {
		probe.style.color = "";
		probe.style.color = `var(${token})`;
		const value = getComputedStyle(probe).color;
		// An unresolvable token leaves `color` at its inherited value rather than
		// erroring, so a token that has been renamed shows up as the wrong colour
		// instead of a crash. Both are wrong; a visible black is the easier one to
		// spot in review.
		return value || "#000000";
	};
	const palette: PassPalette = {
		border: read("--border"),
		card: read("--card"),
		cardForeground: read("--card-foreground"),
		mutedForeground: read("--muted-foreground"),
		primary: read("--primary"),
	};
	probe.remove();
	return palette;
}

/** The face's own font stack — whatever the app actually loaded, not a guess. */
export function readPassFontFamily(host: HTMLElement): string {
	return getComputedStyle(host).fontFamily || "system-ui, sans-serif";
}

/** A canvas `font` string at the face's supersample. */
export const font = (
	family: string,
	weight: number,
	px: number,
	scale: number
): string => `${weight} ${px * scale}px ${family}`;

/**
 * `AutoFitText`, with `measureText` where the DOM had `scrollWidth`.
 *
 * Deliberately the same shape as the component: start at the ceiling, step down
 * by `FIT_STEP_PX` while the single line overruns, stop at the floor, and report
 * whether it still overruns there — which is the card's signal to wrap rather
 * than to shrink into the body copy.
 */
export function fitFontSize(
	ctx: CanvasRenderingContext2D,
	{
		available,
		family,
		maxPx,
		minPx,
		scale,
		stepPx = FIT_STEP_PX,
		text,
		trackingEm = 0,
		weight,
	}: {
		available: number;
		family: string;
		maxPx: number;
		minPx: number;
		scale: number;
		/** The ramp's step. Defaults to the waitlist card's; a face with its own
		 * `AutoFitText` step must pass that one or the two searches stop at
		 * different sizes for the same string. */
		stepPx?: number;
		text: string;
		trackingEm?: number;
		weight: number;
	}
) {
	let size = maxPx;
	const widthAt = (px: number): number => {
		ctx.font = font(family, weight, px, scale);
		setTracking(ctx, px * trackingEm * scale);
		return ctx.measureText(text).width;
	};
	while (size > minPx && widthAt(size) > available) {
		size = Math.max(minPx, size - stepPx);
	}
	return { size, wrapped: widthAt(size) > available };
}

/**
 * `ctx.letterSpacing` is recent (Chrome 99, Safari 17.4). Where it is missing
 * the card loses `tracking-tight` on the name, which is a fraction of a pixel
 * per glyph — not worth a manual per-glyph draw to recover.
 */
export function setTracking(ctx: CanvasRenderingContext2D, px: number): void {
	if ("letterSpacing" in ctx) {
		ctx.letterSpacing = `${px}px`;
	}
}

/** Greedy wrap, used only once the name has already bottomed out on its ramp. */
export function wrapLines(
	ctx: CanvasRenderingContext2D,
	text: string,
	available: number
): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const next = line ? `${line} ${word}` : word;
		if (line && ctx.measureText(next).width > available) {
			lines.push(line);
			line = word;
		} else {
			line = next;
		}
	}
	if (line) {
		lines.push(line);
	}
	return lines.length > 0 ? lines : [text];
}

/** A rounded rectangle path in the current transform. */
export function roundedRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	radius: number
): void {
	ctx.beginPath();
	ctx.roundRect(x, y, width, height, radius);
}

/**
 * The body's box on the face, in DEVICE px — the ring gutter, then `p-7`.
 *
 * Every face on this shell is laid out against the same four edges, so they are
 * computed once here rather than re-derived per painter. `available` is the
 * width a line of type has before it has to shrink or wrap.
 */
