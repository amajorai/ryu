import { expect, type Page } from "@playwright/test";

// Shared by the tab tear-out proof specs (tab-tearout-proof.spec.ts and
// tab-tearout-proof.drag.spec.ts).
declare global {
	interface Window {
		__tabTearoutClaimCommands: string[];
		__tabTearoutDragDiagnostics: Array<{
			type: string;
			defaultPrevented: boolean;
			buttons: number;
			effectAllowed: string | null;
			dropEffect: string | null;
			transferTypes: string[];
		}>;
		__tabTearoutDragEvents: string[];
		__tabTearoutSourceRemoved: boolean;
		__tabTearoutSplitSourceState: () => {
			connected: boolean;
			dragEnds: number;
		};
	}
}

export async function openWorkspace(page: Page) {
	await page.goto("/", { waitUntil: "domcontentloaded" });
	const notice = page.getByRole("button", { name: "Got it", exact: true });
	if (await notice.count()) {
		await notice.click();
	}
	await expect(
		page.locator('[data-tab-appearance][draggable="true"]')
	).toHaveCount(3);
}

/** A sealed localStorage value, read through the app's own sealed facade. */
export async function readSealedValue(
	page: Page,
	key: "ryu_session_tabs" | "ryu_workbench_layout_v2"
): Promise<string | null> {
	return await page.evaluate((sealedKey) => {
		const read = Reflect.get(window, "__readSealedLocalStorage");
		const raw: unknown = typeof read === "function" ? read(sealedKey) : null;
		return typeof raw === "string" ? raw : null;
	}, key);
}
