import type {
	CatalogBanner,
	CatalogChannel,
	CatalogExtensionSummary,
	CatalogImplementationSummary,
	CatalogLayer,
	CatalogSurfaceSupport,
	DesignSystemEvidence,
	VersionSnapshot,
} from "@ryu/marketplace/catalog/types";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import {
	type ApiTarget,
	authenticatedFetch,
	makeHeaders,
	request,
} from "./client.ts";
import { pluginRecord, pluginStringField } from "./plugin-wire-values.ts";
import { parsePluginResponse } from "./plugins-app-response-contracts.ts";
import type { CatalogEntry } from "./plugins-catalog.ts";
import {
	catalogBrowseSchema,
	catalogDetailWireSchema,
} from "./plugins-catalog-response-contracts.ts";
import { parseLifecycleError } from "./plugins-lifecycle-errors.ts";
import {
	responseCodec2,
	responseCodec3,
	responseCodec4,
	versionSnapshotResponseCodec,
} from "./plugins-response-codecs.ts";

// ── Plugin catalog sources + federated browse (integrations.sh, …) ────────────

/** Default merged catalog: Ryu Marketplace + built-ins + legacy registry. */
export const PLUGIN_MARKETPLACE_SOURCE_ID = "ryu-marketplace";

export interface PluginCatalogSource {
	baseUrl: string | null;
	builtin: boolean;
	displayName: string;
	id: string;
}

export interface PluginCatalogSources {
	active: string;
	sources: PluginCatalogSource[];
}

interface SourceWire {
	base_url?: string | null;
	builtin?: boolean;
	display_name: string;
	id: string;
}

function toPluginSource(w: SourceWire): PluginCatalogSource {
	return {
		id: w.id,
		displayName: w.display_name,
		builtin: w.builtin ?? false,
		baseUrl: w.base_url ?? null,
	};
}

/** List plugin catalog sources and which one is active. */
export async function fetchPluginSources(
	target: ApiTarget
): Promise<PluginCatalogSources> {
	const json = await request<{
		active?: string;
		sources?: SourceWire[];
	}>(target, "/api/catalog/sources?kind=plugin", undefined, responseCodec2);
	return {
		active: json.active ?? "",
		sources: (json.sources ?? []).map(toPluginSource),
	};
}

/** Select the active plugin catalog source by id. */
export async function selectPluginSource(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<unknown>(
		target,
		"/api/catalog/sources/select",
		{
			method: "POST",
			body: { kind: "plugin", id },
		},
		gatewayJsonValueSchema
	);
}

/** Parameters for adding a custom Claude plugin marketplace as a plugin source. */
export interface AddMarketplaceParams {
	baseUrl: string;
	displayName: string;
	id: string;
}

/** Add a custom Claude plugin marketplace (repo/URL with marketplace.json). */
export async function addMarketplaceSource(
	target: ApiTarget,
	params: AddMarketplaceParams
): Promise<void> {
	const json = await request<{ ok?: boolean; error?: string }>(
		target,
		"/api/catalog/sources",
		{
			method: "POST",
			body: {
				kind: "plugin",
				id: params.id,
				display_name: params.displayName,
				base_url: params.baseUrl,
			},
		},
		responseCodec3
	);
	if (json.ok === false) {
		throw new Error(json.error ?? "Failed to add marketplace");
	}
}

export interface PluginSearchParams {
	cursor?: string;
	limit?: number;
	/** Browse a non-default catalog slice without changing the active-source
	 *  preference. `"community"` routes to Core's GitHub topic-discovery source
	 *  (`?origin=community`), so the Community store section coexists with
	 *  Apps/Plugins instead of replacing them. */
	origin?: "community";
	query?: string;
	/** Browse a specific catalog source WITHOUT writing the node's active-source
	 *  preference. The preference is one global setting, so selecting a source used
	 *  to reassign every other open store tab (and every other client on the node);
	 *  passing the id per request keeps the choice local to the view that made it.
	 *  Omitted ⇒ Core falls back to the stored preference. */
	source?: string;
}

export interface PluginCatalogPage {
	appTotal?: number | null;
	entries: CatalogEntry[];
	nextCursor: string | null;
	note: string | null;
	pluginTotal?: number | null;
	total?: number | null;
}

/** Browse the active plugin catalog source (paginated for federated sources). */
export async function searchPluginCatalog(
	target: ApiTarget,
	params: PluginSearchParams = {}
): Promise<PluginCatalogPage> {
	const q = new URLSearchParams();
	if (params.query) {
		q.set("query", params.query);
	}
	if (params.limit) {
		q.set("limit", String(params.limit));
	}
	if (params.cursor) {
		q.set("cursor", params.cursor);
	}
	if (params.origin) {
		q.set("origin", params.origin);
	}
	if (params.source) {
		q.set("source", params.source);
	}
	const json = parsePluginResponse(
		catalogBrowseSchema,
		await request(
			target,
			`/api/plugins/catalog/browse?${q.toString()}`,
			undefined,
			catalogBrowseSchema
		)
	);
	return {
		appTotal: json.app_total ?? null,
		entries: json.entries ?? [],
		nextCursor: json.next_cursor ?? null,
		note: json.note ?? null,
		pluginTotal: json.plugin_total ?? null,
		total: json.total ?? json.total_count ?? null,
	};
}

/** Detail payload for a federated catalog entry (integrations.sh descriptor). */
export type { VersionSnapshot } from "@ryu/marketplace/catalog/types";

export interface PluginCatalogDetail {
	accentColor?: string | null;
	author?: string | null;
	banner?: CatalogBanner | null;
	capabilities?: string[];
	categories?: string[];
	category?: string | null;
	description?: string | null;
	descriptor?: {
		integration_kind?: string;
		kind?: string;
		url?: string | null;
		domain?: string | null;
	};
	designSystem?: DesignSystemEvidence | null;
	domain?: string | null;
	downloads?: number | null;
	examplePrompts?: string[];
	extensions?: CatalogExtensionSummary[];
	external?: boolean;
	feeds?: string[];
	iconBackground?: string | null;
	iconUrl?: string | null;
	id: string;
	implementation?: CatalogImplementationSummary[];
	integration_kind?: string | null;
	keywords?: string[];
	kind?: string | null;
	layers?: CatalogLayer[];
	license?: string | null;
	name?: string;
	privacyPolicyUrl?: string | null;
	repositoryUrl?: string | null;
	screenshots?: string[];
	source?: string;
	sourceUrl?: string | null;
	surfaceSupport?: CatalogSurfaceSupport[];
	tagline?: string | null;
	tags?: string[];
	termsOfServiceUrl?: string | null;
	updatedAt?: string | null;
	url?: string | null;
	version?: string | null;
	website?: string | null;
}

/** Fetch detail for the selected entry from the active plugin catalog source. */
export async function fetchPluginCatalogDetail(
	target: ApiTarget,
	id: string,
	origin?: "community",
	/** The source the list was browsed from — see {@link PluginSearchParams.source}.
	 *  Must match the browse call, so a detail request resolves against the same
	 *  catalog the card came from. */
	source?: string
): Promise<PluginCatalogDetail> {
	const q = new URLSearchParams({ id });
	if (origin) {
		q.set("origin", origin);
	}
	if (source) {
		q.set("source", source);
	}
	const detail = parsePluginResponse(
		catalogDetailWireSchema,
		await request(
			target,
			`/api/plugins/catalog/detail?${q.toString()}`,
			undefined,
			catalogDetailWireSchema
		)
	);
	const author =
		pluginStringField(detail.author) ??
		pluginStringField(pluginRecord(detail.author)?.name) ??
		null;
	return { ...detail, author };
}

/** `GET /api/plugins/catalog/version-detail` — the listing as it stood at one
 *  published version's tag.
 *
 *  `tag` is the Versions tab's `version` field, which IS the raw git tag_name
 *  (`v1.2.0`, not `1.2.0`), so it passes straight through with no normalisation.
 *
 *  Resolves to `null` rather than throwing when the tag has no readable manifest —
 *  the normal case for tags predating the listing being packaged, which the UI
 *  renders as "not published at this tag", not as a failure. */
export async function fetchPluginVersionDetail(
	target: ApiTarget,
	repo: string,
	tag: string
): Promise<VersionSnapshot | null> {
	const q = new URLSearchParams({ repo, tag });
	try {
		return await request<VersionSnapshot>(
			target,
			`/api/plugins/catalog/version-detail?${q.toString()}`,
			undefined,
			versionSnapshotResponseCodec
		);
	} catch {
		return null;
	}
}

/** `GET /api/plugins/catalog/channels` — the release trains a listing publishes,
 *  each with the version it currently resolves to.
 *
 *  Both lookups in one call: `id` asks the marketplace (trains that can actually
 *  be installed), `repo` derives them from the repository's release tags (what an
 *  author tagged — browse-only). Core prefers the marketplace answer when it has
 *  one, and flags each row with `installable` so a picker never offers a
 *  selection it cannot act on.
 *
 *  Resolves to `[]` on any failure. That is "no trains known", NOT "stable only":
 *  the caller renders no picker rather than inventing one. */
export async function fetchPluginChannels(
	target: ApiTarget,
	id: string,
	repo?: string | null
): Promise<CatalogChannel[]> {
	const q = new URLSearchParams({ id });
	if (repo) {
		q.set("repo", repo);
	}
	try {
		const body = await request<{
			channels?: CatalogChannel[];
		}>(
			target,
			`/api/plugins/catalog/channels?${q.toString()}`,
			undefined,
			responseCodec4
		);
		return body.channels ?? [];
	} catch {
		return [];
	}
}

/** `POST /api/plugins/install` — install a plugin from an `https://` manifest.json URL.
 *  Core records it installed+disabled (enable is a separate, grant-gated step). */
export async function installAppFromUrl(
	target: ApiTarget,
	url: string
): Promise<void> {
	const resp = await authenticatedFetch(target, "/api/plugins/install", {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		body: JSON.stringify({ url }),
	});
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, "/api/plugins/install");
		throw Object.assign(new Error(err.message), err);
	}
}

/**
 * `POST /api/plugins/catalog/install { id }` — install a PLUGIN-kind item from the
 * active marketplace catalog (the CODE CARRIAGE sink). Core resolves the item's
 * descriptor, VERIFIES the ed25519 manifest signature, and recomputes
 * `sha256(ui_code)` against the signed `ui_code_sha256` — rejecting a tampered
 * bundle fail-closed. Only VERIFIED code is stored; once the plugin is enabled the
 * existing `GET /api/plugins/:id/ui-bundle` + `PluginHostPanel` path renders it.
 *
 * `buyerToken` (the control-plane session bearer) is forwarded as
 * `x-ryu-buyer-token` for optional account-aware Marketplace operations; it is
 * not required for a paid or free plugin install.
 */
export async function installPluginFromCatalog(
	target: ApiTarget,
	id: string,
	buyerToken?: string | null,
	/** The release train to install from — omit (or pass `stable`) for the ordinary
	 *  published version. Core PERSISTS the choice, so the plugin keeps following
	 *  this train on every later update instead of being pulled back to stable. */
	channel?: string | null
): Promise<void> {
	const headers = makeHeaders(target.token, target.userJwt);
	if (buyerToken) {
		headers["x-ryu-buyer-token"] = buyerToken;
	}
	const resp = await authenticatedFetch(
		target,
		"/api/plugins/catalog/install",
		{
			method: "POST",
			headers,
			body: JSON.stringify(channel ? { id, channel } : { id }),
		}
	);
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, "/api/plugins/catalog/install");
		throw Object.assign(new Error(err.message), err);
	}
}

/** Install one exact historical Marketplace version through Core's signed
 * catalog resolver. This intentionally has a separate name so ordinary channel
 * installs cannot accidentally start carrying a one-off version pin. */
export async function installPluginFromCatalogAtVersion(
	target: ApiTarget,
	id: string,
	version: string,
	buyerToken?: string | null
): Promise<void> {
	const headers = makeHeaders(target.token, target.userJwt);
	if (buyerToken) {
		headers["x-ryu-buyer-token"] = buyerToken;
	}
	const resp = await authenticatedFetch(
		target,
		"/api/plugins/catalog/install",
		{
			method: "POST",
			headers,
			body: JSON.stringify({ id, version }),
		}
	);
	if (!resp.ok) {
		const err = await parseLifecycleError(resp, "/api/plugins/catalog/install");
		throw Object.assign(new Error(err.message), err);
	}
}
