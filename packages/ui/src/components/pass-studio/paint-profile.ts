/**
 * The public profile card's type layer, so a `/u/<username>` profile can leave
 * the site as a picture, an MP4 or a GIF through the same studio the passes and
 * the Wrapped card use.
 *
 * There is no live profile pass to mirror, so the type ramp is the waitlist
 * pass's own (`../waitlist-pass.tsx`): the same name ramp, the same handle ramp
 * and the same stat block from `paint.ts`, imported rather than re-declared, so
 * a profile card cannot drift from the pass family by retyping a number. The
 * layout follows `paint-wrapped.ts`: header, a name-over-meta hero, and a 2×2
 * stat grid built bottom-up.
 *
 * Everything printed here is something the public profile page already shows.
 * The usage block is optional because the owner can hide it; a profile whose
 * usage section is off prints its name, handle and joined month and nothing
 * else — never a zero standing in for a hidden number.
 */

import { formatCount } from "../../lib/number-format.ts";
import {
	FIT_STEP_PX,
	HANDLE_MAX_PX,
	HANDLE_MIN_PX,
	NAME_MAX_PX,
	NAME_MIN_PX,
} from "../waitlist-pass.tsx";
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
	STAT_LABEL_PX,
	STAT_VALUE_PX,
	setTracking,
} from "./paint.ts";

/** `gap-3` between the grid's columns and rows, at the app's 16px root. */
const STAT_GAP_PX = 12;
/** `tracking-tight` on the name. */
const NAME_TRACKING_EM = -0.025;
/** The avatar disc: `size-14` with a `mb-3`, the waitlist face's own. */
const AVATAR_PX = 56;
const AVATAR_GAP_PX = 12;
const DEFAULT_NAME = "A Ryu Developer";

/** The usage totals a profile shows when its usage section is public. */
export interface ProfileFaceUsage {
	agentHours: number;
	requestCount: number;
	streakCurrent: number;
	streakLongest: number;
	totalTokens: number;
}

export interface ProfileFaceContent {
	/** Already formatted ("May 2026"); the card prints it verbatim. */
	joined?: string | null;
	name?: string | null;
	/** Omitted when the owner hides usage. */
	usage?: ProfileFaceUsage | null;
	username?: string | null;
}

/** The name the card prints, and the seed its backdrop is hashed from. */
export function profileDisplayName(name?: string | null): string {
	return name?.trim() || DEFAULT_NAME;
}

/** The header's right-hand meta: the joined month, when there is one. */
export function profileHeaderMeta(content: ProfileFaceContent): string | null {
	const joined = content.joined?.trim();
	return joined ? `Joined ${joined}` : null;
}

/** "@handle · 12-day streak": the line under the name. */
export function profileMetaLine(content: ProfileFaceContent): string | null {
	const parts: string[] = [];
	const handle = content.username?.trim();
	if (handle) {
		parts.push(`@${handle}`);
	}
	if (content.usage) {
		parts.push(`${content.usage.streakCurrent}-day streak`);
	}
	return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The four footer stats, in the profile page's order — or none at all when the
 * usage section is private.
 */
export function profileStats(
	content: ProfileFaceContent
): readonly [string, string][] {
	const usage = content.usage;
	if (!usage) {
		return [];
	}
	return [
		["Tokens", formatCount(usage.totalTokens) ?? "—"],
		["Requests", formatCount(usage.requestCount) ?? "—"],
		["Agent hours", `${usage.agentHours.toFixed(1)}h`],
		["Best streak", `${usage.streakLongest}d`],
	];
}

/** The profile card, as a painter. Memoise it: it is half the scene's identity. */
export function profileFacePainter(
	content: ProfileFaceContent
): PassFacePainter {
	return {
		front: (ctx, env) => paintProfileFront(ctx, content, env),
	};
}

function paintProfileFront(
	ctx: CanvasRenderingContext2D,
	content: ProfileFaceContent,
	env: PassFaceEnv
): void {
	const { avatar, family, palette, scale } = env;
	const { available, bottom, left } = passFaceBox(scale);

	paintPassHeader(ctx, env, profileHeaderMeta(content));

	// The grid, bottom row first: the hero above is bottom-aligned against
	// whatever the footer leaves, so the footer is measured before it.
	let cursor = bottom;
	const stats = profileStats(content);
	if (stats.length > 0) {
		const gap = STAT_GAP_PX * scale;
		const column = (available - gap) / 2;
		const [tokens, requests, hours, streak] = stats;
		const stat = (
			pair: [string, string] | undefined,
			x: number,
			baseline: number
		) =>
			paintPassStat(ctx, env, {
				baseline,
				label: pair?.[0] ?? "",
				labelPx: STAT_LABEL_PX,
				maxWidth: column,
				value: pair?.[1] ?? "—",
				valuePx: STAT_VALUE_PX,
				x,
			});
		const lowerTop = stat(hours, left, bottom);
		stat(streak, left + column + gap, bottom);
		const upperBaseline = lowerTop - gap;
		const upperTop = stat(tokens, left, upperBaseline);
		stat(requests, left + column + gap, upperBaseline);
		cursor = upperTop - BLOCK_GAP_PX * scale;
	}

	// Hero, built upward: the meta line, the name, then the avatar.
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
	const meta = profileMetaLine(content);
	if (meta) {
		const { size: metaSize } = fitFontSize(ctx, {
			available,
			family,
			maxPx: HANDLE_MAX_PX,
			minPx: HANDLE_MIN_PX,
			scale,
			stepPx: FIT_STEP_PX,
			text: meta,
			weight: 400,
		});
		ctx.font = font(family, 400, metaSize, scale);
		setTracking(ctx, 0);
		ctx.fillStyle = palette.mutedForeground;
		ctx.fillText(ellipsize(ctx, meta, available), left, cursor);
		cursor -= metaSize * scale + HERO_GAP_PX * scale;
	}

	const name = profileDisplayName(content.name);
	const { size: nameSize } = fitFontSize(ctx, {
		available,
		family,
		maxPx: NAME_MAX_PX,
		minPx: NAME_MIN_PX,
		scale,
		stepPx: FIT_STEP_PX,
		text: name,
		trackingEm: NAME_TRACKING_EM,
		weight: 500,
	});
	ctx.font = font(family, 500, nameSize, scale);
	setTracking(ctx, nameSize * NAME_TRACKING_EM * scale);
	ctx.fillStyle = palette.cardForeground;
	ctx.fillText(ellipsize(ctx, name, available), left, cursor);
	setTracking(ctx, 0);

	if (avatar) {
		const size = AVATAR_PX * scale;
		const y = cursor - nameSize * scale - AVATAR_GAP_PX * scale - size;
		ctx.save();
		ctx.beginPath();
		ctx.arc(left + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
		ctx.clip();
		ctx.drawImage(avatar, left, y, size, size);
		ctx.restore();
		ctx.beginPath();
		ctx.arc(left + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
		ctx.strokeStyle = palette.border;
		ctx.lineWidth = scale;
		ctx.stroke();
	}
}
