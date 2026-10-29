// The query string behind a shareable waitlist pass.
//
// One builder, four callers, and they must agree exactly: the `/pass` page
// renders from these params, its `og:image` points at `/api/og/pass` with the
// same ones, the web queue screen's share dialog links to that page, and so
// does the desktop's. If they drifted, the picture in the dialog and the
// picture X unfurls would be different images of the same card.
//
// It lives in `@ryu/ui` rather than `apps/web` because the desktop waitlist
// gate shares the same dialog — see `@ryu/blocks/web/waitlist-share-dialog`.
// Kept free of React imports so `apps/web`'s server-rendered `/pass` page can
// use it without pulling a client component into its module graph.

import { z } from "zod";

/**
 * The shareable image's pixel size — 16:9, not the 1200x630 the rest of the
 * site's cards use, because this one is meant to be pasted into a post as a
 * picture in its own right.
 *
 * It lives here rather than next to the renderer so the `/pass` page can declare
 * it in `og:image:width/height` without importing `pass-card.tsx`, which would
 * drag takumi's native binding into a page render for one number.
 */
export const PASS_OG_SIZE = { width: 1200, height: 675 } as const;

// Queue values preserve the full native number domain, including stored nonfinite counts.
const queueNumberSchema = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);

export function isPassQueueNumber(
	value: Parameters<typeof queueNumberSchema.safeParse>[0]
): value is number {
	return queueNumberSchema.safeParse(value).success;
}

export interface PassShareFacts {
	/** Sign-up time (ISO). The live card formats it; so does the raster. */
	joined?: string | null;
	name: string;
	/** Queue position — omit to hide it, e.g. while the list is still small. */
	position?: number | null;
	/** Referral code, so a click on the shared post is still attributed. */
	ref?: string | null;
	username?: string | null;
}

/**
 * The canonical param set. Empty values are dropped rather than sent blank so
 * the URL stays short and two identical passes always produce a byte-identical
 * query string — which is what makes the year-long image cache safe to hit.
 */
export function passShareParams(facts: PassShareFacts): URLSearchParams {
	const params = new URLSearchParams();
	params.set("name", facts.name);
	if (facts.ref) {
		params.set("ref", facts.ref);
	}
	if (facts.username) {
		params.set("username", facts.username);
	}
	if (isPassQueueNumber(facts.position)) {
		params.set("position", String(facts.position));
	}
	if (facts.joined) {
		params.set("joined", facts.joined);
	}
	return params;
}

/**
 * The 16:9 PNG itself, as a path on the web app. Same URL the `/pass` page's OG
 * tag points at. Site-relative on purpose: only `apps/web` serves this route,
 * and the desktop never needs the raster (its dialog draws the real card).
 */
export function passImageUrl(facts: PassShareFacts): string {
	return `/api/og/pass?${passShareParams(facts).toString()}`;
}

/**
 * The public page to share. Carries the referral code as well, so the post
 * unfurls the card AND credits the sharer when someone signs up from it.
 *
 * `origin` is passed in rather than read off `window`: the desktop shell's own
 * origin is `tauri.localhost`, so it supplies the web app's URL instead.
 */
export function passPageUrl(facts: PassShareFacts, origin: string): string {
	const params = passShareParams(facts);
	if (facts.ref) {
		params.set("ref", facts.ref);
	}
	return `${origin}/pass?${params.toString()}`;
}
