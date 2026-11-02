import { expect, type Locator, type Page } from "@playwright/test";
import {
	type FeedbackFixtureSnapshot,
	parseFeedbackFixtureSnapshot,
} from "./feedback-board-fixture-contract.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for feedback-board-behavior-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const evidenceDir = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

export async function resetFixture(page: Page, emptyBoard = false) {
	const response = await page.request.post("/__fixture/reset", {
		data: { emptyBoard },
	});
	expect(response.ok()).toBe(true);
}

export async function fixtureState(
	page: Page
): Promise<FeedbackFixtureSnapshot> {
	const response = await page.request.get("/__fixture/state");
	expect(response.ok()).toBe(true);
	return parseFeedbackFixtureSnapshot(await response.text());
}

export async function expectModeOptionDescriptionsFit(container: Locator) {
	const descriptions = container.locator(
		".admin-mode-grid .admin-mode-card > span"
	);
	await expect(descriptions).toHaveCount(5);
	const overflow = await descriptions.evaluateAll((elements) =>
		elements.map((element) => element.scrollWidth > element.clientWidth)
	);
	expect(overflow).toEqual([false, false, false, false, false]);
}
