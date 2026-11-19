// apps/desktop/src/lib/api/marketplace-detail.ts
//
// Listing detail fetch and its field normalizers.
// Split out of marketplace.ts (which re-exports it); see that file's header
// for the control-plane contract.

import type { LanguagePackSummary } from "@ryu/i18n/core";
import type {
	MarketplaceBundleMember,
	MarketplaceCommunityStats,
} from "@ryu/marketplace/catalog/bundle-types";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import type { CatalogBanner } from "@ryu/marketplace/catalog/types";
import type { MarketplaceKind } from "@ryu/marketplace/types";
import type { VerificationDetails } from "@ryu/ui/components/verification-popover.tsx";
import {
	type PublisherTrustLevel,
	type PublisherTrustSource,
	publisherTrustFromOrgFlag,
} from "@ryuhq/protocol/publisher-trust";
import type { PricingView } from "./marketplace-cards.ts";
import { authHeaders, BASE, toError } from "./marketplace-http.ts";
import { recordValue, stringValue } from "./marketplace-private-share.ts";
import {
	marketplaceBundleKindSchema,
	marketplaceDetailWireSchema,
	parseMarketplaceResponse,
} from "./marketplace-response-contracts.ts";
import {
	type MarketplaceValue,
	marketplaceNonemptyStrings,
	marketplaceNumberField,
	marketplaceStringField,
	type marketplaceValueSchema,
} from "./marketplace-wire-values.ts";

// ── Listing detail (icon, screenshots, ratings) ─────────────────────────────

/**
 * A bundled Runnable (skill / tool / mcp / agent) shipped by a listing, with its
 * enable state. Rendered in the detail dialog's "Skills" section. Field names
 * mirror Core's runnable entry (`id`, `kind`, `name`) plus an optional
 * `description` and `enabled` flag for the preview toggle.
 */
export interface DetailRunnable {
	description: string | null;
	enabled: boolean;
	id: string;
	kind: string;
	name: string;
}

/**
 * An optional companion/config "Setup" card for a listing (e.g. "install this
 * Chrome extension"). A listing may carry one card or an ordered array of steps.
 */
export interface DetailSetupStep {
	actionLabel: string | null;
	actionUrl: string | null;
	description: string | null;
	title: string | null;
}

/**
 * The full listing detail for one item, enriched with store presentation
 * (logo, screenshots, banner, category) and the aggregate rating. Purely
 * additive over the catalog card — the manifest/descriptor/signature fields the
 * install path needs are passed through untyped here (this client only consumes
 * the presentation layer).
 *
 * The App-Store preview fields below (tagline, description, developer, website,
 * policy links, capabilities, examplePrompts, setup, runnables) are all OPTIONAL
 * and additive: an older listing missing them still renders. Field names align
 * with the Claude `.claude-plugin/marketplace.json` plugin-entry standard where
 * one exists (`developer`←`author`, `website`←`homepage`, `version`, `category`),
 * plus Ryu extensions for the richer preview.
 */
export interface MarketplaceDetail {
	/** Optional manifest banner used by the compact prompt preview. */
	banner: CatalogBanner | null;
	bannerUrl: string | null;
	bundleMembers: MarketplaceBundleMember[];
	bundleSourceUrl: string | null;
	/** Human-readable capability labels; derived from permission grants when the
	 *  source omits an explicit list. Empty when neither is present. */
	capabilities: string[];
	category: string | null;
	communityStats: MarketplaceCommunityStats;
	/** Long plain/markdown description (Ryu ext / Claude `description`). */
	description: string | null;
	/** Publisher name (from Claude `author`; `author.name` when an object). */
	developer: string | null;
	/** Short one-line pitch under the name (Ryu ext). */
	examplePrompts: string[];
	firstParty: boolean;
	iconUrl: string | null;
	id: string;
	/** For an Agent Template: whose accounts the agent works with once added
	 *  (`managed` acts as you, `individual` has its own identity, `mixed` both).
	 *  Null for other kinds, and when the marketplace does not report it. */
	identityMode: MarketplaceAgentIdentityMode | null;
	kind: MarketplaceKind;
	languagePack: LanguagePackSummary | null;
	name: string;
	orgVerified: boolean;
	orgVerifiedTier: string | null;
	pricing: PricingView | null;
	privacyPolicyUrl: string | null;
	publisherTrust: PublisherTrustLevel;
	publisherTrustSource: PublisherTrustSource;
	publisherVerification: VerificationDetails | null;
	ratingAverage: number;
	ratingCount: number;
	/** Bundled skills/tools/mcp/agents with their enable state (Ryu ext). */
	runnables: DetailRunnable[];
	/** Ordered screenshot URLs for the gallery (may be empty). */
	screenshots: string[];
	/** Optional companion/config setup steps (Ryu ext). */
	setup: DetailSetupStep[];
	tagline: string | null;
	termsOfServiceUrl: string | null;
	version: string;
	/** External homepage (from Claude `homepage`). */
	website: string | null;
}

/** Core's `AgentIdentityMode` wire values, as a listing detail reports them. */
export type MarketplaceAgentIdentityMode = "managed" | "individual" | "mixed";

/** Only an exact mode is shown; anything else is left unlabelled, never guessed. */
export function marketplaceAgentIdentityMode(
	value: MarketplaceValue | undefined
): MarketplaceAgentIdentityMode | null {
	return value === "managed" || value === "individual" || value === "mixed"
		? value
		: null;
}

/** Readable labels for the permission grants the store surfaces most often. Keys
 *  are matched case-insensitively; anything unmapped is humanized generically. */
const GRANT_CAPABILITY_LABELS = {
	"mcp:web_scrape": "Web scraping",
	"mcp:web_search": "Web search",
	"mcp:web_browse": "Web browsing",
	"mcp:filesystem": "File access",
	"mcp:shell": "Shell access",
	"chat.sendfollowup": "Interactive",
	"chat.read": "Read chat",
	"net:fetch": "Network access",
	"fs:read": "Read files",
	"fs:write": "Write files",
} satisfies Record<string, string>;

/** Turn a raw permission-grant id into a human label: a curated match first, then
 *  a generic humanization (drop the `scope:`/`scope.` prefix, split on separators,
 *  title-case the words). */
function grantToCapability(grant: string): string {
	const key = grant.trim().toLowerCase();
	const mapped = Object.entries(GRANT_CAPABILITY_LABELS).find(
		([grant]) => grant === key
	)?.[1];
	if (mapped) {
		return mapped;
	}
	const body = grant.includes(":")
		? grant.slice(grant.indexOf(":") + 1)
		: grant;
	const words = body
		.split(/[._\-/\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1));
	return words.join(" ") || grant;
}

/** Coerce an unknown JSON value into a string array of non-empty strings. */
const toStringArray = marketplaceNonemptyStrings;

function resolveBundleMembers(
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
): MarketplaceBundleMember[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const members: MarketplaceBundleMember[] = [];
	const seen = new Set<string>();
	for (const entry of value.slice(0, 64)) {
		const raw = recordValue(entry);
		if (!raw) {
			continue;
		}
		const id = marketplaceStringField(raw.id)?.trim() ?? "";
		const parsedKind = marketplaceBundleKindSchema.safeParse(
			marketplaceStringField(raw.kind)?.trim()
		);
		if (!parsedKind.success) {
			continue;
		}
		const kind = parsedKind.data;
		if (!id || seen.has(`${kind}:${id}`)) {
			continue;
		}
		seen.add(`${kind}:${id}`);
		members.push({
			id,
			kind,
			name: marketplaceStringField(raw.name) ?? null,
			required: raw.required !== false,
			source: marketplaceStringField(raw.source) ?? null,
		});
	}
	return members;
}

/** Resolve the developer/publisher name from either a plain string or a Claude
 *  `author` object (`{ name }`). */
function resolveDeveloper(raw: {
	developer?: MarketplaceValue;
	author?: MarketplaceValue;
}): string | null {
	const developer = marketplaceStringField(raw.developer);
	if (developer) {
		return developer;
	}
	const author = marketplaceStringField(raw.author);
	if (author) {
		return author;
	}
	return marketplaceStringField(recordValue(raw.author)?.name) ?? null;
}

/** Normalize the `setup` field, which may be a single card OR an array of steps. */
function resolveSetup(
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
): DetailSetupStep[] {
	const rawSteps = Array.isArray(value) ? value : value ? [value] : [];
	const steps: DetailSetupStep[] = [];
	for (const step of rawSteps) {
		const s = recordValue(step);
		if (!s) {
			continue;
		}
		const title = marketplaceStringField(s.title) ?? null;
		const description = marketplaceStringField(s.description) ?? null;
		const actionLabel = marketplaceStringField(s.actionLabel) ?? null;
		// The setup CTA renders as an <a href>, so scheme-check it (untrusted
		// catalog source) — a non-http(s) actionUrl is dropped, not rendered.
		const actionUrl = safeHttpUrl(s.actionUrl);
		// Skip an entry with no renderable content at all.
		if (title || description || actionUrl) {
			steps.push({ title, description, actionLabel, actionUrl });
		}
	}
	return steps;
}

/** Keep the manifest banner's prompt-palette fields typed without trusting the
 *  opaque control-plane payload. The renderer applies a second CSS/color guard. */
function resolveCatalogBanner(
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
): CatalogBanner | null {
	const raw = recordValue(value);
	if (!raw) {
		return null;
	}
	const banner: CatalogBanner = {};
	const background = stringValue(raw.background);
	if (background) {
		banner.background = background;
	}
	const colors = toStringArray(raw.colors);
	if (colors.length > 0) {
		banner.colors = colors;
	}
	const imageUrl = stringValue(raw.imageUrl ?? raw.image_url);
	if (imageUrl) {
		banner.imageUrl = imageUrl;
	}
	const style = stringValue(raw.style);
	if (
		style === "gradient" ||
		style === "animated-gradient" ||
		style === "dither" ||
		style === "flat" ||
		style === "image"
	) {
		banner.style = style;
	}
	if (marketplaceNumberField(raw.seed) !== undefined) {
		banner.seed = Math.trunc(marketplaceNumberField(raw.seed) ?? 0);
	}
	return Object.keys(banner).length > 0 ? banner : null;
}

/** Normalize the `runnables` field into typed entries with enable state. */
function resolveRunnables(
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
): DetailRunnable[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: DetailRunnable[] = [];
	for (const entry of value) {
		const r = recordValue(entry);
		if (!r) {
			continue;
		}
		const id = marketplaceStringField(r.id) ?? null;
		const name = marketplaceStringField(r.name) ?? null;
		// The server keeps a runnable descriptor with id OR name (id may be null),
		// so mirror that here: require at least one, and fall back across them for
		// the key/label so a name-only runnable still renders (and the Skills count
		// stays accurate) instead of being silently dropped.
		if (!(id || name)) {
			continue;
		}
		out.push({
			id: id ?? name ?? "",
			name: name ?? id ?? "",
			kind: marketplaceStringField(r.kind) ?? "runnable",
			description: marketplaceStringField(r.description) ?? null,
			enabled: r.enabled === true,
		});
	}
	return out;
}

/** Resolve capabilities: an explicit list wins; otherwise derive from permission
 *  grants (either `capabilities`/`permission_grants`/`permissionGrants`). */
function resolveCapabilities(raw: {
	capabilities?: MarketplaceValue;
	permission_grants?: MarketplaceValue;
	permissionGrants?: MarketplaceValue;
}): string[] {
	const explicit = toStringArray(raw.capabilities);
	if (explicit.length > 0) {
		return explicit;
	}
	const grants = [
		...toStringArray(raw.permission_grants),
		...toStringArray(raw.permissionGrants),
	];
	const seen = new Set<string>();
	const labels: string[] = [];
	for (const g of grants) {
		const label = grantToCapability(g);
		if (!seen.has(label)) {
			seen.add(label);
			labels.push(label);
		}
	}
	return labels;
}

/** Fetch the full listing detail for one item. Public (no auth required). */
export async function fetchDetail(
	kind: MarketplaceKind,
	id: string
): Promise<MarketplaceDetail> {
	const q = new URLSearchParams({ kind, id });
	const resp = await fetch(`${BASE}/catalog/detail?${q.toString()}`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		marketplaceDetailWireSchema,
		await resp.json()
	);
	const communityStats = recordValue(json.communityStats);
	return {
		banner: resolveCatalogBanner(json.banner),
		bundleMembers: resolveBundleMembers(json.bundleMembers),
		bundleSourceUrl: safeHttpUrl(json.bundleSourceUrl),
		communityStats: {
			downloads: marketplaceNumberField(communityStats?.downloads) ?? 0,
			instances: marketplaceNumberField(communityStats?.instances) ?? 0,
			runs: marketplaceNumberField(communityStats?.runs) ?? 0,
		},
		id: json.id ?? id,
		identityMode: marketplaceAgentIdentityMode(json.identityMode),
		kind: json.kind ?? kind,
		languagePack: json.languagePack ?? null,
		name: json.name ?? "",
		firstParty: Boolean(json.firstParty),
		version: json.version ?? "",
		orgVerified: Boolean(json.orgVerified),
		orgVerifiedTier: json.orgVerifiedTier ?? null,
		publisherTrust:
			json.publisherTrust ??
			publisherTrustFromOrgFlag({
				firstParty: json.firstParty,
				orgVerified: json.orgVerified,
			}).level,
		publisherTrustSource:
			json.publisherTrustSource ??
			publisherTrustFromOrgFlag({
				firstParty: json.firstParty,
				orgVerified: json.orgVerified,
			}).source,
		publisherVerification: json.publisherVerification ?? null,
		pricing: json.pricing ?? null,
		iconUrl: safeHttpUrl(json.iconUrl),
		bannerUrl: safeHttpUrl(json.bannerUrl),
		category: json.category ?? null,
		ratingAverage: json.ratingAverage ?? 0,
		ratingCount: json.ratingCount ?? 0,
		screenshots: toStringArray(json.screenshots)
			.map((url) => safeHttpUrl(url))
			.filter((url): url is string => Boolean(url)),
		tagline: marketplaceStringField(json.tagline) ?? null,
		description: marketplaceStringField(json.description) ?? null,
		developer: resolveDeveloper(json),
		website: safeHttpUrl(json.website) ?? safeHttpUrl(json.homepage),
		privacyPolicyUrl: safeHttpUrl(json.privacyPolicyUrl),
		termsOfServiceUrl: safeHttpUrl(json.termsOfServiceUrl),
		capabilities: resolveCapabilities(json),
		examplePrompts: toStringArray(json.examplePrompts),
		setup: resolveSetup(json.setup),
		runnables: resolveRunnables(json.runnables),
	};
}
