import type {
	CardDither,
	CardThemePreview,
	CatalogBanner,
	CatalogLayer,
	CatalogSurfaceSupport,
} from "@ryu/marketplace/catalog/types";
import { type ApiTarget, request } from "./client.ts";
import type { PluginDocument } from "./plugin-wire-values.ts";
import { responseCodec1 } from "./plugins-response-codecs.ts";

// ── App catalog (browse remote registry + install-from-URL) ───────────────────

/** Presentational banner descriptor for an app's hero region.
 *
 *  Re-exported rather than re-declared: this file used to carry its own copy with a
 *  REQUIRED `colors`, so the two drifted the moment the render layer learned
 *  `background`/`imageUrl` — the wire carried those keys through fine (the entry is
 *  verbatim JSON) while the desktop type could not express them. */
export type { CatalogBanner };

/** A single installable-app entry from Core's remote registry
 *  (`GET /api/plugins/catalog`). Pure discovery metadata — lifecycle state
 *  (installed/enabled) lives on {@link AppInfo} and is joined by `id`. */
export interface CatalogEntry {
	/** Hex accent color used for chrome tinting / banner fallback. */
	accent_color?: string | null;
	author?: string | null;
	/** Hero-banner descriptor (colors + gradient/dither style). */
	banner?: CatalogBanner | null;
	built_in: boolean;
	/** Ids of separate plugins this app ships as a logical bundle. */
	bundles?: string[] | null;
	capabilities?: string[];
	/** Which marketplace this row was browsed from. Stamped by Core only in the
	 *  all-marketplaces view (`?source=all`); absent when one source is browsed. */
	catalog_source_id?: string;
	/** Store category label (e.g. "Productivity"). */
	category?: string | null;
	description: string;
	/** When true, this row is a browse-only integration descriptor (integrations.sh). */
	descriptor_only?: boolean;
	/** Publisher / developer name shown on the card + detail. */
	developer?: string | null;
	/** Relative Ryu proxy route for the signed release asset. */
	download_url?: string | null;
	/** Public release-asset downloads, summed across release payloads only. */
	downloads?: number | null;
	example_prompts?: string[];
	external?: boolean;
	/** Redacted GitHub repository/release provenance. */
	github_source?: PluginDocument | null;
	homepage?: string | null;
	/** Icon-primitive glyph id painted inside the tile. Declared here as well as on
	 *  `@ryu/marketplace`'s `CatalogEntry` because it is on the same wire and the
	 *  Store's Home rows read it — without it those rows fell back to the
	 *  generative placeholder and Home was the one tab whose icons were wrong. */
	icon?: string | null;
	/** Optional CSS background for the icon square (e.g. a gradient). */
	icon_background?: string | null;
	/** The listing's dithered icon wash, when it declares one. */
	icon_dither?: CardDither | null;
	/** Remote icon URL when provided by the catalog source. */
	icon_url?: string | null;
	id: string;
	/** MCP / OpenAPI / GraphQL / CLI when sourced from integrations.sh. */
	integration_kind?: string | null;
	/** Link to the integration docs, spec, or MCP endpoint. */
	integration_url?: string | null;
	keywords?: string[];
	kinds: string[];
	layers?: CatalogLayer[];
	/** SPDX licence id, when the source reports one. */
	license?: string | null;
	/** Server-derived A Major Pass inclusion marker for catalog presentation. */
	membership_included?: boolean;
	name: string;
	/** The publishing organization's identity is verified by Ryu (server-derived).
	 *  A separate axis from `reviewed` and from signature verification. */
	org_verified?: boolean;
	/** The verified org's tier ("official", "partner", …); a qualifier only. */
	org_verified_tier?: string | null;
	/** Who listed this and how vetted it is. `"community"` = discovered
	 *  automatically from a public GitHub topic and NOT reviewed by Ryu; absent
	 *  = first-party. MUST stay snake_case — this is the exact key Core's
	 *  `plugin_marketplace_item_to_entry` emits, and a camelCase spelling would
	 *  read as undefined, i.e. an unreviewed listing rendered with no notice. */
	origin?: "community" | "first_party" | null;
	/** SHA-256 of the immutable package release asset. */
	package_checksum?: string | null;
	/** Canonical portable package kind for GitHub-backed marketplace entries. */
	package_kind?: string | null;
	permission_grants: string[];
	/** Commerce disclosure for a PAID listing; absent/null = free. Present on cards
	 *  in the unified first-party view, where free (git catalog) and paid (hosted)
	 *  listings sit in one list — without it a paid item is indistinguishable from a
	 *  free one until checkout. Display only; it does not gate the install handoff. */
	pricing?: {
		amountMinor?: number;
		currency?: string;
		kind?: string;
	} | null;
	privacy_policy_url?: string | null;
	/** Which discovery source produced this listing (e.g. `"github-topic"`). */
	provenance?: string | null;
	/** Publisher identity mark. An unrecognized wire value parses as absent
	 *  rather than failing the whole catalog page. */
	publisher_trust?: "gold" | "blue" | "dotted" | null;
	/** Denormalized rating aggregate (0–5 mean + count), so a card and the detail
	 *  header show stars without loading the review list. Absent = unrated. */
	rating_average?: number | null;
	rating_count?: number | null;
	/** Repository a community listing was discovered from. */
	repo_url?: string | null;
	repository_url?: string | null;
	/** Plugin-to-plugin dependencies that must be enabled first (the manifest's
	 *  `requires`). Emitted by Core's catalog source when non-empty; absent = none.
	 *  Kept in sync with `@ryu/marketplace/catalog/types`' `CatalogEntry`, which is
	 *  the shape the shared catalog sections consume. */
	requires?: {
		apps?: { id: string; min_version?: string | null }[];
		grants?: string[];
	} | null;
	/** False when nobody at Ryu vetted this listing. Absent ≠ reviewed. */
	reviewed?: boolean;
	/** The bundled sub-items this item ships (the manifest runnables). */
	runnables?: { id: string; kind: string; name?: string }[];
	screenshots?: string[];
	source: string;
	/** Upstream popularity signal (GitHub stars) for unmoderated listings. */
	stars?: number | null;
	/** Per-surface support levels, preserved for shared Marketplace detail. */
	surface_support?: CatalogSurfaceSupport[];
	/** Short one-line pitch shown under the name. */
	tagline?: string | null;
	tags: string[];
	terms_of_service_url?: string | null;
	/** A theme listing's own palette (manifest `contributes.themes[0].preview`).
	 *  The Store paints this as its icon square instead of a dither avatar or a
	 *  generic glyph. Absent on everything that is not a theme. */
	theme_preview?: CardThemePreview | null;
	/** Explicit app-vs-plugin discriminator (preferred over the kinds derivation). */
	type?: "app" | "plugin";
	version: string;
	website?: string | null;
}

/** `GET /api/plugins/catalog` — browse installable apps from the remote registry. */
export async function fetchAppsCatalog(
	target: ApiTarget
): Promise<CatalogEntry[]> {
	const data = await request<{ entries?: CatalogEntry[] }>(
		target,
		"/api/plugins/catalog",
		undefined,
		responseCodec1
	);
	return data.entries ?? [];
}
