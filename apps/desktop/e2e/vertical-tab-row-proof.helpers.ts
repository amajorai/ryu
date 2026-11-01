import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { VerticalTabSnapshot } from "./harness/vertical-tab-row-proof.tsx";
import type { VerticalTabProofState } from "./harness/vertical-tab-row-tauri.mock.ts";

// Shared by the vertical-tab-row proof specs (vertical-tab-row-proof.spec.ts
// and vertical-tab-row-proof.splits.spec.ts).
export interface VerticalTabWindow extends Window {
	__READ_VERTICAL_TAB_STATE__: () => VerticalTabSnapshot;
	__VERTICAL_TAB_PROOF__: VerticalTabProofState;
}
declare const window: VerticalTabWindow;
export type TabSnapshot = VerticalTabSnapshot["tabs"][number];

export const evidence = (name: string) =>
	path.resolve(
		import.meta.dirname,
		"../../..",
		"docs/proof/test-coverage-sweep-20260924/evidence",
		name
	);

export const rowByTitle = (page: Page, title: string, occurrence = 0) =>
	page
		.getByRole("button", { name: `Close ${title}`, exact: true })
		.nth(occurrence)
		.locator("xpath=ancestor::li[@data-sidebar='menu-item'][1]");

export const rowActivator = (row: ReturnType<typeof rowByTitle>) =>
	row.locator('[role="button"]');

export async function openFreshProof(page: Page): Promise<void> {
	await page.goto("/vertical-tab-row-proof.html?seed=true&layout=vertical");
	await expect(
		page.getByRole("heading", { name: "Tabs", exact: true })
	).toBeVisible();
	await expect(rowByTitle(page, "Alpha conversation")).toBeVisible();
	await expect(rowByTitle(page, "Beta conversation")).toBeVisible();
	await expect.poll(async () => (await readState(page)).tabs.length).toBe(2);
}

export async function readState(page: Page): Promise<VerticalTabSnapshot> {
	// The harness renders after sealed storage hydrates, so after a reload the
	// reader appears once the restored session has rendered.
	await page.waitForFunction(
		() =>
			typeof Reflect.get(window, "__READ_VERTICAL_TAB_STATE__") === "function"
	);
	return await page.evaluate(() =>
		/* SAFETY: vertical-tab-row-proof.tsx installs __READ_VERTICAL_TAB_STATE__ on render, awaited above. */ window.__READ_VERTICAL_TAB_STATE__()
	);
}

export async function openTabContext(
	page: Page,
	title: string,
	occurrence = 0
) {
	const row = rowByTitle(page, title, occurrence);
	await rowActivator(row).click({ button: "right" });
	const menu = page.locator('[data-slot="context-menu-content"]');
	await expect(menu).toBeVisible();
	return { menu, row };
}

export function tabForConversation(
	state: VerticalTabSnapshot,
	conversationId: string
): TabSnapshot {
	const tab = state.tabs.find(
		(candidate) => candidate.conversationId === conversationId
	);
	if (!tab) {
		throw new Error(`Missing fixture tab for ${conversationId}`);
	}
	return tab;
}

/** The sealed session snapshot, read through the app's own sealed facade. */
export async function readSealedSession(page: Page): Promise<string | null> {
	return await page.evaluate(() => {
		const read = Reflect.get(window, "__readSessionTabs");
		const raw: unknown = typeof read === "function" ? read() : null;
		return typeof raw === "string" ? raw : null;
	});
}
