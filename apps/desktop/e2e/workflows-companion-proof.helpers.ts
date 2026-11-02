import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";
import { parseWorkflowCompanionSnapshot } from "./workflow-companion-fixture-contract.ts";
import type { FixtureReset } from "./workflow-fixture-contract.ts";

// Shared fixture helpers for the workflows Companion proofs
// (workflows-companion-proof, -bindings-proof and -nodes-proof specs).
// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger, as the other proof specs do.
const evidenceDir =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	proofEvidencePath("test-coverage-sweep-20260924/evidence");

export async function resetFixture(page: Page, options: FixtureReset = {}) {
	const response = await page.request.post("/__fixture/reset", {
		data: {
			failures: options.failures ?? { "workflows.save": 1 },
			recipes: options.recipes,
			recordStopResult: options.recordStopResult,
			workflows: options.workflows ?? [],
		},
	});
	expect(response.ok()).toBeTruthy();
}

export async function fixtureState(page: Page) {
	const response = await page.request.get("/__fixture/state");
	expect(response.ok()).toBeTruthy();
	return parseWorkflowCompanionSnapshot(await response.text());
}

export async function addNode(page: Page, name: string) {
	await page.getByPlaceholder("Search nodes").fill(name);
	await page.getByRole("button", { name, exact: true }).click();
}

export async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}
