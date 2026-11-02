import path from "node:path";
import type { GatewayBudgetConfig } from "../src/lib/api/gateway.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for gateway-budgets-settings-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

declare const window: Window;

export interface GatewayBudgetsSnapshot {
	budgets: GatewayBudgetConfig;
	requests: { body: unknown; method: string; path: string; status: number }[];
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
	await page.waitForFunction(() => {
		// Navigation can finish before Vite evaluates the harness module. Wait for
		// its actual snapshot interface before reading the persisted fixture state.
		const proof = (
			window as Window & {
				__gatewayBudgetsProof?: {
					snapshot?: () => GatewayBudgetsSnapshot;
				};
			}
		).__gatewayBudgetsProof;
		return typeof proof?.snapshot === "function";
	});
	return page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-budgets-settings-proof.tsx installs __gatewayBudgetsProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewayBudgetsProof: {
						snapshot: () => GatewayBudgetsSnapshot;
					};
				}
			).__gatewayBudgetsProof;
		return proof.snapshot();
	});
}

export function configWrites(snapshot: GatewayBudgetsSnapshot) {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/gateway/config") && request.method === "PUT"
	);
}
