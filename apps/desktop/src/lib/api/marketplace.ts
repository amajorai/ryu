// apps/desktop/src/lib/api/marketplace.ts
//
// Typed client for the Ryu Marketplace money layer (monetization #492, spec §3).
// Browse paid items, start a Stripe Connect purchase, and list owned licenses.
//
// Like credits.ts / seller.ts (and unlike the Core-node catalog clients in
// skills.ts / models.ts), this targets the identity/control-plane server (:3000,
// BACKEND_URL), authenticated with the Better-Auth session bearer. Pricing,
// purchases, and licenses are a "what is paid for" concern and live in the
// control plane (packages/api `/api/marketplace`, MongoDB), alongside billing.
//
// IMPORTANT: this is the ONLY place the desktop sees per-item PRICING. The Core
// catalog adapter (browse via Core) deliberately strips pricing, so the buy
// affordances key off this server's catalog, not Core's. A free item never
// carries a `pricing` sub-doc here, so it renders with no price/buy affordance by
// construction.
//
//   GET  /api/marketplace/catalog?kind=&query=  -> live items + pricing (public)
//   POST /api/marketplace/purchase              -> a Stripe Checkout URL (Connect)
//   GET  /api/marketplace/licenses              -> the active org's owned items
//
// Money amounts are integer minor units (cents); {@link formatPrice} converts for
// display. The purchase opens a hosted Stripe URL externally and the license is
// granted asynchronously by the server webhook, so the UI re-fetches licenses on
// window focus (mirrors useCreditsWallet).

import type { LanguagePackSummary } from "@ryu/i18n/core";
import type {
	MarketplaceBundleMember,
	MarketplaceCommunityStats,
} from "@ryu/marketplace/catalog/bundle-types";
import { MARKETPLACE_BROWSE_KINDS } from "@ryu/marketplace/catalog/chrome/marketplace-sections";
import type { CatalogBanner } from "@ryu/marketplace/catalog/types";
import type { VerificationDetails } from "@ryu/ui/components/verification-popover.tsx";
import { formatMinorCurrency } from "@ryu/ui/lib/number-format.ts";
import {
	type PublisherTrustLevel,
	type PublisherTrustSource,
	resolvePublisherTrust,
} from "@ryuhq/protocol/publisher-trust";
import { BACKEND_URL, TOKEN_KEY } from "@/lib/auth-client.ts";
import {
	type ApiTarget,
	buyerTokenHeader,
	request,
} from "@/src/lib/api/client.ts";

/** The catalog kinds, matching the server's `MarketplaceKind`.
 *
 * `agent` is a user-PUBLISHED Agent Template (instructions + model preference
 * + declared dependencies), not an ACP runtime like Claude Code — those live in
 * Core's own Agents catalog and never reach this client. */
export type MarketplaceKind =
	| "app"
	| "plugin"
	| "skill"
	| "model"
	| "mcp"
	| "agent"
	| "stack_template"
	| "workflow"
	| "theme"
	| "language_pack"
	| "space"
	| "profile"
	| "output_style"
	| "bundle";

/** Pricing model for a paid item. Free items carry no pricing at all. */
export type PricingModel = "one_time" | "subscription" | "bounded_updates";

/** Purchase/license lifecycle, mirroring the server's `LicenseStatus`. */
export type LicenseStatus = "active" | "expired" | "refunded" | "disputed";

/** The pricing view the server surfaces for a paid item (null ⇒ free). */
export interface PricingView {
	amountMinor: number;
	currency: string;
	interval: "month" | "year";
	maxUpdates: number | null;
	model: PricingModel;
	platformFeeBps: number;
	sellerOrgId: string;
}

/**
 * Manifest signature/provenance status for an item (#450). This is the
 * verification verdict the Gateway issues over a manifest's signature, surfaced
 * for display so the Store can flag unsigned or tampered items before install:
 *   - "verified": a valid Gateway/seller signature was checked and passed.
 *   - "unsigned": no signature is present (a seed/legacy item; install allowed
 *     but provenance is unproven).
 *   - "invalid":  a signature is present but failed verification (tampered, so
 *     Core refuses to install).
 *   - "unknown":  the server did not report a verification status.
 *
 * NOTE (#450, PARTIAL): the control-plane catalog response does NOT yet emit a
 * per-item verification verdict. Core verifies signatures server-side as an
 * install GATE (apps/core catalog_source verify_manifest_signature: fail-closed
 * on tamper, silently allow unsigned) but never surfaces the result as a field.
 * Until a Core/server `verified` (or `signature`) field is added to the catalog
 * payload, this resolves from the trusted-first-party flag as a best-effort proxy
 * (first-party items are Ryu-published and signed). The display scaffolding below
 * is ready to consume the real field the moment it exists.
 */
export type VerificationStatus =
	| "verified"
	| "unsigned"
	| "invalid"
	| "unknown";

/** A flat marketplace catalog card. `pricing` is null for free items. */
export interface MarketplaceCard {
	artifactKinds: string[];
	author: string | null;
	bundleMemberCount: number;
	/** Store-taxonomy category label (e.g. "Productivity"), or null. */
	category: string | null;
	communityStats: MarketplaceCommunityStats;
	description: string | null;
	downloadUrl: string | null;
	firstParty: boolean;
	githubSource: Record<string, unknown> | null;
	/** Resolvable logo URL (https / data:), or null when the item has no icon. */
	iconUrl: string | null;
	id: string;
	installedVersion: string | null;
	installSource: string | null;
	kind: MarketplaceKind;
	languagePack: LanguagePackSummary | null;
	latestVersion: string | null;
	/** Public like total and current viewer state from the catalog read. */
	likeCount: number;
	likedByMe: boolean;
	/** True when the publisher's supported paid offer is covered by A Major Pass. */
	membershipIncluded: boolean;
	name: string;
	orgVerified: boolean;
	orgVerifiedTier: string | null;
	packageChecksum: string | null;
	packageKind: string | null;
	packageSecurity: Record<string, unknown> | null;
	packageSource: Record<string, unknown> | string | null;
	pricing: PricingView | null;
	publisherTrust: PublisherTrustLevel;
	publisherTrustSource: PublisherTrustSource;
	publisherVerification: VerificationDetails | null;
	/** Mean of all published review ratings (0 when there are no reviews). */
	ratingAverage: number;
	/** Total count of published reviews. */
	ratingCount: number;
	requirements: Record<string, unknown>;
	scopes: string[];
	targets: string[];
	updateAvailable: boolean;
	updatePreview: Record<string, unknown> | null;
	/** Manifest signature verdict for display (#450). See {@link VerificationStatus}. */
	verification: VerificationStatus;
	version: string;
}

/** Wire shape of a catalog card before client normalization. Forward-compatible:
 *  `verified`/`signature` are optional and only emitted once Core/server adds them. */
interface MarketplaceCardWire
	extends Omit<
		MarketplaceCard,
		| "verification"
		| "bundleMemberCount"
		| "communityStats"
		| "likeCount"
		| "likedByMe"
		| "orgVerified"
		| "orgVerifiedTier"
		| "membershipIncluded"
		| "publisherTrust"
		| "publisherTrustSource"
		| "publisherVerification"
		| "artifactKinds"
		| "packageKind"
		| "packageSource"
		| "packageChecksum"
		| "packageSecurity"
		| "githubSource"
		| "languagePack"
		| "downloadUrl"
		| "targets"
		| "scopes"
		| "requirements"
		| "installedVersion"
		| "latestVersion"
		| "updateAvailable"
		| "updatePreview"
	> {
	artifactKinds?: string[] | null;
	bundleMemberCount?: number | null;
	communityStats?: Partial<MarketplaceCommunityStats> | null;
	downloadUrl?: string | null;
	githubSource?: Record<string, unknown> | null;
	installedVersion?: string | null;
	languagePack?: LanguagePackSummary | null;
	latestVersion?: string | null;
	likeCount?: number | null;
	likedByMe?: boolean | null;
	membershipIncluded?: boolean | null;
	orgVerified?: boolean | null;
	orgVerifiedTier?: string | null;
	packageChecksum?: string | null;
	packageKind?: string | null;
	packageSecurity?: Record<string, unknown> | null;
	packageSource?: Record<string, unknown> | string | null;
	publisherTrust?: PublisherTrustLevel | null;
	publisherTrustSource?: PublisherTrustSource | null;
	publisherVerification?: VerificationDetails | null;
	requirements?: Record<string, unknown> | null;
	scopes?: string[] | null;
	/** Future Core/server field: presence implies signed (verdict still preferred). */
	signature?: string | null;
	targets?: string[] | null;
	updateAvailable?: boolean | null;
	updatePreview?: Record<string, unknown> | null;
	/** Future Core/server field: the manifest verification verdict, if reported. */
	verified?: VerificationStatus | boolean | null;
}

/**
 * Resolve the verification verdict for a card. Prefers an explicit server-reported
 * `verified` field (the #450 target) and degrades gracefully when it is absent: a
 * present signature ⇒ "verified" (the server only relays signatures it accepted),
 * a trusted first-party item ⇒ "verified" (Ryu-published and signed), otherwise
 * "unknown" (provenance not reported, so do NOT claim "verified").
 */
function resolveVerification(card: MarketplaceCardWire): VerificationStatus {
	if (typeof card.verified === "string") {
		return card.verified;
	}
	if (card.verified === true) {
		return "verified";
	}
	if (card.verified === false) {
		return "invalid";
	}
	if (card.signature) {
		return "verified";
	}
	if (card.firstParty) {
		return "verified";
	}
	return "unknown";
}

function toMarketplaceCard(card: MarketplaceCardWire): MarketplaceCard {
	const { verified, signature, ...rest } = card;
	return {
		...rest,
		artifactKinds: rest.artifactKinds ?? [],
		bundleMemberCount:
			typeof card.bundleMemberCount === "number" ? card.bundleMemberCount : 0,
		iconUrl: rest.iconUrl ?? null,
		category: rest.category ?? null,
		communityStats: {
			downloads:
				typeof card.communityStats?.downloads === "number"
					? card.communityStats.downloads
					: 0,
			instances:
				typeof card.communityStats?.instances === "number"
					? card.communityStats.instances
					: 0,
			runs:
				typeof card.communityStats?.runs === "number"
					? card.communityStats.runs
					: 0,
		},
		likeCount: typeof card.likeCount === "number" ? card.likeCount : 0,
		likedByMe: card.likedByMe === true,
		orgVerified: Boolean(card.orgVerified),
		orgVerifiedTier: card.orgVerifiedTier ?? null,
		publisherTrust:
			card.publisherTrust ??
			resolvePublisherTrust({
				firstParty: card.firstParty,
				ryuStaffVerified: card.orgVerified,
			}).level,
		publisherTrustSource:
			card.publisherTrustSource ??
			resolvePublisherTrust({
				firstParty: card.firstParty,
				ryuStaffVerified: card.orgVerified,
			}).source,
		publisherVerification: card.publisherVerification ?? null,
		packageKind: rest.packageKind ?? null,
		packageSource: rest.packageSource ?? null,
		packageChecksum: rest.packageChecksum ?? null,
		packageSecurity: rest.packageSecurity ?? null,
		githubSource: rest.githubSource ?? null,
		languagePack: rest.languagePack ?? null,
		downloadUrl: rest.downloadUrl ?? null,
		pricing: rest.pricing
			? {
					...rest.pricing,
					interval: rest.pricing.interval === "year" ? "year" : "month",
				}
			: null,
		targets: rest.targets ?? [],
		scopes: rest.scopes ?? [],
		requirements: rest.requirements ?? {},
		installedVersion: rest.installedVersion ?? null,
		latestVersion: rest.latestVersion ?? null,
		membershipIncluded: Boolean(card.membershipIncluded),
		updateAvailable: Boolean(rest.updateAvailable),
		updatePreview: rest.updatePreview ?? null,
		ratingAverage: rest.ratingAverage ?? 0,
		ratingCount: rest.ratingCount ?? 0,
		verification: resolveVerification(card),
	};
}

/** One owned license, enriched with the item's display name (#492). */
export interface OwnedLicense {
	buyerOrgId: string;
	buyerUserId: string;
	currency: string;
	entitlementUntil: string | null;
	id: string;
	itemId: string;
	itemKind: MarketplaceKind;
	itemName: string | null;
	itemVersion: string;
	platformFeeMinor: number;
	priceMinor: number;
	purchasedAt: string;
	status: LicenseStatus;
	stripePaymentIntentId: string | null;
	stripeSubscriptionId: string | null;
}

/** Format a minor-unit (cents) amount as a localized currency string. */
export function formatPrice(amountMinor: number, currency = "usd"): string {
	return formatMinorCurrency(amountMinor, currency);
}

/** Add the billing or included-update term to a marketplace price. */
export function formatPricingLabel(pricing: PricingView): string {
	const suffix =
		pricing.model === "subscription"
			? `/${pricing.interval === "year" ? "yr" : "mo"}`
			: pricing.model === "bounded_updates"
				? ` · ${pricing.maxUpdates ?? "limited"} updates`
				: "";
	return `${formatPrice(pricing.amountMinor, pricing.currency)}${suffix}`;
}

export interface MarketplaceMembershipUsageResult {
	created: boolean;
	ok: boolean;
	periodId: string;
}

export interface MarketplaceMembershipRevenueCurrency {
	currency: string;
	failedMinor: number;
	paidMinor: number;
	pendingMinor: number;
	usageCount: number;
}

export interface MarketplaceMembershipPublisherReport {
	currencies: MarketplaceMembershipRevenueCurrency[];
	eligibleListingCount: number;
	organizationId: string;
}

/** Record one first-use signal for a listing eligible for the legacy publisher pool. */
export async function recordMarketplaceMembershipUsage(input: {
	id: string;
	idempotencyKey: string;
	kind: MarketplaceKind;
}): Promise<MarketplaceMembershipUsageResult> {
	const resp = await fetch(`${BASE}/membership/usage`, {
		body: JSON.stringify(input),
		headers: authHeaders(),
		method: "POST",
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as Partial<MarketplaceMembershipUsageResult>;
	return {
		created: Boolean(json.created),
		ok: Boolean(json.ok),
		periodId: typeof json.periodId === "string" ? json.periodId : "",
	};
}

/** Fetch the active publisher organization's A Major Pass distribution totals. */
export async function fetchMarketplaceMembershipPublisherReport(): Promise<MarketplaceMembershipPublisherReport> {
	const resp = await fetch(`${BASE}/membership/publisher-report`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json =
		(await resp.json()) as Partial<MarketplaceMembershipPublisherReport>;
	return {
		currencies: Array.isArray(json.currencies)
			? json.currencies.map((currency) => ({
					currency:
						typeof currency.currency === "string" ? currency.currency : "usd",
					failedMinor:
						typeof currency.failedMinor === "number" ? currency.failedMinor : 0,
					paidMinor:
						typeof currency.paidMinor === "number" ? currency.paidMinor : 0,
					pendingMinor:
						typeof currency.pendingMinor === "number"
							? currency.pendingMinor
							: 0,
					usageCount:
						typeof currency.usageCount === "number" ? currency.usageCount : 0,
				}))
			: [],
		eligibleListingCount:
			typeof json.eligibleListingCount === "number"
				? json.eligibleListingCount
				: 0,
		organizationId:
			typeof json.organizationId === "string" ? json.organizationId : "",
	};
}

/** True when the user has a session token; the money layer requires sign-in. */
export function hasMarketplaceAuth(): boolean {
	try {
		return Boolean(localStorage.getItem(TOKEN_KEY));
	} catch {
		return false;
	}
}

export interface PortablePackageState {
	enabled: boolean;
	id: string;
	installed_at_unix_ms: number;
	kind: string;
	package_digest: string;
	version: string;
}

/** A package-declared connection requirement. This is metadata only: no token,
 * account id, or publisher-side connection state crosses the install boundary. */
export interface PackageConnectionRequirement {
	consumers: string[];
	displayName: string;
	id: string;
	provider: string;
	purpose: string | null;
	required: boolean;
	toolkit: string | null;
}

export type ShareCodeAudience = "organization" | "shareable";

/** Safe preview returned after resolving a private package code. */
export interface PrivatePackageSharePreview {
	audience: ShareCodeAudience;
	capabilities: string[];
	connections: PackageConnectionRequirement[];
	description: string | null;
	developer: string | null;
	expiresAt: string | null;
	id: string;
	kind: MarketplaceKind;
	name: string;
	organizationName: string | null;
	packageSizeBytes: number | null;
	verification: VerificationStatus;
	version: string;
}

export interface PrivatePackageShareRedeemResult {
	installSession: string;
	preview: PrivatePackageSharePreview;
}

export interface PrivatePackageShareCode {
	code: string;
	createdAt: string | null;
	customerOrganizationId: string | null;
	expiresAt: string | null;
	id: string;
	itemId: string;
	itemKind: MarketplaceKind;
	itemVersion: string;
	label: string | null;
	maxRedemptions: number;
	redemptionCount: number;
	revokedAt: string | null;
}

export interface CreatePrivatePackageShareCodeInput {
	customerOrganizationId?: string | null;
	expiresAt?: string;
	id: string;
	kind: MarketplaceKind;
	label?: string;
	maxRedemptions?: number;
	version?: string;
}

const CROCKFORD_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** Normalize the human-entered code without making the client the authority. */
export function normalizePrivatePackageShareCode(value: string): string {
	return value.toUpperCase().replace(/[\s-]/g, "");
}

/** Format the 12-character code for the grouped input/confirmation UI. */
export function formatPrivatePackageShareCode(value: string): string {
	const normalized = normalizePrivatePackageShareCode(value);
	return normalized.match(/.{1,4}/g)?.join("-") ?? normalized;
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(entry): entry is string =>
					typeof entry === "string" && entry.trim().length > 0
			)
		: [];
}

function resolveConnectionRequirements(
	value: unknown
): PackageConnectionRequirement[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: PackageConnectionRequirement[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		const raw = recordValue(entry);
		if (!raw) {
			continue;
		}
		const provider = stringValue(raw.provider) ?? "";
		const toolkit = stringValue(
			raw.toolkit ?? raw.toolkit_slug ?? raw.toolkitSlug
		);
		const id = stringValue(raw.id) ?? toolkit ?? provider;
		if (!id) {
			continue;
		}
		const key = `${provider}:${toolkit ?? ""}:${id}`.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push({
			consumers: stringList(raw.consumers ?? raw.used_by ?? raw.usedBy),
			displayName:
				stringValue(raw.display_name ?? raw.displayName ?? raw.name) ??
				toolkit ??
				provider ??
				id,
			id,
			provider: provider || "unknown",
			purpose: stringValue(raw.purpose),
			required: raw.required !== false,
			toolkit,
		});
	}
	return out;
}

function resolvePrivateSharePreview(
	value: unknown
): PrivatePackageSharePreview {
	const envelope = recordValue(value);
	const raw =
		recordValue(envelope?.preview ?? envelope?.listing ?? value) ?? {};
	const kind = stringValue(raw.kind) as MarketplaceKind | null;
	const verification = stringValue(raw.verification ?? envelope?.verification);
	return {
		audience:
			(raw.audience ?? envelope?.audience) === "shareable"
				? "shareable"
				: "organization",
		capabilities: stringList(raw.capabilities),
		connections: resolveConnectionRequirements(
			raw.connections ?? recordValue(raw.setup)?.connections
		),
		description: stringValue(raw.description),
		developer: stringValue(raw.developer ?? raw.author),
		expiresAt: stringValue(
			raw.expires_at ??
				raw.expiresAt ??
				envelope?.expires_at ??
				envelope?.expiresAt
		),
		id: stringValue(raw.id) ?? "",
		kind: kind ?? "bundle",
		name: stringValue(raw.name) ?? "Private package",
		organizationName: stringValue(
			raw.organization_name ?? raw.organizationName
		),
		packageSizeBytes:
			typeof raw.package_size_bytes === "number"
				? raw.package_size_bytes
				: typeof raw.packageSizeBytes === "number"
					? raw.packageSizeBytes
					: null,
		version: stringValue(raw.version) ?? "",
		verification:
			verification === "verified" ||
			verification === "unsigned" ||
			verification === "invalid"
				? verification
				: "unknown",
	};
}

async function postPrivateShareCode<T>(path: string, code: string): Promise<T> {
	const normalized = normalizePrivatePackageShareCode(code);
	if (!CROCKFORD_CODE_RE.test(normalized)) {
		throw new MarketplaceError(
			"unknown",
			"Enter the 12-character package code shown by the publisher."
		);
	}
	const resp = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ code: normalized }),
	});
	if (!resp.ok) {
		const error = await toError(resp);
		if (resp.status === 400 || resp.status === 404) {
			throw new MarketplaceError(
				"unknown",
				"That code is no longer available or has expired.",
				{ code: error.code, details: error.details }
			);
		}
		if (resp.status === 429) {
			throw new MarketplaceError(
				"unknown",
				"Too many attempts. Wait a moment, then try the code again.",
				{ code: error.code, details: error.details }
			);
		}
		throw error;
	}
	return (await resp.json()) as T;
}

export async function previewPrivatePackageShareCode(
	code: string
): Promise<PrivatePackageSharePreview> {
	const json = await postPrivateShareCode<Record<string, unknown>>(
		"/share-codes/preview",
		code
	);
	return resolvePrivateSharePreview(json);
}

export async function redeemPrivatePackageShareCode(
	code: string
): Promise<PrivatePackageShareRedeemResult> {
	const json = await postPrivateShareCode<Record<string, unknown>>(
		"/share-codes/redeem",
		code
	);
	const session =
		stringValue(json.install_session) ??
		stringValue(json.installSession) ??
		stringValue(json.install_session_token) ??
		stringValue(json.installSessionToken) ??
		"";
	if (!session) {
		throw new MarketplaceError(
			"unknown",
			"The package code could not start an install session."
		);
	}
	return {
		installSession: session,
		preview: resolvePrivateSharePreview(json),
	};
}

function resolvePrivateShareCode(value: unknown): PrivatePackageShareCode {
	const raw = recordValue(value) ?? {};
	const kind = stringValue(
		raw.item_kind ?? raw.itemKind
	) as MarketplaceKind | null;
	return {
		code: stringValue(raw.code) ?? "",
		createdAt: stringValue(raw.created_at ?? raw.createdAt),
		customerOrganizationId: stringValue(
			raw.customer_organization_id ?? raw.customerOrganizationId
		),
		expiresAt: stringValue(raw.expires_at ?? raw.expiresAt),
		id: stringValue(raw.id) ?? "",
		itemId: stringValue(raw.item_id ?? raw.itemId) ?? "",
		itemKind: kind ?? "bundle",
		itemVersion: stringValue(raw.item_version ?? raw.itemVersion) ?? "",
		label: stringValue(raw.label),
		maxRedemptions:
			typeof raw.max_redemptions === "number"
				? raw.max_redemptions
				: typeof raw.maxRedemptions === "number"
					? raw.maxRedemptions
					: 1,
		redemptionCount:
			typeof raw.redemption_count === "number"
				? raw.redemption_count
				: typeof raw.redemptionCount === "number"
					? raw.redemptionCount
					: 0,
		revokedAt: stringValue(raw.revoked_at ?? raw.revokedAt),
	};
}

export async function createPrivatePackageShareCode(
	input: CreatePrivatePackageShareCodeInput
): Promise<PrivatePackageShareCode> {
	const resp = await fetch(`${BASE}/share-codes`, {
		body: JSON.stringify(input),
		headers: authHeaders(),
		method: "POST",
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = recordValue(await resp.json()) ?? {};
	const code = stringValue(json.code);
	if (!code) {
		throw new MarketplaceError(
			"unknown",
			"The publisher code was not created."
		);
	}
	return {
		...resolvePrivateShareCode(json.shareCode),
		code: formatPrivatePackageShareCode(code),
	};
}

export async function listPrivatePackageShareCodes(
	input: { id?: string; kind?: MarketplaceKind } = {}
): Promise<PrivatePackageShareCode[]> {
	const query = new URLSearchParams();
	if (input.id) {
		query.set("id", input.id);
	}
	if (input.kind) {
		query.set("kind", input.kind);
	}
	const suffix = query.toString() ? `?${query.toString()}` : "";
	const resp = await fetch(`${BASE}/share-codes${suffix}`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = recordValue(await resp.json()) ?? {};
	return Array.isArray(json.codes)
		? json.codes.map(resolvePrivateShareCode)
		: [];
}

export async function revokePrivatePackageShareCode(id: string): Promise<void> {
	const resp = await fetch(
		`${BASE}/share-codes/${encodeURIComponent(id)}/revoke`,
		{ headers: authHeaders(), method: "POST" }
	);
	if (!resp.ok) {
		throw await toError(resp);
	}
}

export async function fetchInstalledPortablePackages(
	target: ApiTarget
): Promise<PortablePackageState[]> {
	const result = await request<{ packages?: PortablePackageState[] }>(
		target,
		"/api/marketplace/packages/installed"
	);
	return result.packages ?? [];
}

/** Record one Core-verified Marketplace install action for anonymous community
 * usage. Core owns the increment; this client never sends a caller-supplied
 * counter and failures are intentionally ignored by bundle orchestration. */
export async function recordMarketplaceUsage(
	target: ApiTarget,
	input: { event: "download"; id: string; kind: MarketplaceKind }
): Promise<void> {
	await request(target, "/api/marketplace/usage", {
		method: "POST",
		body: input,
	});
}

/**
 * Install or update a GitHub-backed `.ryupack` through the selected node.
 *
 * The control-plane session is carried separately from the node token: Core
 * uses it only when it asks Ryu to resolve optional account-aware commerce and
 * proxy the private GitHub Release. Buyers never need GitHub credentials or a
 * GitHub App installation of their own.
 */
export async function installPortablePackage(
	target: ApiTarget,
	input: { kind: string; id: string },
	options: {
		installSession?: string;
		update?: boolean;
		version?: string;
	} = {}
): Promise<PortablePackageState> {
	const path = options.update
		? "/api/marketplace/packages/update"
		: "/api/marketplace/packages/install";
	const result = await request<{ package: PortablePackageState }>(
		target,
		path,
		{
			method: "POST",
			headers: buyerTokenHeader(target),
			body: {
				...input,
				...(options.version ? { version: options.version } : {}),
				...(options.installSession
					? { install_session: options.installSession }
					: {}),
			},
		}
	);
	return result.package;
}

export async function setPortablePackageEnabled(
	target: ApiTarget,
	input: { kind: string; id: string },
	enabled: boolean
): Promise<PortablePackageState> {
	const result = await request<{ package: PortablePackageState }>(
		target,
		`/api/marketplace/packages/${encodeURIComponent(input.kind)}/${encodeURIComponent(input.id)}/${enabled ? "enable" : "disable"}`,
		{ method: "POST" }
	);
	return result.package;
}

export async function uninstallPortablePackage(
	target: ApiTarget,
	input: { kind: string; id: string }
): Promise<void> {
	await request(
		target,
		"/api/marketplace/packages/" +
			encodeURIComponent(input.kind) +
			"/" +
			encodeURIComponent(input.id) +
			"/uninstall",
		{
			method: "POST",
		}
	);
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	try {
		const token = localStorage.getItem(TOKEN_KEY);
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
	} catch {
		// No storage — request will 401 and the UI prompts to sign in.
	}
	return headers;
}

const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/marketplace`;
const MARKETPLACE_SEARCH_KINDS: MarketplaceKind[] =
	MARKETPLACE_BROWSE_KINDS.map((kind) => kind.value);

/**
 * Distinguishes the degrade-cleanly states from generic failures so the UI can
 * render a tailored message:
 *   - "auth":   401, not signed in.
 *   - "no_org": 409, the active org is missing (purchases are org-level).
 *   - "stripe": 503, Stripe is not configured (purchase unavailable).
 *   - "seller": 403, the item's seller cannot currently receive payouts.
 *   - "free":   400, this item is free — no purchase path.
 *   - "purchase": 403 on review submit, this paid item is verified-purchasers-only.
 */
export type MarketplaceErrorKind =
	| "auth"
	| "github"
	| "no_org"
	| "stripe"
	| "seller"
	| "free"
	| "purchase"
	| "unknown";

export class MarketplaceError extends Error {
	readonly code: string | null;
	readonly details: Record<string, unknown>;
	readonly kind: MarketplaceErrorKind;
	constructor(
		kind: MarketplaceErrorKind,
		message: string,
		options: { code?: string | null; details?: Record<string, unknown> } = {}
	) {
		super(message);
		this.name = "MarketplaceError";
		this.kind = kind;
		this.code = options.code ?? null;
		this.details = options.details ?? {};
	}
}

async function toError(resp: Response): Promise<MarketplaceError> {
	let message: string | undefined;
	let code: string | null = null;
	let details: Record<string, unknown> = {};
	try {
		const body = (await resp.json()) as {
			code?: unknown;
			error?: string;
			message?: string;
			[key: string]: unknown;
		};
		message = body.message ?? body.error;
		code = typeof body.code === "string" ? body.code : null;
		details = body;
	} catch {
		// Non-JSON body.
	}
	const isGithubError = code?.startsWith("github_") === true;
	if (isGithubError) {
		return new MarketplaceError(
			"github",
			message ?? "GitHub repository access needs attention.",
			{ code, details }
		);
	}
	if (resp.status === 401) {
		return new MarketplaceError("auth", message ?? "Sign in to continue.", {
			code,
			details,
		});
	}
	if (resp.status === 409) {
		return new MarketplaceError(
			"no_org",
			message ??
				"Purchases are org-level. Create or select an organization first.",
			{ code, details }
		);
	}
	if (resp.status === 503) {
		return new MarketplaceError(
			"stripe",
			message ?? "Purchase is unavailable: Stripe is not configured.",
			{ code, details }
		);
	}
	if (resp.status === 403) {
		return new MarketplaceError(
			"seller",
			message ?? "This item's seller cannot currently receive payouts.",
			{ code, details }
		);
	}
	if (resp.status === 400 && /free/i.test(message ?? "")) {
		return new MarketplaceError("free", message ?? "This item is free.", {
			code,
			details,
		});
	}
	return new MarketplaceError(
		"unknown",
		message ?? `Request failed: ${resp.status}`,
		{ code, details }
	);
}

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
	const q = new URLSearchParams({ kind });
	if (query.trim()) {
		q.set("query", query.trim());
	}
	const resp = await fetch(`${BASE}/catalog?${q.toString()}`, {
		headers: authHeaders(),
		signal,
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as { items?: MarketplaceCardWire[] };
	return (json.items ?? []).map(toMarketplaceCard);
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
	if (typeof limit === "number" && limit > 0) {
		q.set("limit", String(limit));
	}
	const suffix = q.toString();
	const resp = await fetch(`${BASE}/featured${suffix ? `?${suffix}` : ""}`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as { items?: MarketplaceCardWire[] };
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
	const resp = await fetch(`${BASE}/purchase`, {
		method: "POST",
		headers: {
			...authHeaders(),
			"Idempotency-Key": crypto.randomUUID(),
		},
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as {
		url?: string;
		sessionId?: string;
		alreadyLicensed?: boolean;
		license?: OwnedLicense | null;
	};
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
	const json = (await resp.json()) as { licenses?: OwnedLicense[] };
	return json.licenses ?? [];
}

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

/** Readable labels for the permission grants the store surfaces most often. Keys
 *  are matched case-insensitively; anything unmapped is humanized generically. */
const GRANT_CAPABILITY_LABELS: Record<string, string> = {
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
};

/** Turn a raw permission-grant id into a human label: a curated match first, then
 *  a generic humanization (drop the `scope:`/`scope.` prefix, split on separators,
 *  title-case the words). */
function grantToCapability(grant: string): string {
	const key = grant.trim().toLowerCase();
	const mapped = GRANT_CAPABILITY_LABELS[key];
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
function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(v): v is string => typeof v === "string" && v.length > 0
	);
}

function resolveBundleMembers(value: unknown): MarketplaceBundleMember[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const kinds = new Set<MarketplaceBundleMember["kind"]>([
		"app",
		"plugin",
		"skill",
		"model",
		"mcp",
		"agent",
		"stack_template",
		"workflow",
		"theme",
		"language_pack",
		"space",
		"profile",
		"output_style",
	]);
	const members: MarketplaceBundleMember[] = [];
	const seen = new Set<string>();
	for (const entry of value.slice(0, 64)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			continue;
		}
		const raw = entry as Record<string, unknown>;
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
		if (
			!(id && kinds.has(kind as MarketplaceBundleMember["kind"])) ||
			seen.has(`${kind}:${id}`)
		) {
			continue;
		}
		seen.add(`${kind}:${id}`);
		members.push({
			id,
			kind: kind as MarketplaceBundleMember["kind"],
			name: typeof raw.name === "string" ? raw.name : null,
			required: raw.required !== false,
			source: typeof raw.source === "string" ? raw.source : null,
		});
	}
	return members;
}

/** Defense-in-depth href allowlist: return the value only if it is a string with
 *  an http(s) scheme. Catalog sources are untrusted (a git `MarketplaceSource`
 *  can return an arbitrary `homepage`/`website`), so any URL rendered as an
 *  `<a href>` is scheme-checked here to block `javascript:`/`data:` XSS even if a
 *  backend sanitizer is ever bypassed. */
function safeHttpUrl(value: unknown): string | null {
	return typeof value === "string" && /^https?:\/\//i.test(value.trim())
		? value.trim()
		: null;
}

/** Resolve the developer/publisher name from either a plain string or a Claude
 *  `author` object (`{ name }`). */
function resolveDeveloper(raw: {
	developer?: unknown;
	author?: unknown;
}): string | null {
	if (typeof raw.developer === "string" && raw.developer) {
		return raw.developer;
	}
	if (typeof raw.author === "string" && raw.author) {
		return raw.author;
	}
	if (
		raw.author &&
		typeof raw.author === "object" &&
		typeof (raw.author as { name?: unknown }).name === "string"
	) {
		return (raw.author as { name: string }).name;
	}
	return null;
}

/** Normalize the `setup` field, which may be a single card OR an array of steps. */
function resolveSetup(value: unknown): DetailSetupStep[] {
	const rawSteps = Array.isArray(value) ? value : value ? [value] : [];
	const steps: DetailSetupStep[] = [];
	for (const step of rawSteps) {
		if (!step || typeof step !== "object") {
			continue;
		}
		const s = step as Record<string, unknown>;
		const title = typeof s.title === "string" ? s.title : null;
		const description =
			typeof s.description === "string" ? s.description : null;
		const actionLabel =
			typeof s.actionLabel === "string" ? s.actionLabel : null;
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
function resolveCatalogBanner(value: unknown): CatalogBanner | null {
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
	if (typeof raw.seed === "number" && Number.isFinite(raw.seed)) {
		banner.seed = Math.trunc(raw.seed);
	}
	return Object.keys(banner).length > 0 ? banner : null;
}

/** Normalize the `runnables` field into typed entries with enable state. */
function resolveRunnables(value: unknown): DetailRunnable[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: DetailRunnable[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const r = entry as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id : null;
		const name = typeof r.name === "string" ? r.name : null;
		// The server keeps a runnable descriptor with id OR name (id may be null),
		// so mirror that here: require at least one, and fall back across them for
		// the key/label so a name-only runnable still renders (and the Skills count
		// stays accurate) instead of being silently dropped.
		if (!(id || name)) {
			continue;
		}
		out.push({
			id: id ?? (name as string),
			name: name ?? (id as string),
			kind: typeof r.kind === "string" ? r.kind : "runnable",
			description: typeof r.description === "string" ? r.description : null,
			enabled: r.enabled === true,
		});
	}
	return out;
}

/** Resolve capabilities: an explicit list wins; otherwise derive from permission
 *  grants (either `capabilities`/`permission_grants`/`permissionGrants`). */
function resolveCapabilities(raw: {
	capabilities?: unknown;
	permission_grants?: unknown;
	permissionGrants?: unknown;
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
	const json = (await resp.json()) as Partial<MarketplaceDetail> & {
		author?: unknown;
		banner?: unknown;
		homepage?: unknown;
		permission_grants?: unknown;
		permissionGrants?: unknown;
		runnables?: unknown;
		screenshots?: unknown;
		setup?: unknown;
	};
	return {
		banner: resolveCatalogBanner(json.banner),
		bundleMembers: resolveBundleMembers(json.bundleMembers),
		bundleSourceUrl: safeHttpUrl(json.bundleSourceUrl),
		communityStats: {
			downloads:
				typeof json.communityStats?.downloads === "number"
					? json.communityStats.downloads
					: 0,
			instances:
				typeof json.communityStats?.instances === "number"
					? json.communityStats.instances
					: 0,
			runs:
				typeof json.communityStats?.runs === "number"
					? json.communityStats.runs
					: 0,
		},
		id: json.id ?? id,
		kind: (json.kind as MarketplaceKind) ?? kind,
		languagePack: json.languagePack ?? null,
		name: json.name ?? "",
		firstParty: Boolean(json.firstParty),
		version: json.version ?? "",
		orgVerified: Boolean(json.orgVerified),
		orgVerifiedTier: json.orgVerifiedTier ?? null,
		publisherTrust:
			json.publisherTrust ??
			resolvePublisherTrust({
				firstParty: json.firstParty,
				ryuStaffVerified: json.orgVerified,
			}).level,
		publisherTrustSource:
			json.publisherTrustSource ??
			resolvePublisherTrust({
				firstParty: json.firstParty,
				ryuStaffVerified: json.orgVerified,
			}).source,
		publisherVerification: json.publisherVerification ?? null,
		pricing: json.pricing ?? null,
		iconUrl: json.iconUrl ?? null,
		bannerUrl: json.bannerUrl ?? null,
		category: json.category ?? null,
		ratingAverage: json.ratingAverage ?? 0,
		ratingCount: json.ratingCount ?? 0,
		screenshots: toStringArray(json.screenshots),
		tagline: typeof json.tagline === "string" ? json.tagline : null,
		description: typeof json.description === "string" ? json.description : null,
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
	const json = (await resp.json()) as Partial<ReviewsPage> & {
		reviews?: Review[];
	};
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
				const b = (await resp.json()) as {
					error?: string;
					message?: string;
					requiresPurchase?: boolean;
				};
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
	const json = (await resp.json()) as Partial<PostReviewResult>;
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

// ── Publish (Phase 5a: publish your own Runnable to the marketplace) ─────────

/**
 * The publish body accepted by POST /api/marketplace/publish. Built by the
 * packaging helpers (lib/publish/packaging.ts) from a Runnable's shareable
 * config; this client just forwards it. Left as an open record so the caller's
 * typed `PublishBody` (packaging) drives the shape without a second source of
 * truth to keep in sync.
 */
export type PublishRequest = Record<string, unknown> & {
	id: string;
	kind: MarketplaceKind;
	name: string;
};

/** The server's publish response: the stored id + moderation status. */
export interface PublishResult {
	approved: string[];
	id: string;
	kind: MarketplaceKind;
	/** Always "pending" on a fresh publish — a moderator flips it live. */
	status: string;
}

/**
 * Publish a Runnable (packaged as a plugin bundle) to the Ryu Marketplace. AUTH
 * required (the server runs requireAuth); the item is stored as `pending` until
 * a moderator approves it. On the identity/control-plane server (:3000), like
 * the rest of this money-layer client.
 */
export async function publishRunnable(
	body: PublishRequest
): Promise<PublishResult> {
	const resp = await fetch(`${BASE}/publish`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as Partial<PublishResult>;
	return {
		id: json.id ?? body.id,
		kind: (json.kind as MarketplaceKind) ?? body.kind,
		status: json.status ?? "pending",
		approved: json.approved ?? [],
	};
}

export interface GithubPublishResult {
	githubSource: Record<string, unknown> | null;
	id: string;
	kind: MarketplaceKind;
	status: string;
	version: string;
}

/** Seller-controlled offer terms; seller identity and platform fees stay server-side. */
export interface GithubPublishPricing {
	amountMinor: number;
	currency: string;
	distribution: "github_release";
	interval?: "month" | "year";
	maxUpdates?: number;
	model: "one_time" | "subscription" | "bounded_updates";
}

export interface GithubInstallationResult {
	installationProof: string;
	ready: true;
	repository: string;
}

/**
 * Publish a GitHub-backed package. The repository/release is the source of
 * truth; Ryu stores only the validated binding and listing metadata. Private
 * repositories use the short-lived proof returned by the installation status
 * route, never a GitHub token in the desktop.
 */
export async function publishGithubPackage(input: {
	installationProof?: string;
	pricing?: GithubPublishPricing;
	url: string;
}): Promise<GithubPublishResult> {
	const resp = await fetch(`${BASE}/github/publish`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			url: input.url,
			...(input.pricing ? { pricing: input.pricing } : {}),
			...(input.installationProof
				? { installationProof: input.installationProof }
				: {}),
		}),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as Partial<GithubPublishResult>;
	return {
		githubSource: json.githubSource ?? null,
		id: json.id ?? "",
		kind: (json.kind as MarketplaceKind) ?? "plugin",
		status: json.status ?? "pending",
		version: json.version ?? "",
	};
}

/**
 * Resolve a completed GitHub App installation for the signed-in seller. The
 * server checks the repository-bound state and returns a proof, so the UI never
 * handles or persists an installation id as authority.
 */
export async function completeGithubInstallation(input: {
	repository: string;
	state: string;
}): Promise<GithubInstallationResult> {
	const query = new URLSearchParams({
		repository: input.repository,
		state: input.state,
	});
	const resp = await fetch(`${BASE}/github/install/status?${query}`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as Partial<GithubInstallationResult>;
	if (!(json.installationProof && json.repository && json.ready === true)) {
		throw new MarketplaceError(
			"github",
			"GitHub App installation did not return a usable seller proof.",
			{ code: "github_installation_invalid", details: json }
		);
	}
	return {
		installationProof: json.installationProof,
		repository: json.repository,
		ready: true,
	};
}

// ── Listing media upload (seller/owner) ──────────────────────────────────────

/**
 * Upload an icon or screenshot for a listing you own and get back its URL. AUTH
 * required and ownership-gated server-side. Sends multipart/form-data, so it does
 * NOT reuse {@link authHeaders} (which forces a JSON content type that would drop
 * the multipart boundary) — only the bearer is attached and the browser sets the
 * content type + boundary from the FormData body.
 */
export async function uploadListingMedia(input: {
	kind: MarketplaceKind;
	id: string;
	role: "icon" | "screenshot";
	file: File | Blob;
}): Promise<{ url: string }> {
	const form = new FormData();
	form.set("kind", input.kind);
	form.set("id", input.id);
	form.set("role", input.role);
	form.set("file", input.file);

	const headers: Record<string, string> = {};
	try {
		const token = localStorage.getItem(TOKEN_KEY);
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}
	} catch {
		// No storage — request will 401 and the UI prompts to sign in.
	}

	const resp = await fetch(`${BASE}/media`, {
		method: "POST",
		headers,
		body: form,
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as { url?: string };
	return { url: json.url ?? "" };
}

// ── abuse / quality reports ───────────────────────────────────────────────────

export type ReportReason =
	| "malicious"
	| "spam"
	| "inappropriate"
	| "ip"
	| "broken"
	| "other";

export type ReportSource =
	| "mongo"
	| "github-curated"
	| "github-community"
	| "installed"
	| "unknown";

export interface SubmitReportInput {
	details?: string | null;
	homepage?: string | null;
	id: string;
	installSource?: string | null;
	itemName?: string | null;
	kind: string;
	reason: ReportReason;
	source?: ReportSource;
}

export interface SubmitReportResult {
	suggestIssuesUrl?: string | null;
}

/** POST /api/marketplace/report — file a report against a listing or installed item. */
export async function submitReport(
	input: SubmitReportInput
): Promise<SubmitReportResult> {
	const resp = await fetch(`${BASE}/report`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			kind: input.kind,
			id: input.id,
			reason: input.reason,
			details: input.details ?? null,
			source: input.source ?? "unknown",
			installSource: input.installSource ?? null,
			homepage: input.homepage ?? null,
			itemName: input.itemName ?? null,
		}),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as {
		suggestIssuesUrl?: string | null;
	};
	return { suggestIssuesUrl: json.suggestIssuesUrl ?? null };
}

export type ReportStatus = "open" | "reviewing" | "resolved" | "dismissed";

export interface MarketplaceReportView {
	audience: "platform" | "seller" | "both";
	createdAt: string | null;
	details: string | null;
	homepage: string | null;
	id: string;
	installSource: string | null;
	issuesUrl: string | null;
	itemId: string;
	itemKind: string;
	itemName: string | null;
	reason: ReportReason;
	reporterEmail: string | null;
	reporterName: string | null;
	reporterUserId: string;
	resolutionNote: string | null;
	resolvedAt: string | null;
	sellerOrgId: string | null;
	source: ReportSource;
	status: ReportStatus;
}

/** GET /api/marketplace/reports/seller — org admin inbox for seller-visible reports. */
export async function fetchSellerReports(input?: {
	status?: ReportStatus;
}): Promise<MarketplaceReportView[]> {
	const params = new URLSearchParams();
	if (input?.status) {
		params.set("status", input.status);
	}
	const qs = params.toString();
	const resp = await fetch(`${BASE}/reports/seller${qs ? `?${qs}` : ""}`, {
		headers: authHeaders(),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as { reports?: MarketplaceReportView[] };
	return json.reports ?? [];
}

/** POST /api/marketplace/reports/resolve — seller or platform admin status update. */
export async function resolveReport(input: {
	id: string;
	note?: string | null;
	status: ReportStatus;
}): Promise<MarketplaceReportView> {
	const resp = await fetch(`${BASE}/reports/resolve`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = (await resp.json()) as { report?: MarketplaceReportView };
	if (!json.report) {
		throw new MarketplaceError("unknown", "Resolve returned no report.");
	}
	return json.report;
}

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

function toSnapshot(raw: unknown, fallbackNamespace: string): LikeSnapshot {
	const row = (raw ?? {}) as Partial<LikeSnapshot>;
	return {
		namespace:
			typeof row.namespace === "string" ? row.namespace : fallbackNamespace,
		count: typeof row.count === "number" ? Math.max(0, row.count) : 0,
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
	const json = (await resp.json()) as { likes?: unknown[] };
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
