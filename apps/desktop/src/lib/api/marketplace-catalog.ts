// apps/desktop/src/lib/api/marketplace-catalog.ts
//
// Catalog browse/search, featured, purchase and owned licenses.
// Split out of marketplace.ts (which re-exports it); see that file's header
// for the control-plane contract.

import type { MarketplaceKind, OwnedLicense } from "@ryu/marketplace/types";
import {
	type MarketplaceCard,
	toMarketplaceCard,
} from "./marketplace-cards.ts";
import {
	authHeaders,
	BASE,
	MARKETPLACE_SEARCH_KINDS,
	toError,
} from "./marketplace-http.ts";
import {
	catalogEnvelopeSchema,
	licensesEnvelopeSchema,
	parseMarketplaceResponse,
	purchaseWireSchema,
} from "./marketplace-response-contracts.ts";

/**
 * Browse the live, published catalog for a kind, WITH pricing. Public on the
 * server (no auth required), but we still attach the session bearer when present
 * so a future personalized response works; an anonymous browse is fine.
 */
export async function fetchCatalog(
	kind: MarketplaceKind,
	query = "",
	signal?: AbortSignal
): Promise<MarketplaceCard[]> {
	const page = await fetchCatalogPage(kind, query, { signal });
	return page.items;
}

/** One page of a Marketplace catalog search. */
export interface MarketplaceCatalogPage {
	items: MarketplaceCard[];
	/** Pass back as `cursor` for the next page; null on the last page. */
	nextCursor: string | null;
}

/** Largest page the control plane serves (`CATALOG_MAX_LIMIT`). */
const CATALOG_PAGE_MAX = 100;

/**
 * {@link fetchCatalog} with paging. `cursor` must be the `nextCursor` of the
 * previous page for the same kind and query; the server refuses any other
 * value with a 400 rather than silently restarting at page one.
 */
export async function fetchCatalogPage(
	kind: MarketplaceKind,
	query = "",
	options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {}
): Promise<MarketplaceCatalogPage> {
	const q = new URLSearchParams({ kind });
	if (query.trim()) {
		q.set("query", query.trim());
	}
	if (options.limit !== undefined && options.limit > 0) {
		q.set("limit", String(Math.min(options.limit, CATALOG_PAGE_MAX)));
	}
	if (options.cursor) {
		q.set("cursor", options.cursor);
	}
	const resp = await fetch(`${BASE}/catalog?${q.toString()}`, {
		headers: authHeaders(),
		signal: options.signal,
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		catalogEnvelopeSchema,
		await resp.json()
	);
	return {
		items: (json.items ?? []).map(toMarketplaceCard),
		nextCursor: json.nextCursor ?? null,
	};
}

/** Search every published Marketplace kind for the global command palette.
 * Individual kind failures are ignored so an unavailable catalog lane cannot
 * make the rest of the palette unusable. */
export async function searchMarketplaceCatalog(
	query: string,
	limit = 8,
	signal?: AbortSignal
): Promise<MarketplaceCard[]> {
	const results = await Promise.allSettled(
		MARKETPLACE_SEARCH_KINDS.map((kind) => fetchCatalog(kind, query, signal))
	);
	const seen = new Set<string>();
	const cards: MarketplaceCard[] = [];
	for (const result of results) {
		if (result.status !== "fulfilled") {
			continue;
		}
		for (const card of result.value) {
			const key = `${card.kind}:${card.id}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			cards.push(card);
		}
	}
	return cards
		.sort(
			(a, b) =>
				Number(b.firstParty) - Number(a.firstParty) ||
				a.name.localeCompare(b.name)
		)
		.slice(0, Math.max(0, limit));
}

/**
 * Fetch the admin-curated Staff Picks rail (live + featured items). Omit `kind`
 * for the cross-kind landing rail (the Store home); pass a kind to scope it to a
 * single realm. Public read like {@link fetchCatalog} — the session bearer is
 * attached when present, but an anonymous browse is fine, so the Store home can
 * show featured items before sign-in.
 */
export async function fetchFeatured(
	kind?: MarketplaceKind,
	limit?: number
): Promise<MarketplaceCard[]> {
	const q = new URLSearchParams();
	if (kind) {
		q.set("kind", kind);
	}
	if (limit !== undefined && limit > 0) {
		q.set("limit", String(limit));
	}
	const suffix = q.toString();
	const resp = await fetch(`${BASE}/featured${suffix ? `?${suffix}` : ""}`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		catalogEnvelopeSchema,
		await resp.json()
	);
	return (json.items ?? []).map(toMarketplaceCard);
}

export interface PurchaseResult {
	/** True when the org already held an active license (no new charge). */
	alreadyLicensed: boolean;
	license: OwnedLicense | null;
	sessionId: string;
	url: string;
}

/**
 * Start a paid-item purchase. Returns a hosted Stripe Checkout URL (a Connect
 * destination charge) to open externally, OR — if the org already owns the item
 * — `alreadyLicensed: true` with the existing license and no URL. The license is
 * written asynchronously by the server webhook, so the caller re-fetches
 * licenses on window focus after returning from checkout.
 */
export async function startPurchase(input: {
	kind: MarketplaceKind;
	id: string;
	successUrl?: string;
	cancelUrl?: string;
}): Promise<PurchaseResult> {
	const headers = authHeaders();
	headers.set("Idempotency-Key", crypto.randomUUID());
	const resp = await fetch(`${BASE}/purchase`, {
		method: "POST",
		headers,
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(purchaseWireSchema, await resp.json());
	return {
		url: json.url ?? "",
		sessionId: json.sessionId ?? "",
		alreadyLicensed: Boolean(json.alreadyLicensed),
		license: json.license ?? null,
	};
}

/** Fetch the active org's owned licenses (newest purchase first). */
export async function fetchLicenses(): Promise<OwnedLicense[]> {
	const resp = await fetch(`${BASE}/licenses`, { headers: authHeaders() });
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		licensesEnvelopeSchema,
		await resp.json()
	);
	return json.licenses ?? [];
}
