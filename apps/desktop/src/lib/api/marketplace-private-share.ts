// apps/desktop/src/lib/api/marketplace-private-share.ts
//
// Private package share codes: preview, redeem, create, list, revoke.
// Split out of marketplace.ts (which re-exports it); see that file's header
// for the control-plane contract.

import { translate as tl } from "@ryu/i18n/core";
import type { MarketplaceKind } from "@ryu/marketplace/types";
import type { VerificationStatus } from "./marketplace-cards.ts";
import {
	authHeaders,
	BASE,
	MarketplaceError,
	toError,
} from "./marketplace-http.ts";
import { marketplaceKindSchema } from "./marketplace-response-contracts.ts";
import {
	marketplaceDocumentSchema,
	marketplaceNumberField,
	marketplaceRecord,
	marketplaceString,
	marketplaceStringList,
	type marketplaceValueSchema,
} from "./marketplace-wire-values.ts";

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
	/** When the install session stops authorizing installs, if the server said. */
	installSessionExpiresAt?: string | null;
	preview: PrivatePackageSharePreview;
}

/** A redeemed install session this process can still reuse for its code. */
export interface RedeemedPrivatePackageShareSession {
	expiresAtMs: number;
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

export const recordValue = marketplaceRecord;
export const stringValue = marketplaceString;
const stringList = marketplaceStringList;

function resolveConnectionRequirements(
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
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
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
): PrivatePackageSharePreview {
	const envelope = recordValue(value);
	const raw =
		recordValue(envelope?.preview ?? envelope?.listing ?? value) ?? {};
	const kind = marketplaceKindSchema.nullable().parse(stringValue(raw.kind));
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
		name: stringValue(raw.name) ?? tl("Private package"),
		organizationName: stringValue(
			raw.organization_name ?? raw.organizationName
		),
		packageSizeBytes:
			marketplaceNumberField(raw.package_size_bytes) ??
			marketplaceNumberField(raw.packageSizeBytes) ??
			null,
		version: stringValue(raw.version) ?? "",
		verification:
			verification === "verified" ||
			verification === "unsigned" ||
			verification === "invalid"
				? verification
				: "unknown",
	};
}

async function postPrivateShareCode(path: string, code: string) {
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
	return marketplaceDocumentSchema.parse(await resp.json());
}

export async function previewPrivatePackageShareCode(
	code: string
): Promise<PrivatePackageSharePreview> {
	const json = await postPrivateShareCode("/share-codes/preview", code);
	return resolvePrivateSharePreview(json);
}

/** Do not hand out a cached session this close to its expiry. */
const SHARE_SESSION_REUSE_MARGIN_MS = 30_000;
/**
 * The Marketplace's install-session lifetime. The server's expiry is read on
 * this machine's clock, so a clock running behind would otherwise keep reusing
 * a session the Marketplace already expired; reuse never outlives this.
 */
const SHARE_SESSION_MAX_REUSE_MS = 15 * 60_000;

/**
 * Install sessions redeemed in this process, keyed by signed-in account and
 * normalized code. Every redeem spends one of the code's redemptions, while the
 * session it returns stays valid until it expires, so a failed install or a
 * reopened dialog reuses it instead of burning another redemption (a single-use
 * code would otherwise be gone). Memory only; never written to storage.
 */
const redeemedShareSessions = new Map<
	string,
	RedeemedPrivatePackageShareSession
>();

function redeemedShareSessionKey(code: string): string {
	return JSON.stringify([
		authHeaders().get("Authorization") ?? "",
		normalizePrivatePackageShareCode(code),
	]);
}

/** The still-live session this account already redeemed for `code`, if any. */
export function peekRedeemedPrivatePackageShareSession(
	code: string
): RedeemedPrivatePackageShareSession | null {
	const key = redeemedShareSessionKey(code);
	const entry = redeemedShareSessions.get(key);
	if (!entry) {
		return null;
	}
	if (entry.expiresAtMs - SHARE_SESSION_REUSE_MARGIN_MS > Date.now()) {
		return entry;
	}
	redeemedShareSessions.delete(key);
	return null;
}

/** Drop the cached session for `code` (after it installed successfully). */
export function forgetRedeemedPrivatePackageShareSession(code: string): void {
	redeemedShareSessions.delete(redeemedShareSessionKey(code));
}

export async function redeemPrivatePackageShareCode(
	code: string
): Promise<PrivatePackageShareRedeemResult> {
	const cached = peekRedeemedPrivatePackageShareSession(code);
	if (cached) {
		return {
			installSession: cached.installSession,
			installSessionExpiresAt: new Date(cached.expiresAtMs).toISOString(),
			preview: cached.preview,
		};
	}
	const json = await postPrivateShareCode("/share-codes/redeem", code);
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
	const installSessionExpiresAt =
		stringValue(json.install_session_expires_at) ??
		stringValue(json.installSessionExpiresAt);
	const result: PrivatePackageShareRedeemResult = {
		installSession: session,
		installSessionExpiresAt,
		preview: resolvePrivateSharePreview(json),
	};
	const expiresAtMs = installSessionExpiresAt
		? Math.min(
				Date.parse(installSessionExpiresAt),
				Date.now() + SHARE_SESSION_MAX_REUSE_MS
			)
		: Number.NaN;
	if (Number.isFinite(expiresAtMs)) {
		redeemedShareSessions.set(redeemedShareSessionKey(code), {
			expiresAtMs,
			installSession: session,
			preview: result.preview,
		});
	}
	return result;
}

function resolvePrivateShareCode(
	value: Parameters<typeof marketplaceValueSchema.parse>[0]
): PrivatePackageShareCode {
	const raw = recordValue(value) ?? {};
	const kind = marketplaceKindSchema
		.nullable()
		.parse(stringValue(raw.item_kind ?? raw.itemKind));
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
			marketplaceNumberField(raw.max_redemptions) ??
			marketplaceNumberField(raw.maxRedemptions) ??
			1,
		redemptionCount:
			marketplaceNumberField(raw.redemption_count) ??
			marketplaceNumberField(raw.redemptionCount) ??
			0,
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
