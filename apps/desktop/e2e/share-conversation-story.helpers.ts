import { mkdir } from "node:fs/promises";
import path from "node:path";
import { proofEvidencePath } from "./proof-evidence-path.ts";
import { apiCallsProofSchema } from "./settings-domain-proof.contracts.ts";

// Fixtures and helpers for share-conversation-story.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const EVIDENCE_ROOT = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);
export const HISTORY_EVIDENCE_ROOT = proofEvidencePath(
	"portable-git-history-20260930"
);

export async function apiCalls(page: import("@playwright/test").Page) {
	const text = await page.getByTestId("share-calls").textContent();
	return apiCallsProofSchema.parse(JSON.parse(text ?? "[]"));
}

export async function capture(
	page: import("@playwright/test").Page,
	name: string
) {
	await mkdir(EVIDENCE_ROOT, { recursive: true });
	return page.screenshot({
		fullPage: true,
		path: path.join(EVIDENCE_ROOT, name),
	});
}
