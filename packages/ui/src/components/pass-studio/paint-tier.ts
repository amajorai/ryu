/**
 * The paid-tier card's type layer, and the backdrop it is printed on.
 *
 * A sibling of `waitlistFacePainter`, not a fork of it: the box, the header
 * lockup, the stat pair and every measuring helper come from `paint.ts`, and the
 * type ramp comes from `tier-pass.tsx`. This file owns the ORDER those things
 * are stacked in and nothing else, because it is a mirror — `TierPass` is the
 * live card and the authority on its layout. A change to what the card says
 * belongs in `tier-pass.tsx` first and here second; a bespoke measurement here
 * would desync the export from the card it is a picture of, which is the exact
 * failure `paint.ts`'s no-independent-constants rule exists to prevent.
 *
 * The tier's colour enters through the BACKDROP stops and the foil, never
 * through the type. Card body type is `palette.cardForeground`, exactly as the
 * waitlist face's is: `TIER_STYLES.ink` is calibrated for AA contrast on an
 * opaque badge plinth, and on a `bg-card` face under a 30-55% shader it is
 * either invisible (`pro`'s near-black on a dark card) or simply the wrong
 * colour for body copy.
 */

import {
	type PlanTier,
	planTierColors,
	planTierLabel,
} from "../plan-badge.tsx";
import {
	TIER_FIT_STEP_PX,
	TIER_HOLDER_MAX_PX,
	TIER_HOLDER_MIN_PX,
	TIER_LABEL_MAX_PX,
	TIER_LABEL_MIN_PX,
	TIER_META_PX,
	TIER_STAT_VALUE_PX,
	TIER_WARP_OPACITY,
	tierWarpColors,
} from "../tier-pass.tsx";
import {
	BLOCK_GAP_PX,
	fitFontSize,
	font,
	HERO_GAP_PX,
	type PassFaceEnv,
	type PassFacePainter,
	paintPassHeader,
	paintPassStat,
	passFaceBox,
	setTracking,
	wrapLines,
} from "./paint.ts";
import { BACKDROP_WASH_ALPHA, type PassBackdropSpec } from "./scene.ts";

/** `tracking-tight` on the tier label, as `TierPass` sets it. */
const LABEL_TRACKING_EM = -0.025;
/** `leading-[1.02]` on the hero lines. */
const HERO_LINE_HEIGHT = 1.02;
/**
 * `gap-3` between the footer's two `grid-cols-2` columns, resolved at the app's
 * 16px root — the same treatment `CARD_WIDTH_PX` / `CARD_HEIGHT_PX` get, and the
 * only figure in this file with no constant to import.
 */
const STAT_COLUMN_GAP_PX = 12;
/** What the live card prints when it has no date to print. */
const NO_DATE = "—";

export interface TierFaceContent {
	/** Falsy prints an unpersonalised specimen — a card with no name on it. */
	holder?: string | null;
	plan: PlanTier;
	/** Already formatted, e.g. "Aug 2026". Printed verbatim. */
	since?: string | null;
}

/**
 * The tier card, as a painter. Same three blocks as the waitlist pass, built in
 * the same order and for the same reason: the footer is measured first because
 * the hero above it is bottom-aligned against whatever the footer leaves.
 */
export function tierFacePainter(content: TierFaceContent): PassFacePainter {
	return {
		front: (ctx, env) => paintTierFront(ctx, content, env),
	};
}

function paintTierFront(
	ctx: CanvasRenderingContext2D,
	content: TierFaceContent,
	env: PassFaceEnv
): void {
	const { family, palette, scale } = env;
	const { available, bottom, left } = passFaceBox(scale);
	const label = planTierLabel(content.plan);

	// The lockup alone. No date opposite it, unlike the waitlist face: on this
	// card the join date is a LABELLED field in the footer, and the same fact
	// printed twice on a 320px card reads as a layout that lost track of itself.
	ctx.textBaseline = "alphabetic";
	paintPassHeader(ctx, env);

	// `grid grid-cols-2 gap-3`: two equal columns, so the second starts at the
	// halfway mark rather than after whatever width the first happened to take,
	// and each is cut to its own column exactly as the live stat's `truncate` is.
	const gap = STAT_COLUMN_GAP_PX * scale;
	const column = (available - gap) / 2;
	const stat = (columnLabel: string, value: string, x: number): number =>
		paintPassStat(ctx, env, {
			baseline: bottom,
			label: columnLabel,
			labelPx: TIER_META_PX,
			maxWidth: column,
			value,
			valuePx: TIER_STAT_VALUE_PX,
			x,
		});
	const statTop = stat("Plan", label, left);
	// Always drawn, em-dash and all. An absent second column would let the grid
	// re-read as a single left-aligned fact, which is a different card.
	stat("Member since", content.since?.trim() || NO_DATE, left + column + gap);
	const heroFloor = statTop - BLOCK_GAP_PX * scale;

	// Hero, built upward from that floor: the holder's name, then the tier label
	// above it. The label is the subject of this card — a tier is what the card
	// certifies — and the name is who it certifies it for.
	ctx.textAlign = "left";
	let cursor = heroFloor;
	const name = content.holder?.trim() ?? "";
	if (name) {
		const { size } = fitFontSize(ctx, {
			available,
			family,
			maxPx: TIER_HOLDER_MAX_PX,
			minPx: TIER_HOLDER_MIN_PX,
			scale,
			stepPx: TIER_FIT_STEP_PX,
			text: name,
			weight: 400,
		});
		ctx.font = font(family, 400, size, scale);
		setTracking(ctx, 0);
		ctx.fillStyle = palette.mutedForeground;
		ctx.fillText(name, left, cursor);
		cursor -= size * scale + HERO_GAP_PX * scale;
	}

	const { size: labelSize, wrapped } = fitFontSize(ctx, {
		available,
		family,
		maxPx: TIER_LABEL_MAX_PX,
		minPx: TIER_LABEL_MIN_PX,
		scale,
		stepPx: TIER_FIT_STEP_PX,
		text: label,
		trackingEm: LABEL_TRACKING_EM,
		weight: 600,
	});
	ctx.font = font(family, 500, labelSize, scale);
	setTracking(ctx, labelSize * LABEL_TRACKING_EM * scale);
	ctx.fillStyle = palette.cardForeground;
	// "Desktop" and "Enterprise" are long enough to bottom out on the ramp at the
	// card's width, and a truncated tier name is not the tier name.
	const lines = wrapped ? wrapLines(ctx, label, available) : [label];
	const lineHeight = labelSize * HERO_LINE_HEIGHT * scale;
	for (let i = lines.length - 1; i >= 0; i--) {
		ctx.fillText(lines[i] ?? "", left, cursor);
		cursor -= lineHeight;
	}
	setTracking(ctx, 0);
}

/**
 * `#rrggbb` as an `rgba()` string. Canvas gradient stops take eight-digit hex
 * in current browsers but not in every one that can still record a loop, and a
 * stop the parser rejects is silently dropped rather than thrown — which shows
 * up as a wash that is simply missing.
 */
function withAlpha(hex: string, alpha: number): string {
	const value = hex.replace("#", "");
	const full =
		value.length === 3
			? value
					.split("")
					.map((channel) => `${channel}${channel}`)
					.join("")
			: value;
	const channels = [0, 2, 4].map((at) =>
		Number.parseInt(full.slice(at, at + 2), 16)
	);
	if (channels.some(Number.isNaN)) {
		return hex;
	}
	return `rgba(${channels.join(", ")}, ${alpha})`;
}

/**
 * The tier's backdrop: the badge palette, in motion, behind the card.
 *
 * The shader stops are `tierWarpColors` verbatim, so the exported field is the
 * one the live `TierPass` is printed on. The foil takes the palette's middle
 * stop rather than the brand primary — on a tier card the sheen is the tier's,
 * and the same swept gradient in a foreign blue read as a badge from a different
 * product. Opacity is `TIER_WARP_OPACITY`, the same override the live card hands
 * the shell, NOT the shell's own defaults: those are the waitlist pass's
 * weighting, and leaving the painter on them is how an exported card would keep
 * the pale field the live one no longer has.
 *
 * MEMOISE THE RESULT. Every call returns a fresh object around a fresh array,
 * and the spec is half of the scene's identity in `PassStudio` — built in a
 * render body it rebuilds the whole type layer on every render. Key the memo on
 * `[isDark, plan]`, which is everything it reads.
 *
 * All nine stops of the widest tier do reach the shader: `u_colors` is a
 * `vec4[10]` uniform and the mix loop breaks at `u_colorsCount`, so nothing is
 * truncated to the four stops every other caller happens to pass.
 */
export function tierBackdropSpec(
	plan: PlanTier,
	isDark: boolean
): PassBackdropSpec {
	// The wash and the foil read the BADGE palette rather than the shader's stop
	// list, which has the scheme's base tone interleaved through it — picking by
	// index off that list would sooner or later wash the frame in `#121212`.
	const badge = planTierColors(plan);
	const near = badge[0] ?? "#888888";
	const far = badge[Math.floor(badge.length / 2)] ?? near;
	return {
		colors: tierWarpColors(plan, isDark),
		foil: far,
		opacity: TIER_WARP_OPACITY,
		wash: [
			withAlpha(near, BACKDROP_WASH_ALPHA),
			withAlpha(far, BACKDROP_WASH_ALPHA * 0.45),
		],
	};
}
