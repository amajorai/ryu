// apps/desktop/src/lib/api/marketplace-publish.ts
//
// Publishing: Runnable publish, GitHub packages and listing media.
// Split out of marketplace.ts (which re-exports it); see that file's header
// for the control-plane contract.

import type { MarketplacePublishPreflightReport } from "@ryu/marketplace/catalog/publish-preflight";
import type { MarketplaceKind } from "@ryu/marketplace/types";
import { getActiveToken } from "@/lib/auth-client.ts";
import {
	authHeaders,
	BASE,
	MarketplaceError,
	toError,
} from "./marketplace-http.ts";
import {
	githubCompletionWireSchema,
	githubPublishWireSchema,
	parseMarketplaceResponse,
	publishResultSchema,
	urlResponseSchema,
} from "./marketplace-response-contracts.ts";
import type { MarketplaceDocument } from "./marketplace-wire-values.ts";

// ── Publish (Phase 5a: publish your own Runnable to the marketplace) ─────────

/**
 * The publish body accepted by POST /api/marketplace/publish. Built by the
 * packaging helpers (lib/publish/packaging.ts) from a Runnable's shareable
 * config; this client just forwards it. Left as an open record so the caller's
 * typed `PublishBody` (packaging) drives the shape without a second source of
 * truth to keep in sync.
 */
export type PublishRequest = MarketplaceDocument & {
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
	const json = parseMarketplaceResponse(
		publishResultSchema.partial(),
		await resp.json()
	);
	return {
		id: json.id ?? body.id,
		kind: json.kind ?? body.kind,
		status: json.status ?? "pending",
		approved: json.approved ?? [],
	};
}

export interface GithubPublishResult {
	githubSource: MarketplaceDocument | null;
	id: string;
	kind: MarketplaceKind;
	preflight: MarketplacePublishPreflightReport | null;
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
	const body: GithubPublishRequest = { url: input.url };
	if (input.pricing) {
		body.pricing = input.pricing;
	}
	if (input.installationProof) {
		body.installationProof = input.installationProof;
	}
	const resp = await fetch(`${BASE}/github/publish`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		throw await toError(resp);
	}
	const json = parseMarketplaceResponse(
		githubPublishWireSchema,
		await resp.json()
	);
	return {
		githubSource: json.githubSource ?? null,
		id: json.id ?? "",
		kind: json.kind ?? "plugin",
		preflight: json.preflight ?? null,
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
	const json = parseMarketplaceResponse(
		githubCompletionWireSchema,
		await resp.json()
	);
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

	const headers = new Headers();
	try {
		const token = getActiveToken();
		if (token) {
			headers.set("Authorization", `Bearer ${token}`);
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
	const json = parseMarketplaceResponse(urlResponseSchema, await resp.json());
	return { url: json.url ?? "" };
}

interface GithubPublishRequest {
	installationProof?: string;
	pricing?: GithubPublishPricing;
	url: string;
}
