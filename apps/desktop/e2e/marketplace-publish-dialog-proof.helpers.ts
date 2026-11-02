import { expect, type Page } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for marketplace-publish-dialog-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export interface PublishRequest {
	body: unknown;
	method: string;
	path: string;
	query: Record<string, string>;
	status: number | null;
}

export interface PublishProofSnapshot {
	externalNavigationAttempts: string[];
	listingCount: number;
	requests: PublishRequest[];
	tauriCalls: Array<{ args: unknown; command: string }>;
}

export interface PublishProofBridge {
	armPublishMode: (
		mode:
			| "fail-once"
			| "github-install-required"
			| "hold-once"
			| "preflight-fail"
	) => void;
	failNextInstallStatus: () => void;
	resolveHeldPublish: () => void;
	snapshot: () => PublishProofSnapshot;
}

declare global {
	interface Window {
		__marketplacePublishProof: PublishProofBridge;
	}
}

export function screenshotPath(name: string): string {
	return proofEvidencePath("test-coverage-sweep-20260924/evidence", name);
}

export async function readProof(page: Page): Promise<PublishProofSnapshot> {
	return page.evaluate(() => window.__marketplacePublishProof.snapshot());
}

export async function openPublisher(page: Page): Promise<void> {
	await page.goto("/marketplace-publish-dialog-proof.html");
	await expect(
		page.getByRole("heading", { name: "Publish App from GitHub" })
	).toBeVisible();
}

export async function selectOffer(page: Page, label: string): Promise<void> {
	await page.getByLabel("Offer").click();
	await page.getByRole("option", { name: label, exact: true }).click();
}

export function publishRequests(
	snapshot: PublishProofSnapshot
): PublishRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.method === "POST" &&
			request.path === "/api/marketplace/github/publish"
	);
}
