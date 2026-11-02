import path from "node:path";
import { expect, type Page, type Request } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for app-update-transaction-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
export function proofPath(relative: string): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	return override
		? path.join(override, relative)
		: proofEvidencePath(`${relative}`);
}

export interface TransactionNetworkReceipt {
	errors: string[];
	pending: Set<Request>;
	reads: { url: string; method: string; headers: Record<string, string> }[];
	unknown: string[];
}
export const browserReceipts = new WeakMap<Page, TransactionNetworkReceipt>();
// The static build explicitly selects this tokenless local Core authority.
// The real useNodeStore fallback and API client still construct every request.
export const coreOrigin = "http://127.0.0.1:7980";

// Shipping AppUpdatesSettings and native preparation coordinator run unchanged.
// Preference storage below is the isolated native IPC fixture, not an OS-disk claim.
export async function preferenceOpen(page: import("@playwright/test").Page) {
	await page.goto("/app-update-transaction-proof.html?preference=1");
	await expect(
		page.getByRole("switch", { name: "Download app updates automatically" })
	).toBeChecked();
}
export async function preferenceWrites(page: import("@playwright/test").Page) {
	return page.evaluate(() =>
		window.updateProofIpcRequests.filter(
			(call) => call.command === "set_app_update_download_preference"
		)
	);
}
