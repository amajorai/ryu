// apps/desktop/src/lib/api/marketplace-http.ts
//
// Shared control-plane plumbing: auth headers, base URL and MarketplaceError.
// Split out of marketplace.ts (which re-exports it); see that file's header
// for the control-plane contract.

import { translate as tl } from "@ryu/i18n/core";
import { MARKETPLACE_BROWSE_KINDS } from "@ryu/marketplace/catalog/chrome/marketplace-sections";
import type { MarketplaceKind } from "@ryu/marketplace/types";
import { BACKEND_URL, getActiveToken } from "@/lib/auth-client.ts";
import { parseMarketplaceResponse } from "./marketplace-response-contracts.ts";
import {
	type MarketplaceDocument,
	marketplaceDocumentSchema,
	marketplaceStringField,
} from "./marketplace-wire-values.ts";

export function authHeaders() {
	const headers = new Headers({ "Content-Type": "application/json" });
	try {
		const token = getActiveToken();
		if (token) {
			headers.set("Authorization", `Bearer ${token}`);
		}
	} catch {
		// No storage — request will 401 and the UI prompts to sign in.
	}
	return headers;
}

export const BASE = `${BACKEND_URL.replace(/\/$/, "")}/api/marketplace`;
export const MARKETPLACE_SEARCH_KINDS: MarketplaceKind[] =
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
	readonly details: MarketplaceDocument;
	readonly kind: MarketplaceErrorKind;
	constructor(
		kind: MarketplaceErrorKind,
		message: string,
		options: { code?: string | null; details?: MarketplaceDocument } = {}
	) {
		super(message);
		this.name = "MarketplaceError";
		this.kind = kind;
		this.code = options.code ?? null;
		this.details = options.details ?? {};
	}
}

export async function toError(resp: Response): Promise<MarketplaceError> {
	let message: string | undefined;
	let code: string | null = null;
	let details: MarketplaceDocument = {};
	try {
		const body = parseMarketplaceResponse(
			marketplaceDocumentSchema,
			await resp.json()
		);
		message = marketplaceStringField(body.message ?? body.error);
		code = marketplaceStringField(body.code) ?? null;
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
			message ?? tl("Purchase is unavailable: Stripe is not configured."),
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
		message ?? tl("Request failed: {status}", { status: resp.status }),
		{ code, details }
	);
}
