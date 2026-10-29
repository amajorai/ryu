/**
 * The certificate card's type layer, so a verified `/cert/<id>` credential can
 * leave the site as a picture, an MP4 or a GIF through the same studio the
 * passes and the Wrapped card use.
 *
 * Laid out like `paint-wrapped.ts` — header, a name-over-meta hero, a stat grid
 * built bottom-up — on the waitlist pass's type ramp (`../waitlist-pass.tsx`)
 * and `paint.ts`'s stat block, imported rather than re-declared.
 *
 * Provenance is the caller's job and is taken as given: `issuerName` arrives
 * already resolved by the certificate page's fail-closed rules, and `official`
 * is only true for a Ryu Academy credential. The header kicker says which, so a
 * community credential's card never reads as Ryu-issued just because it is
 * printed on the Ryu pass.
 */

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
const SCORE_MAX = 100;

export interface CertificateFaceContent {
	holderName: string;
	/** Already formatted ("October 18, 2026"); printed verbatim. */
	issued?: string | null;
	/** Already resolved by the page's provenance rules. */
	issuerName: string;
	levelName: string;
	official: boolean;
	/** Out of 100. `null` when the stored score is not a finite number. */
	score: number | null;
}

/** "92/100", or null when there is no real score to print. */
export function certificateScoreLabel(
	score: number | null | undefined
): string | null {
	if (typeof score !== "number" || !Number.isFinite(score)) {
		return null;
	}
	return `${Math.round(score)}/${SCORE_MAX}`;
}

/** The header kicker: who stands behind the credential. */
export function certificateKicker(content: CertificateFaceContent): string {
	return content.official ? "RYU ACADEMY" : "VERIFIED ON RYU";
}

/**
 * The footer stats, top row first. Score and issue date share a row; the
 * issuer gets a row of its own because it is free text. A missing score or
 * date is dropped rather than printed as a placeholder.
 */
export function certificateStats(
	content: CertificateFaceContent
): readonly [string, string][] {
	const stats: [string, string][] = [];
	const score = certificateScoreLabel(content.score);
	if (score) {
		stats.push(["Score", score]);
	}
	const issued = content.issued?.trim();
	if (issued) {
		stats.push(["Issued", issued]);
	}
	stats.push(["Issued by", content.issuerName.trim() || "Community author"]);
	return stats;
}

/** The certificate card, as a painter. Memoise it: it is half the scene's identity. */
export function certificateFacePainter(
	content: CertificateFaceContent
): PassFacePainter {
	return {
		front: (ctx, env) => paintCertificateFront(ctx, content, env),
	};
}

function paintCertificateFront(
	ctx: CanvasRenderingContext2D,
	content: CertificateFaceContent,
	env: PassFaceEnv
): void {
	const { family, palette, scale } = env;
	const { available, bottom, left } = passFaceBox(scale);

	paintPassHeader(ctx, env, certificateKicker(content));

	// Footer first, bottom row up: the issuer alone on the floor, then score and
	// date side by side above it.
	const gap = STAT_GAP_PX * scale;
	const column = (available - gap) / 2;
	const stats = certificateStats(content);
	const issuer = stats.at(-1);
	const upper = stats.slice(0, -1);
	const stat = (
		pair: [string, string] | undefined,
		x: number,
		baseline: number,
		maxWidth: number
	) =>
		paintPassStat(ctx, env, {
			baseline,
			label: pair?.[0] ?? "",
			labelPx: STAT_LABEL_PX,
			maxWidth,
			value: pair?.[1] ?? "—",
			valuePx: STAT_VALUE_PX,
			x,
		});
	let top = stat(issuer, left, bottom, available);
	if (upper.length > 0) {
		const baseline = top - gap;
		const width = upper.length > 1 ? column : available;
		top = stat(upper[0], left, baseline, width);
		if (upper[1]) {
			stat(upper[1], left + column + gap, baseline, column);
		}
	}
	let cursor = top - BLOCK_GAP_PX * scale;

	// Hero, built upward: the credential name, then the holder above it.
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
	const level = content.levelName.trim();
	const { size: levelSize } = fitFontSize(ctx, {
		available,
		family,
		maxPx: HANDLE_MAX_PX,
		minPx: HANDLE_MIN_PX,
		scale,
		stepPx: FIT_STEP_PX,
		text: level,
		weight: 400,
	});
	ctx.font = font(family, 400, levelSize, scale);
	setTracking(ctx, 0);
	ctx.fillStyle = palette.mutedForeground;
	ctx.fillText(ellipsize(ctx, level, available), left, cursor);
	cursor -= levelSize * scale + HERO_GAP_PX * scale;

	const name = content.holderName.trim();
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
}
