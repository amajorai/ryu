/**
 * The Ryu Wrapped card's type layer, so a Wrapped card can leave the site as a
 * picture, an MP4 or a GIF through the same studio the passes use.
 *
 * A mirror of `WrappedPass` (`../wrapped-pass.tsx`), which is the live card and
 * the authority on its layout: the same header kicker, the same name-over-meta
 * hero, the same 2×2 stat grid, and the type ramp imported from it rather than
 * re-declared. A change to what the card says belongs there first and here
 * second. The box, the header lockup, the stat block and the measuring helpers
 * come from `paint.ts`, exactly as the tier painter takes them.
 */

import { formatCount } from "../../lib/number-format.ts";
import {
	WRAPPED_FIT_STEP_PX,
	WRAPPED_META_PX,
	WRAPPED_NAME_MAX_PX,
	WRAPPED_NAME_MIN_PX,
	WRAPPED_STAT_VALUE_PX,
	WRAPPED_SUB_MAX_PX,
	WRAPPED_SUB_MIN_PX,
	WRAPPED_YEAR,
} from "../wrapped-pass.tsx";
import {
	activePassTranslate,
	formatPassDays,
	formatPassDecimalHours,
	type PassTranslate,
} from "./labels.ts";
import {
	BLOCK_GAP_PX,
	ellipsize,
	fitFontSize,
	font,
	HERO_GAP_PX,
	type PassFaceEnv,
	type PassFacePainter,
	paintPassHeader,
	paintPassStat,
	passFaceBox,
	setTracking,
} from "./paint.ts";
import { passInline, withPassDirection } from "./paint-direction.ts";

/** `gap-3` between the grid's columns and rows, at the app's 16px root. */
const STAT_GAP_PX = 12;
/** `tracking-tight` on the name. */
const NAME_TRACKING_EM = -0.025;

export interface WrappedFaceContent {
	agentHours: number;
	level: number;
	name?: string | null;
	streakCurrent: number;
	streakLongest: number;
	topModel?: string | null;
	totalTokens: number;
}

/** The name the card prints, and the seed its backdrop is hashed from. */
export function wrappedDisplayName(
	name?: string | null,
	tl: PassTranslate = activePassTranslate
): string {
	return name?.trim() || tl("A Ryu Developer");
}

/** The four footer stats, in the live card's order. */
export function wrappedStats(
	content: WrappedFaceContent,
	tl: PassTranslate = activePassTranslate
): readonly [string, string][] {
	return [
		[tl("Tokens"), formatCount(content.totalTokens) ?? "—"],
		[tl("Agent hours"), formatPassDecimalHours(content.agentHours)],
		[tl("Best streak"), formatPassDays(content.streakLongest)],
		[tl("Top model"), content.topModel?.trim() || "Ryu"],
	];
}

/** The Wrapped card, as a painter. Memoise it: it is half the scene's identity. */
export function wrappedFacePainter(
	content: WrappedFaceContent,
	tl: PassTranslate = activePassTranslate
): PassFacePainter {
	return {
		front: (ctx, env) =>
			paintWrappedFront(ctx, content, withPassDirection(ctx, env, tl), tl),
	};
}

function paintWrappedFront(
	ctx: CanvasRenderingContext2D,
	content: WrappedFaceContent,
	env: PassFaceEnv,
	tl: PassTranslate
): void {
	const { family, palette, scale } = env;
	const { available, bottom, left } = passFaceBox(scale);
	const inline = passInline(env);

	paintPassHeader(
		ctx,
		env,
		tl("Wrapped · {year}", { year: String(WRAPPED_YEAR) }).toUpperCase()
	);

	// The grid, bottom row first: the hero above is bottom-aligned against
	// whatever the footer leaves, so the footer is measured before it.
	const gap = STAT_GAP_PX * scale;
	const column = (available - gap) / 2;
	const [tokens, hours, streak, model] = wrappedStats(content, tl);
	const stat = (
		pair: [string, string] | undefined,
		x: number,
		baseline: number
	) =>
		paintPassStat(ctx, env, {
			baseline,
			label: pair?.[0] ?? "",
			labelPx: WRAPPED_META_PX,
			maxWidth: column,
			value: pair?.[1] ?? "—",
			valuePx: WRAPPED_STAT_VALUE_PX,
			x,
		});
	const lowerTop = stat(streak, left, bottom);
	stat(model, left + column + gap, bottom);
	const upperBaseline = lowerTop - gap;
	const upperTop = stat(tokens, left, upperBaseline);
	stat(hours, left + column + gap, upperBaseline);
	let cursor = upperTop - BLOCK_GAP_PX * scale;

	// Hero, built upward: the meta line, then the name above it.
	ctx.textAlign = inline.start;
	ctx.textBaseline = "alphabetic";
	const meta = tl("Level {level} · {days}-day streak", {
		days: String(content.streakCurrent),
		level: String(content.level),
	});
	const { size: metaSize } = fitFontSize(ctx, {
		available,
		family,
		maxPx: WRAPPED_SUB_MAX_PX,
		minPx: WRAPPED_SUB_MIN_PX,
		scale,
		stepPx: WRAPPED_FIT_STEP_PX,
		text: meta,
		weight: 400,
	});
	ctx.font = font(family, 400, metaSize, scale);
	setTracking(ctx, 0);
	ctx.fillStyle = palette.mutedForeground;
	ctx.fillText(ellipsize(ctx, meta, available), inline.x(left), cursor);
	cursor -= metaSize * scale + HERO_GAP_PX * scale;

	const name = wrappedDisplayName(content.name, tl);
	const { size: nameSize } = fitFontSize(ctx, {
		available,
		family,
		maxPx: WRAPPED_NAME_MAX_PX,
		minPx: WRAPPED_NAME_MIN_PX,
		scale,
		stepPx: WRAPPED_FIT_STEP_PX,
		text: name,
		trackingEm: NAME_TRACKING_EM,
		weight: 500,
	});
	ctx.font = font(family, 500, nameSize, scale);
	setTracking(ctx, nameSize * NAME_TRACKING_EM * scale);
	ctx.fillStyle = palette.cardForeground;
	ctx.fillText(ellipsize(ctx, name, available), inline.x(left), cursor);
	setTracking(ctx, 0);
}
