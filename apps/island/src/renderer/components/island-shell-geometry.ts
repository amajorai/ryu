import type { CSSProperties } from "react";
import type { IslandState } from "../store/island-state.ts";
import {
	ACTION_CIRCLE,
	type IslandSize,
	LOGO_CIRCLE,
	SPLIT_GAP,
} from "./island-config.ts";

// Keep one Island surface and add the top scrim as an overlay inside its shape.
// Translucent mode keeps its CSS glass blur; acrylic/mica keep the OS material
// supplied by the existing window underneath the same surface.
export interface IslandGeometryStyle extends CSSProperties {
	"--island-gap"?: string;
	"--island-surface-height"?: string;
	"--island-surface-radius"?: string;
	"--island-surface-width"?: string;
}
export const groupGeometryStyle: IslandGeometryStyle = {
	"--island-gap": `${SPLIT_GAP}px`,
};
export const notchSurfaceGeometryStyle: IslandGeometryStyle = {
	"--island-surface-radius": "0 0 24px 24px",
};
export const circleGeometryStyle: IslandGeometryStyle = {
	"--island-surface-width": `${LOGO_CIRCLE.width}px`,
	"--island-surface-height": `${LOGO_CIRCLE.height}px`,
	"--island-surface-radius": `${LOGO_CIRCLE.radius}px`,
};

// Every Island shape wears one hairline ring and (in Translucent mode) the one
// floating shadow. The fill is the popover token, so the Island follows the
// app's light or dark theme instead of a fixed black scrim.
export const SURFACE_BASE =
	"relative isolate shrink-0 overflow-hidden ring-1 ring-border";
export const TRANSLUCENT_SKIN = "text-foreground shadow-2xl backdrop-blur-2xl";
export const ACRYLIC_SKIN = "text-foreground";
/** The scrim layer as a token fill (solid under reduced transparency). */
export const TRANSLUCENT_SCRIM =
	"bg-popover/85 bg-none! [@media(prefers-reduced-transparency:reduce)]:bg-popover";
/** Native materials (acrylic, mica) already follow the OS theme: no scrim. */
export const NATIVE_SCRIM = "hidden";

/**
 * The visible footprint (bounding box) of the island group for a given state.
 * The action islands (`dockWidth > 0`, text mode only) sit to the RIGHT of the
 * detail island, widening the row by a gap + the avatar stack. Every other
 * state, the suggestion chip included (its actions sit inside it), is just the
 * logo + detail row.
 */
export function islandFootprint(
	showCircle: boolean,
	detail: IslandSize | null,
	_state: IslandState,
	dockWidth: number
) {
	const circleWidth = showCircle ? LOGO_CIRCLE.width : 0;
	const detailWidth = detail ? detail.width : 0;
	const gap = showCircle && detail ? SPLIT_GAP : 0;
	const dockGap = dockWidth > 0 ? SPLIT_GAP : 0;
	const topRowWidth = circleWidth + gap + detailWidth + dockGap + dockWidth;
	const circleHeight = showCircle ? LOGO_CIRCLE.height : 0;
	const detailHeight = detail ? detail.height : 0;
	const dockHeight = dockWidth > 0 ? ACTION_CIRCLE.height : 0;
	return {
		width: topRowWidth,
		height: Math.max(circleHeight, detailHeight, dockHeight),
	};
}

/** Drag/grab handle class for the detail island, by surface. */
export function detailHandleClassFor(
	isTextPill: boolean,
	state: IslandState,
	scrolls: boolean
): string | null {
	if (isTextPill) {
		// Text pill: the whole surface drags + taps-to-collapse (just a label) —
		// unless the label grew past the cap and now scrolls, in which case a full
		// cover would eat the wheel. Fall back to the expanded panel's top strip so
		// the body stays scrollable (and the strip still drags + taps).
		return scrolls ? STRIP_HANDLE : COVER_HANDLE;
	}
	if (state === "suggestion") {
		// No strip, so the chip stays fully clickable; the user drags via the logo.
		return null;
	}
	if (state === "expanded") {
		// Keep the expanded grab strip above the page header, not over its controls.
		return EXPANDED_HANDLE;
	}
	// Compact non-text surfaces keep the wider strip as their drag handle.
	return STRIP_HANDLE;
}

/**
 * Inner-content layout class for the detail island, by surface. The pill surfaces
 * scroll only once their content outgrows `DETAIL_MAX_H` — while the shape is still
 * growing to fit, the container is mid-spring at the *old* height with the content
 * already at full size, so a standing `overflow-y-auto` would flash a scrollbar on
 * every grow and shrink. Centering an overflowing scroll container also clips both
 * ends (the top can never be scrolled to), so the same flag top-aligns it.
 */
export function detailContentClassFor(
	isExpanded: boolean,
	state: IslandState,
	scrolls: boolean
): string {
	if (isExpanded) {
		return "flex h-full w-full items-stretch px-3 py-2";
	}
	const scroll = scrolls
		? "items-start overflow-y-auto"
		: "items-center overflow-hidden";
	if (state === "suggestion") {
		return `flex h-full w-full px-3 ${scroll}`;
	}
	return `flex h-full w-full justify-center px-4 ${scroll}`;
}

export const COVER_HANDLE =
	"absolute inset-0 z-10 cursor-grab bg-transparent active:cursor-grabbing";
export const STRIP_HANDLE =
	"absolute inset-x-0 top-0 z-10 h-9 w-full cursor-grab bg-transparent active:cursor-grabbing";
export const EXPANDED_HANDLE =
	"absolute inset-x-0 top-0 z-10 h-3 w-full cursor-grab bg-transparent active:cursor-grabbing";
