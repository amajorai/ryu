// apps/desktop/src/lib/api/integrations.ts
//
// Client for the merged Integrations catalog (`GET /api/integrations`). Core
// unions the integrations.sh directory with Composio's toolkit catalog into one
// brand-per-service list, deduped by slug and paginated with a real offset
// cursor (so the whole registry loads, not just the first page). Each brand is
// the front door to everything that connects to that service.

import { type ApiTarget, request } from "./client.ts";

/** One service/brand (Notion, Slack, …) merged across catalog sources. */
export interface IntegrationBrand {
	categories: string[];
	description: string | null;
	domain: string | null;
	/** Integration kinds available from the directory (mcp/api/graphql/cli). */
	feeds: string[];
	/** Stable slug (lowercase, non-alphanumerics stripped) — also the detail id. */
	id: string;
	/** A logo URL (raster). */
	logo: string | null;
	name: string;
	popularity: number | null;
	/** Which catalogs surfaced this brand: "directory" and/or "composio". */
	sources: string[];
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
	const json = await request<{
		integrations?: IntegrationBrand[];
		next_cursor?: string | null;
		total?: number;
	}>(target, `/api/integrations?${q.toString()}`);
	return {
		integrations: json.integrations ?? [],
		nextCursor: json.next_cursor ?? null,
		total: json.total ?? 0,
	};
}

/** Fetch a single brand by slug. */
export async function fetchIntegration(
	target: ApiTarget,
	id: string
): Promise<IntegrationBrand> {
	return await request<IntegrationBrand>(
		target,
		`/api/integrations/${encodeURIComponent(id)}`
	);
}
