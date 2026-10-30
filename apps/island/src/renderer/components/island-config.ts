import type { Transition } from "motion/react";
import type { CSSProperties } from "react";
import type { IslandMaterialContour } from "../../shared/ipc.ts";
import {
	type IslandAlign,
	type IslandPlacement,
	TRANSLUCENT_WINDOW_INSET,
} from "../../shared/placement.ts";
import type { IslandState } from "../store/island-state.ts";

/** Target footprint (in px) of an island shape. */
export interface IslandSize {
	height: number;
	/** Corner radius; the pill is fully rounded, the panel is softly rounded. */
	radius: number;
	width: number;
}

/**
 * The leading logo island. A fixed small circle that is always present (except
 * in the full-screen `expanded` chat). Tapping it splits the detail island out
 * beside it (Dynamic-Island "split" morph) and folds it back.
 */
export const LOGO_CIRCLE: IslandSize = {
	width: 40,
	height: 40,
	radius: 20,
} as const;

/** Gap (px) between the logo circle and the detail island when split apart. */
export const SPLIT_GAP = 8;

/** States in which a detail island is shown beside (or instead of) the logo. */
export type DetailState = Exclude<IslandState, "collapsed">;

/**
 * The trailing "detail" island that splits out from the logo circle. It carries
 * the text label (`idle`/`context`), the proactive suggestion chip, or the full
 * chat panel (`expanded`). `collapsed` has none — only the circle shows.
 *
 * Widths are tuned so the circle + gap + detail fits inside the window
 * (`PANEL_WIDTH` in `main/window.ts`); the circle stays docked to the detail's
 * left in every state, including `expanded`, so the window must hold
 * circle + gap + panel.
 */
export const DETAIL_SIZES = {
	idle: { width: 96, height: 40, radius: 20 },
	context: { width: 200, height: 40, radius: 20 },
	recording: { width: 200, height: 40, radius: 20 },
	// The chip carries the title, body and its one row of actions (Accept,
	// Dismiss, More); it measures its content and grows past this floor.
	suggestion: { width: 300, height: 62, radius: 20 },
	// `rounded-2xl`: the one radius the open widget and the Island panel share.
	expanded: { width: 400, height: 480, radius: 16 },
} satisfies Record<DetailState, IslandSize>;

/**
 * The heights above are *floors*, not fixed sizes. Each pill measures the natural
 * height of its content (`useContentHeight`) and grows past its floor when the
 * content needs more than the single row it was tuned for — a wrapping app name, a
 * multi-line suggestion body, a long voice error. Past `DETAIL_MAX_H` it stops
 * growing and the content scrolls inside the shape, mirroring what the expanded
 * compact bar does with the composer.
 */
/** Vertical padding (px) added around measured pill content. */
export const DETAIL_CONTENT_VPAD = 16;
/** Ceiling (px): past this a pill's content scrolls instead of growing the shape. */
export const DETAIL_MAX_H = 200;

/**
 * Height (px) for a pill whose content measures `contentHeight`: its base height
 * while the content fits, growing to hold the content, capped at `DETAIL_MAX_H`.
 * A `contentHeight` of 0 means "not measured yet" (nothing mounted), so the base
 * height stands rather than collapsing the shape.
 */
export function pillHeight(base: number, contentHeight: number): number {
	if (contentHeight <= 0) {
		return base;
	}
	return Math.min(
		DETAIL_MAX_H,
		Math.max(base, contentHeight + DETAIL_CONTENT_VPAD)
	);
}

/** Whether measured content exceeds what the pill is allowed to grow to. */
export function pillOverflows(contentHeight: number): boolean {
	return (
		contentHeight > 0 && contentHeight + DETAIL_CONTENT_VPAD > DETAIL_MAX_H
	);
}

/**
 * The expanded island when there is nothing to show but the composer: a short,
 * wide input bar (just the blended text input + the inbox button). It grows to
 * the full `DETAIL_SIZES.expanded` height only once there is chat history (or the
 * inbox is open) — so an empty expand is a tidy bar, not a tall empty panel.
 *
 * The height is dynamic: it tracks the composer's measured height (so a multi-row
 * draft grows the bar) plus the content padding, clamped between MIN (a single
 * row) and MAX (a few rows, after which the textarea scrolls internally).
 */
export const EXPANDED_COMPACT_WIDTH = 400;
export const EXPANDED_COMPACT_RADIUS = 16;
/** Vertical padding (px) added around the composer — matches the content `py-2`. */
export const EXPANDED_COMPACT_VPAD = 16;
/** The chat's `h-10` header plus the `gap-2` under it, above the composer. */
export const EXPANDED_COMPACT_HEADER = 48;
/** Floor: a single composer row. */
export const EXPANDED_COMPACT_MIN_H = 44;
/** Ceiling: after this the textarea scrolls instead of growing the island. */
export const EXPANDED_COMPACT_MAX_H = 140;

/** Native blur follows each painted shape, leaving the split gaps transparent. */
export function islandMaterialContours(
	showCircle: boolean,
	detail: IslandSize | null,
	_state: IslandState
): IslandMaterialContour[] {
	const contours: IslandMaterialContour[] = [];
	if (showCircle) {
		contours.push({ x: 0, y: 0, ...LOGO_CIRCLE });
	}
	if (detail) {
		contours.push({
			x: showCircle ? LOGO_CIRCLE.width + SPLIT_GAP : 0,
			y: 0,
			...detail,
		});
	}
	return contours;
}

/**
 * The quick-action islands that split out to the RIGHT of the input in text mode
 * (the expanded composer): separate round contours the same size as the logo circle
 * (mic / attach / command). Each is a sibling shape of the detail island — outside
 * its clip, with its own ring + shadow + blur — and they overlap each other like
 * an avatar group (so part of each still shows), reading as a little stack of
 * islands beside the composer. They morph open with the same width-grow the detail
 * island uses splitting out of the logo from idle.
 */
export const ACTION_CIRCLE: IslandSize = {
	width: LOGO_CIRCLE.width,
	height: LOGO_CIRCLE.height,
	radius: LOGO_CIRCLE.radius,
} as const;
/** How much each action circle overlaps the previous one (avatar-group stack). */
export const ACTION_OVERLAP = 16;

/**
 * Width (px) of the avatar-group action stack for a given button count: the first
 * circle shows in full, each subsequent one adds only the non-overlapping sliver.
 */
export function actionDockWidth(count: number): number {
	if (count <= 0) {
		return 0;
	}
	return (
		ACTION_CIRCLE.width + (count - 1) * (ACTION_CIRCLE.width - ACTION_OVERLAP)
	);
}

/**
 * Shared spring used for the morph. Matches skiper-ui Skiper3's Apple play
 * button feel: a low-bounce spring that settles quickly without overshoot jank.
 */
export const ISLAND_SPRING: Transition = {
	type: "spring",
	bounce: 0.16,
	duration: 0.5,
} as const;

/** Cross-fade transition for the content swapped inside the morphing shell. */
export const CONTENT_SPRING: Transition = {
	type: "spring",
	bounce: 0.12,
	duration: 0.35,
} as const;

/** Flex main-axis (horizontal) alignment per placement axis. */
const JUSTIFY_BY_ALIGN: Record<IslandAlign, string> = {
	start: "justify-start",
	center: "justify-center",
	end: "justify-end",
};

/** Flex cross-axis (vertical) alignment per placement axis. */
const ITEMS_BY_ALIGN: Record<IslandAlign, string> = {
	start: "items-start",
	center: "items-center",
	end: "items-end",
};

/**
 * Classes that align the island group inside its window to the placement, so a
 * morph grows away from the anchored corner instead of from the window center.
 */
export function placementAlignClass(placement: IslandPlacement): string {
	return `${JUSTIFY_BY_ALIGN[placement.h]} ${ITEMS_BY_ALIGN[placement.v]}`;
}

/**
 * Padding of the fixed-size translucent window around the aligned group. Main
 * positions the window with the same insets (`shared/placement.ts`), so the two
 * must come from one constant.
 */
export const TRANSLUCENT_INSET_STYLE: CSSProperties = {
	paddingTop: TRANSLUCENT_WINDOW_INSET.top,
	paddingRight: TRANSLUCENT_WINDOW_INSET.right,
	paddingBottom: TRANSLUCENT_WINDOW_INSET.bottom,
	paddingLeft: TRANSLUCENT_WINDOW_INSET.left,
};
