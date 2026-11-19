// apps/desktop/src/lib/api/marketplace-reviews.ts
//
// Listing reviews: list, post, delete.
// Split out of marketplace.ts (which re-exports it); see that file's header
// for the control-plane contract.

import type { MarketplaceKind } from "@ryu/marketplace/types";
import {
	authHeaders,
	BASE,
	MarketplaceError,
	toError,
} from "./marketplace-http.ts";
import {
	parseMarketplaceResponse,
	postReviewResultSchema,
	reviewFailureSchema,
	reviewsPageSchema,
} from "./marketplace-response-contracts.ts";

// ── Reviews ─────────────────────────────────────────────────────────────────

/** One published review (public read; author fields come from the server). */
export interface Review {
	body: string | null;
	createdAt: string;
	id: string;
	rating: number;
	title: string | null;
	updatedAt: string;
	userId: string;
	userImage: string | null;
	userName: string | null;
	verifiedPurchase: boolean;
}

export interface ReviewsPage {
	nextCursor: string | null;
	ratingAverage: number;
	ratingCount: number;
	reviews: Review[];
}

/** Fetch a page of reviews for an item (public). Paginate via `nextCursor`. */
export async function fetchReviews(
	kind: MarketplaceKind,
	id: string,
	opts: { limit?: number; cursor?: string | null } = {}
): Promise<ReviewsPage> {
	const q = new URLSearchParams({ kind, id });
	if (opts.limit) {
		q.set("limit", String(opts.limit));
	}
	if (opts.cursor) {
		q.set("cursor", opts.cursor);
	}
	const resp = await fetch(`${BASE}/reviews?${q.toString()}`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		reviewsPageSchema.partial(),
		await resp.json()
	);
	return {
		ratingAverage: json.ratingAverage ?? 0,
		ratingCount: json.ratingCount ?? 0,
		reviews: json.reviews ?? [],
		nextCursor: json.nextCursor ?? null,
	};
}

export interface PostReviewResult {
	ok: boolean;
	ratingAverage: number;
	ratingCount: number;
	verifiedPurchase: boolean;
}

/**
 * Create or update the caller's review (upsert). AUTH required. For paid items
 * only verified purchasers may review — the server returns 403 with
 * `requiresPurchase`, which we surface as a {@link MarketplaceError} of kind
 * "purchase" so the UI can render the verified-purchaser message. Free items are
 * open to any signed-in user.
 */
export async function postReview(input: {
	kind: MarketplaceKind;
	id: string;
	rating: number;
	title?: string;
	body?: string;
}): Promise<PostReviewResult> {
	const resp = await fetch(`${BASE}/reviews`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		// Reviews reuse 403 for "verified purchasers only" — a different meaning
		// than toError's payout 403, so classify it here before delegating.
		if (resp.status === 403) {
			let message: string | undefined;
			let requiresPurchase = false;
			try {
				const b = reviewFailureSchema.parse(await resp.clone().json());
				message = b.message ?? b.error;
				requiresPurchase = Boolean(b.requiresPurchase);
			} catch {
				// Non-JSON body.
			}
			if (requiresPurchase) {
				throw new MarketplaceError(
					"purchase",
					message ?? "Only verified purchasers can review this item."
				);
			}
		}
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		postReviewResultSchema.partial(),
		await resp.json()
	);
	return {
		ok: json.ok ?? true,
		verifiedPurchase: Boolean(json.verifiedPurchase),
		ratingAverage: json.ratingAverage ?? 0,
		ratingCount: json.ratingCount ?? 0,
	};
}

/** Delete the caller's own review for an item. AUTH required. */
export async function deleteReview(
	kind: MarketplaceKind,
	id: string
): Promise<void> {
	const q = new URLSearchParams({ kind, id });
	const resp = await fetch(`${BASE}/reviews?${q.toString()}`, {
		method: "DELETE",
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
}
