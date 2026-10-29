import { z } from "zod";
// apps/desktop/src/lib/api/integrations.ts
//
// Client for the merged Integrations catalog (`GET /api/integrations`). Core
// unions the integrations.sh directory with Composio's toolkit catalog and
// Treg's public platform catalog into one brand-per-service list, deduped by
// slug and paginated with a real offset
// cursor (so the whole registry loads, not just the first page). Each brand is
// the front door to everything that connects to that service.

import { type ApiTarget, request } from "./client.ts";
import { getPreference, setPreference } from "./preferences.ts";

const priceResponseSchema = z.looseObject({
	basis: z.union([z.null(), z.string()]).optional(),
	confidence: z.union([z.null(), z.string()]).optional(),
	currency: z.union([z.null(), z.string()]).optional(),
	metered_by: z.array(z.string()).optional(),
	per: z.union([z.null(), z.number()]).optional(),
	unit: z.union([z.null(), z.string()]).optional(),
	usd: z.union([z.null(), z.number()]).optional(),
	value: z.union([z.null(), z.number()]).optional(),
});
const optionsResponseSchema = z.looseObject({
	action: z.string().optional(),
	availability_note: z.union([z.null(), z.string()]).optional(),
	available: z.union([z.null(), z.literal(false), z.literal(true)]).optional(),
	capability: z.union([z.null(), z.string()]).optional(),
	comparison_key: z.union([z.null(), z.string()]).optional(),
	connection_id: z.union([z.null(), z.string()]).optional(),
	description: z.union([z.null(), z.string()]).optional(),
	id: z.string().optional(),
	is_cheapest: z.boolean().optional(),
	kind: z.string().optional(),
	name: z.string().optional(),
	price: z.union([z.null(), priceResponseSchema]).optional(),
	provider: z.union([z.null(), z.string()]).optional(),
	provider_role: z.union([z.null(), z.string()]).optional(),
	source: z.string().optional(),
	url: z.union([z.null(), z.string()]).optional(),
});
const connectionsResponseSchema = z.looseObject({
	id: z.string(),
	kind: z.string(),
	name: z.string(),
	url: z.union([z.null(), z.string()]),
});
const integrationsResponseSchema = z.looseObject({
	options: z.array(optionsResponseSchema).optional(),
	categories: z.array(z.string()),
	connections: z.array(connectionsResponseSchema),
	description: z.union([z.null(), z.string()]),
	domain: z.union([z.null(), z.string()]),
	feeds: z.array(z.string()),
	id: z.string(),
	logo: z.union([z.null(), z.string()]),
	name: z.string(),
	popularity: z.union([z.null(), z.number()]),
	preferred_source: z.union([z.null(), z.string()]).optional(),
	sources: z.array(z.string()),
	suggested_source: z.union([z.null(), z.string()]).optional(),
});
const jsonResponseSchema = z.looseObject({
	integrations: z.array(integrationsResponseSchema).optional(),
	next_cursor: z.union([z.null(), z.string()]).optional(),
	total: z.number().optional(),
});

/** One concrete connection a brand offers, straight from a directory record.
 *  This is the actionable form of `feeds`: the record `id` is what Core's
 *  OpenAPI importer resolves against apis.guru, and `url` is the setup/endpoint
 *  URL. Without these two fields every connection is only a chip. */
export interface IntegrationConnection {
	/** Directory record id (`openapi/1password-com-events`, `mcp/notion`). */
	id: string;
	/** `mcp` / `openapi` / `api` / `graphql` / `cli`. */
	kind: string;
	name: string;
	url: string | null;
}

/** A provider-level choice surfaced by the merged preview. */
export interface IntegrationOption {
	action: string;
	availabilityNote: string | null;
	available: boolean | null;
	capability: string | null;
	comparisonKey: string | null;
	connectionId: string | null;
	description: string | null;
	id: string;
	isCheapest: boolean;
	kind: string;
	name: string;
	price: IntegrationPrice | null;
	provider: string | null;
	/**
	 * Set by Core only when a tool catalog (Treg's or Ryu's) and Composio both
	 * offer the brand: `primary` on the catalog options, `alternative` on
	 * Composio's.
	 */
	providerRole: "primary" | "alternative" | null;
	source: string;
	url: string | null;
}

export interface IntegrationPrice {
	/**
	 * What the figure covers: `one_call` (all-in), `base_call` (meters in
	 * `meteredBy` add to it) or `usage`; null when the source does not say.
	 */
	basis: string | null;
	confidence: string | null;
	currency: string | null;
	/** Meters billed on top of a `base_call` figure. */
	meteredBy: string[];
	per: number | null;
	unit: string | null;
	usd: number | null;
	value: number | null;
}

interface IntegrationOptionWire {
	action?: string;
	availability_note?: string | null;
	available?: boolean | null;
	capability?: string | null;
	comparison_key?: string | null;
	connection_id?: string | null;
	description?: string | null;
	id?: string;
	is_cheapest?: boolean;
	kind?: string;
	name?: string;
	price?: {
		basis?: string | null;
		confidence?: string | null;
		currency?: string | null;
		metered_by?: string[];
		per?: number | null;
		unit?: string | null;
		usd?: number | null;
		value?: number | null;
	} | null;
	provider?: string | null;
	provider_role?: string | null;
	source?: string;
	url?: string | null;
}

function providerRole(
	value: string | null | undefined
): IntegrationOption["providerRole"] {
	return value === "primary" || value === "alternative" ? value : null;
}

interface IntegrationBrandWire
	extends Omit<
		IntegrationBrand,
		"options" | "preferredSource" | "suggestedSource"
	> {
	options?: IntegrationOptionWire[];
	preferred_source?: string | null;
	suggested_source?: string | null;
}

function pinnableSource(
	value: string | null | undefined
): IntegrationProviderPin | null {
	return value === "treg" || value === "composio" ? value : null;
}

function mapIntegrationBrand({
	preferred_source,
	suggested_source,
	...brand
}: IntegrationBrandWire): IntegrationBrand {
	return {
		...brand,
		preferredSource: pinnableSource(preferred_source),
		suggestedSource: suggested_source ?? null,
		options: (brand.options ?? []).map((option) => ({
			action: option.action ?? "chat-setup",
			available: option.available ?? null,
			availabilityNote: option.availability_note ?? null,
			capability: option.capability ?? null,
			comparisonKey: option.comparison_key ?? null,
			connectionId: option.connection_id ?? null,
			description: option.description ?? null,
			id: option.id ?? "",
			isCheapest: option.is_cheapest ?? false,
			kind: option.kind ?? "",
			name: option.name ?? option.id ?? "",
			price: option.price
				? {
						basis: option.price.basis ?? null,
						confidence: option.price.confidence ?? null,
						currency: option.price.currency ?? null,
						meteredBy: option.price.metered_by ?? [],
						per: option.price.per ?? null,
						unit: option.price.unit ?? null,
						usd: option.price.usd ?? null,
						value: option.price.value ?? null,
					}
				: null,
			provider: option.provider ?? null,
			providerRole: providerRole(option.provider_role),
			source: option.source ?? "",
			url: option.url ?? null,
		})),
	};
}

/** One service/brand (Notion, Slack, …) merged across catalog sources. */
export interface IntegrationBrand {
	categories: string[];
	/** Every directory record folded into this brand, deduped by record id. */
	connections: IntegrationConnection[];
	description: string | null;
	domain: string | null;
	/** Integration kinds available from the directory (mcp/api/graphql/cli). */
	feeds: string[];
	/** Stable slug (lowercase, non-alphanumerics stripped) — also the detail id. */
	id: string;
	/** A logo URL (raster). */
	logo: string | null;
	name: string;
	/** One unified preview list: integrations.sh records, Composio toolkits, and
	 * Ryu's and Treg's catalog endpoints/platforms, each labelled by source. */
	options: IntegrationOption[];
	popularity: number | null;
	/** The user's pinned managed source for this brand, when that source offers it. */
	preferredSource: IntegrationProviderPin | null;
	/** Which catalogs surfaced this brand: "directory", "composio", "ryu" and/or "treg". */
	sources: string[];
	/**
	 * The managed source Ryu suggests: the tool catalog (`treg`, billed at the
	 * provider's cost, or `ryu`) when it offers the brand, else `composio`.
	 */
	suggestedSource: string | null;
}

/** A managed source a brand can be pinned to. */
export type IntegrationProviderPin = "treg" | "composio";

/** Core preference holding the per-brand pins (brand id → source). */
const PROVIDER_PINS_PREF = "integrations-provider-pins";

/**
 * Pin a brand to one managed source, or clear the pin (`null`) to follow Ryu's
 * suggestion. Stored in Core's preferences, where the Integrations Store and
 * agent routing read it.
 */
export async function setIntegrationProviderPin(
	target: ApiTarget,
	brandId: string,
	source: IntegrationProviderPin | null
): Promise<boolean> {
	const raw = await getPreference(target, PROVIDER_PINS_PREF);
	let pins: Record<string, string> = {};
	if (raw) {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				pins = Object.fromEntries(
					Object.entries(parsed).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string"
					)
				);
			}
		} catch {
			// A malformed value is replaced; Core ignores it too.
		}
	}
	if (source) {
		pins[brandId] = source;
	} else {
		delete pins[brandId];
	}
	return setPreference(target, PROVIDER_PINS_PREF, JSON.stringify(pins));
}

export interface IntegrationsPage {
	integrations: IntegrationBrand[];
	/** Offset cursor for the next page, or null at the end. */
	nextCursor: string | null;
	total: number;
}

export interface IntegrationsSearchParams {
	cursor?: string;
	limit?: number;
	query?: string;
}

/** Search/browse the merged brand catalog (server-side filter + offset cursor). */
export async function searchIntegrations(
	target: ApiTarget,
	params: IntegrationsSearchParams = {}
): Promise<IntegrationsPage> {
	const q = new URLSearchParams();
	if (params.query) {
		q.set("q", params.query);
	}
	if (params.limit) {
		q.set("limit", String(params.limit));
	}
	if (params.cursor) {
		q.set("cursor", params.cursor);
	}
	const json = await request(
		target,
		`/api/integrations?${q.toString()}`,
		undefined,
		jsonResponseSchema
	);
	return {
		integrations: (json.integrations ?? []).map(mapIntegrationBrand),
		nextCursor: json.next_cursor ?? null,
		total: json.total ?? 0,
	};
}

/** Fetch a single brand by slug. */
export async function fetchIntegration(
	target: ApiTarget,
	id: string
): Promise<IntegrationBrand> {
	const brand = await request(
		target,
		`/api/integrations/${encodeURIComponent(id)}`,
		undefined,
		integrationsResponseSchema
	);
	return mapIntegrationBrand(brand);
}
