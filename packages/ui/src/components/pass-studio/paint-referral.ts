/**
 * The referral card's type layer: a milestone pass or a battle-pass tier the
 * member has actually reached, leaving the site as a picture, an MP4 or a GIF
 * through the same studio the waitlist, tier and Wrapped cards use.
 *
 * Laid out like the Wrapped face (`paint-wrapped.ts`): the shared header with a
 * kicker on the right, a headline-over-meta hero, and a 2×2 stat grid along the
 * bottom. The back is the waitlist pass's dot QR (`paintBackQr`), pointed at the
 * member's own invite link, so a scan of the shared picture still credits them.
 *
 * Every number the card prints arrives in its content, already counted by the
 * caller from the payload it rendered. The builders below only format and
 * order; they never derive a figure the page did not have.
 */

import {
	WRAPPED_FIT_STEP_PX,
	WRAPPED_META_PX,
	WRAPPED_NAME_MAX_PX,
	WRAPPED_NAME_MIN_PX,
	WRAPPED_STAT_VALUE_PX,
	WRAPPED_SUB_MAX_PX,
	WRAPPED_SUB_MIN_PX,
} from "../wrapped-pass.tsx";
import {
	BLOCK_GAP_PX,
	ellipsize,
	fitFontSize,
	font,
	HERO_GAP_PX,
	type PassFaceEnv,
	type PassFacePainter,
	paintBackQr,
	paintPassHeader,
	paintPassStat,
	passFaceBox,
	setTracking,
} from "./paint.ts";

/** `gap-3` between the grid's columns and rows, at the app's 16px root. */
const STAT_GAP_PX = 12;
/** `tracking-tight` on the headline. */
const HEADLINE_TRACKING_EM = -0.025;
/** The grid holds two rows of two. */
const MAX_STATS = 4;
const STATS_PER_ROW = 2;
const DEFAULT_SEED = "ryu";
const BACK_CAPTION = "Scan to join Ryu";

export interface ReferralFaceStat {
	label: string;
	value: string;
}

export interface ReferralFaceContent {
	/** The big line: what was reached. */
	headline: string;
	/** Absolute invite link the back's QR opens. No link, no code: the QR plate stays blank. */
	inviteUrl?: string | null;
	/** Printed top right, e.g. "MILESTONE PASS". */
	kicker: string;
	/** One quieter line under the headline. */
	meta?: string | null;
	/** Hashes the backdrop and the QR tint. Defaults to the headline. */
	seed?: string | null;
	/** Up to four; anything past that is dropped rather than squeezed in. */
	stats: readonly ReferralFaceStat[];
}

/** Whole agent hours, as the milestone card on the page prints them. */
export function formatPassHours(hours: number): string {
	if (!Number.isFinite(hours) || hours < 0) {
		return "0h";
	}
	return `${Math.floor(hours).toLocaleString()}h`;
}

/** The stats the grid draws: at most four, blank labels and values dropped. */
export function referralCardStats(
	content: Pick<ReferralFaceContent, "stats">
): ReferralFaceStat[] {
	return content.stats
		.filter((stat) => stat.label.trim() && stat.value.trim())
		.slice(0, MAX_STATS);
}

/** The seed the backdrop and the QR tint are hashed from. */
export function referralCardSeed(
	content: Pick<ReferralFaceContent, "headline" | "seed">
): string {
	return content.seed?.trim() || content.headline.trim() || DEFAULT_SEED;
}

export interface MilestoneCardFacts {
	/** The member's agent hours, as the milestone endpoint reported them. */
	hours: number;
	/** The pass's own `/r/CODE` link. */
	inviteUrl: string;
	seats: number;
	seatsClaimed: number;
	thresholdHours: number;
}

/** A clamped seats-left count; never negative, never above the pass size. */
export function seatsLeft(seats: number, seatsClaimed: number): number {
	return Math.min(seats, Math.max(0, seats - seatsClaimed));
}

/**
 * The milestone pass, as card content. The code is deliberately NOT printed on
 * the front: it travels in the QR on the back and in the post's own link, the
 * same split the waitlist pass keeps.
 */
export function milestoneCardContent(
	facts: MilestoneCardFacts
): ReferralFaceContent {
	const left = seatsLeft(facts.seats, facts.seatsClaimed);
	const claimed = facts.seats - left;
	return {
		headline: `${formatPassHours(facts.thresholdHours)} milestone`,
		inviteUrl: facts.inviteUrl,
		kicker: "MILESTONE PASS",
		meta: `One code for ${facts.seats} ${facts.seats === 1 ? "person" : "people"}`,
		seed: facts.inviteUrl,
		stats: [
			{ label: "Agent time", value: formatPassHours(facts.hours) },
			{ label: "Seats", value: String(facts.seats) },
			{ label: "Seats left", value: String(left) },
			{ label: "Joined", value: String(claimed) },
		],
	};
}

export interface QuestCardFacts {
	/** e.g. "This month". The page's own cadence heading. */
	cadenceLabel?: string | null;
	/** The member's invite link, when the page has it. */
	inviteUrl?: string | null;
	/** Current points balance, when the page has it. */
	pointsBalance?: string | null;
	progress: number;
	/** Already formatted, e.g. "500 points". */
	rewardLabel: string;
	target: number;
	title: string;
}

/** A battle-pass tier (a quest at or past its target), as card content. */
export function questCardContent(facts: QuestCardFacts): ReferralFaceContent {
	const reached = Math.min(Math.max(0, facts.progress), facts.target);
	const stats: ReferralFaceStat[] = [
		{ label: "Progress", value: `${reached}/${facts.target}` },
		{ label: "Reward", value: facts.rewardLabel },
	];
	if (facts.pointsBalance) {
		stats.push({ label: "Points balance", value: facts.pointsBalance });
	}
	const cadence = facts.cadenceLabel?.trim();
	return {
		headline: facts.title,
		inviteUrl: facts.inviteUrl,
		kicker: "BATTLE PASS",
		meta: cadence ? `${cadence} · tier unlocked` : "Tier unlocked",
		seed: facts.inviteUrl ?? facts.title,
		stats,
	};
}

/** The referral card, as a painter. Memoise it: it is half the scene's identity. */
export function referralFacePainter(
	content: ReferralFaceContent
): PassFacePainter {
	return {
		back: (ctx, env) =>
			paintBackQr(ctx, {
				caption: BACK_CAPTION,
				env,
				seed: referralCardSeed(content),
				value: content.inviteUrl,
			}),
		front: (ctx, env) => paintReferralFront(ctx, content, env),
	};
}

function paintReferralFront(
	ctx: CanvasRenderingContext2D,
	content: ReferralFaceContent,
	env: PassFaceEnv
): void {
	const { family, palette, scale } = env;
	const { available, bottom, left } = passFaceBox(scale);

	paintPassHeader(ctx, env, content.kicker);

	// The grid, bottom row first, so the hero can sit on whatever it leaves.
	const gap = STAT_GAP_PX * scale;
	const column = (available - gap) / 2;
	const stats = referralCardStats(content);
	const rows: ReferralFaceStat[][] = [];
	for (let index = 0; index < stats.length; index += STATS_PER_ROW) {
		rows.push(stats.slice(index, index + STATS_PER_ROW));
	}
	let baseline = bottom;
	let top = bottom;
	for (const row of rows.reverse()) {
		let rowTop = baseline;
		for (const [index, stat] of row.entries()) {
			rowTop = paintPassStat(ctx, env, {
				baseline,
				label: stat.label,
				labelPx: WRAPPED_META_PX,
				maxWidth: column,
				value: stat.value,
				valuePx: WRAPPED_STAT_VALUE_PX,
				x: left + index * (column + gap),
			});
		}
		top = rowTop;
		baseline = rowTop - gap;
	}
	let cursor = top - BLOCK_GAP_PX * scale;

	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
	const meta = content.meta?.trim();
	if (meta) {
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
		ctx.fillText(ellipsize(ctx, meta, available), left, cursor);
		cursor -= metaSize * scale + HERO_GAP_PX * scale;
	}

	const headline = content.headline.trim();
	const { size: headlineSize } = fitFontSize(ctx, {
		available,
		family,
		maxPx: WRAPPED_NAME_MAX_PX,
		minPx: WRAPPED_NAME_MIN_PX,
		scale,
		stepPx: WRAPPED_FIT_STEP_PX,
		text: headline,
		trackingEm: HEADLINE_TRACKING_EM,
		weight: 500,
	});
	ctx.font = font(family, 500, headlineSize, scale);
	setTracking(ctx, headlineSize * HEADLINE_TRACKING_EM * scale);
	ctx.fillStyle = palette.cardForeground;
	ctx.fillText(ellipsize(ctx, headline, available), left, cursor);
	setTracking(ctx, 0);
}
