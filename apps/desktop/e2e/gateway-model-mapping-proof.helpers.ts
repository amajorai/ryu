import path from "node:path";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for gateway-model-mapping-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export interface GatewayModelMappingSnapshot {
	config: {
		routing: {
			default_provider: string;
			eval_routing?: {
				candidates: string[];
				enabled: boolean;
				explore_ratio: number;
			};
			fallback_chain: string[];
			modality_map?: Record<string, { model?: string; provider: string }>;
			model_map: Record<string, { provider: string; provider_model?: string }>;
			provider_tiers?: Record<string, number>;
			smart_routing?: {
				cache_by_session: boolean;
				classifier_model: string;
				embedding_model: string;
				enabled: boolean;
				rules: { description: string; model: string }[];
				similarity_threshold: number;
				strategy: string;
				timeout_ms: number;
			};
		};
	};
	requests: { body: unknown; method: string; path: string }[];
}

export function screenshotPath(name: string): string {
	// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
	// the tracked proof ledger; without it the committed evidence is refreshed.
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	if (override) {
		return path.join(override, `${name}.png`);
	}
	return proofEvidencePath(`test-coverage-sweep-20260924/evidence/${name}.png`);
}

export async function readProofState(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-model-mapping-proof.tsx installs __gatewayModelMappingProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewayModelMappingProof: {
						snapshot: () => GatewayModelMappingSnapshot;
					};
				}
			).__gatewayModelMappingProof;
		return proof.snapshot();
	});
}

export function configWrites(snapshot: GatewayModelMappingSnapshot) {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/gateway/config") && request.method === "PUT"
	);
}

export function gatewayConfigRequests(snapshot: GatewayModelMappingSnapshot) {
	return snapshot.requests.filter((request) =>
		request.path.endsWith("/api/gateway/config")
	);
}

export async function visibleFallbackProviderOrder(
	page: import("@playwright/test").Page
) {
	const fallbackGroup = page.locator('[data-slot="item-group"]').filter({
		has: page.getByRole("button", {
			name: /Remove .* from fallback chain/,
		}),
	});
	return (
		await fallbackGroup.locator('[data-slot="item-title"]').allTextContents()
	).map((provider) => provider.trim());
}
