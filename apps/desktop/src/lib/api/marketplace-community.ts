// apps/desktop/src/lib/api/marketplace-community.ts
//
// Listing likes and the Creators directory/profile.
// Split out of marketplace.ts (which re-exports it); see that file's header
// for the control-plane contract.

import type {
	MarketplaceCreator,
	MarketplaceCreatorProfile,
	MarketplaceCreatorProfileFields,
	MarketplaceCreatorSort,
	MarketplaceOwnCreatorProfile,
} from "@ryu/marketplace/creators/types";
import { formatPricingLabel } from "@ryu/marketplace/types";
import { toMarketplaceCard } from "./marketplace-cards.ts";
import { authHeaders, BASE, toError } from "./marketplace-http.ts";
import { recordValue } from "./marketplace-private-share.ts";
import {
	creatorFieldsEnvelopeSchema,
	creatorProfileEnvelopeSchema,
	creatorsEnvelopeSchema,
	likesEnvelopeSchema,
	marketplaceOwnCreatorProfileSchema,
	parseMarketplaceResponse,
} from "./marketplace-response-contracts.ts";
import {
	marketplaceNumberField,
	marketplaceStringField,
	type marketplaceValueSchema,
} from "./marketplace-wire-values.ts";

// ── likes (the heart on a store card) ─────────────────────────────────────────
//
// Keyed by the listing's NAMESPACE (`@ryu/crm`, `owner/repo`), never by an
// internal row id. The desktop browses the catalog through CORE's adapter, whose
// payload carries no like fields at all, so these three calls are how a desktop
// card learns its count — one BULK read per page, never one per card.

/** One listing's like state, as the control plane returns it. */
export interface LikeSnapshot {
	count: number;
	liked: boolean;
	namespace: string;
}

function toSnapshot(
	raw: Parameters<typeof marketplaceValueSchema.parse>[0],
	fallbackNamespace: string
): LikeSnapshot {
	const row = recordValue(raw) ?? {};
	return {
		namespace: marketplaceStringField(row.namespace) ?? fallbackNamespace,
		count: Math.max(0, marketplaceNumberField(row.count) ?? 0),
		liked: row.liked === true,
	};
}

/**
 * GET /api/marketplace/likes?ns=… — BULK counts for a whole page of cards.
 *
 * Public: an unauthenticated desktop still sees real counts (every row comes
 * back `liked: false`), which is why the heart renders before sign-in rather
 * than appearing only once a session exists.
 */
export async function fetchLikeCounts(
	namespaces: string[]
): Promise<LikeSnapshot[]> {
	if (namespaces.length === 0) {
		return [];
	}
	const q = new URLSearchParams({ ns: namespaces.join(",") });
	const resp = await fetch(`${BASE}/likes?${q.toString()}`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(likesEnvelopeSchema, await resp.json());
	return (json.likes ?? []).map((row) => toSnapshot(row, ""));
}

/** POST /api/marketplace/likes — like one listing. Idempotent server-side. */
export async function likeItem(namespace: string): Promise<LikeSnapshot> {
	const resp = await fetch(`${BASE}/likes`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ namespace }),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	return toSnapshot(await resp.json(), namespace);
}

/** DELETE /api/marketplace/likes?namespace= — remove the caller's own like. */
export async function unlikeItem(namespace: string): Promise<LikeSnapshot> {
	const q = new URLSearchParams({ namespace });
	const resp = await fetch(`${BASE}/likes?${q.toString()}`, {
		method: "DELETE",
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	return toSnapshot(await resp.json(), namespace);
}

// ── Creators ─────────────────────────────────────────────────────────────────

/** GET /api/marketplace/creators — the public Creators directory. */
export async function fetchMarketplaceCreators(input: {
	query?: string;
	signal?: AbortSignal;
	sort?: MarketplaceCreatorSort;
}): Promise<MarketplaceCreator[]> {
	const q = new URLSearchParams();
	if (input.query?.trim()) {
		q.set("query", input.query.trim());
	}
	if (input.sort) {
		q.set("sort", input.sort);
	}
	const suffix = q.toString();
	const resp = await fetch(`${BASE}/creators${suffix ? `?${suffix}` : ""}`, {
		headers: authHeaders(),
		signal: input.signal,
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		creatorsEnvelopeSchema,
		await resp.json()
	);
	return Array.isArray(json.creators) ? json.creators : [];
}

/** GET /api/marketplace/creators/:handle — one creator and their listings. */
export async function fetchMarketplaceCreator(
	handle: string,
	signal?: AbortSignal
): Promise<MarketplaceCreatorProfile | null> {
	const resp = await fetch(`${BASE}/creators/${encodeURIComponent(handle)}`, {
		headers: authHeaders(),
		signal,
	});
	if (resp.status === 404) {
		return null;
	}
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		creatorProfileEnvelopeSchema,
		await resp.json()
	);
	return {
		creator: json.creator,
		listings: (json.listings ?? []).map((wire) => {
			const card = toMarketplaceCard(wire);
			return {
				communityStats: card.communityStats,
				description: card.description,
				featured: wire.featured === true,
				iconUrl: card.iconUrl,
				id: card.id,
				kind: card.kind,
				name: card.name,
				priceLabel: card.pricing ? formatPricingLabel(card.pricing) : "Free",
				ratingAverage: card.ratingAverage,
				ratingCount: card.ratingCount,
			};
		}),
	};
}

/** GET /api/marketplace/creator-profile — the active org's editable profile. */
export async function fetchOwnCreatorProfile(): Promise<MarketplaceOwnCreatorProfile> {
	const resp = await fetch(`${BASE}/creator-profile`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	return parseMarketplaceResponse(
		marketplaceOwnCreatorProfileSchema,
		await resp.json()
	);
}

/** PUT /api/marketplace/creator-profile — save the active org's profile. */
export async function saveOwnCreatorProfile(
	fields: MarketplaceCreatorProfileFields,
	organizationId?: string
): Promise<MarketplaceCreatorProfileFields> {
	const body: MarketplaceCreatorProfileFields & { organizationId?: string } = {
		...fields,
	};
	if (organizationId) {
		body.organizationId = organizationId;
	}
	const resp = await fetch(`${BASE}/creator-profile`, {
		body: JSON.stringify(body),
		headers: authHeaders(),
		method: "PUT",
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		creatorFieldsEnvelopeSchema,
		await resp.json()
	);
	return json.profile;
}
