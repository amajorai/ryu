// Shared harness API and helpers for the node-selector-proof*.spec.ts files.

import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type {
	NodeSelectorApiCall,
	NodeSelectorNativeCall,
} from "./harness/node-selector-proof.mock.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

export interface NodeRow {
	managed?: boolean;
	name: string;
	orgId?: string | null;
	token: string | null;
	url: string;
	userJwt?: string | null;
}

export interface NodeSelectorSnapshot {
	apiCalls: NodeSelectorApiCall[];
	clipboardWrites: string[];
	defaultNode: string;
	externalUrls: string[];
	nativeCalls: NodeSelectorNativeCall[];
	nodes: NodeRow[];
}

// The harness mock types the global `__NODE_SELECTOR_PROOF__` as its full
// state; this spec reads only the API below, so it narrows that one property.
export interface NodeSelectorWindow
	extends Omit<Window, "__NODE_SELECTOR_PROOF__"> {
	__CLOSE_NODE_SELECTOR_SETTINGS__: () => void;
	__NODE_SELECTOR_PROOF__: {
		armApiFailure: (method: string, path: string, status?: number) => void;
		armClipboardFailure: () => void;
		armNativeFailure: (command: string) => void;
		setNodeOnline: (name: string, online: boolean) => void;
		snapshot: () => NodeSelectorSnapshot;
	};
	__READ_NODE_SELECTOR_STATE__: () => {
		autoSelect: boolean;
		autoSelectedNode: string | null;
		defaultNode: string;
		gateway: { open: boolean; section: string };
		localNodes: NodeRow[];
		nodes: NodeRow[];
		settings: { open: boolean; section: string };
		suggestedCloudNodes: Array<{ name: string; url: string }>;
	};
}

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidenceOverride = process.env.RYU_PROOF_EVIDENCE_DIR;
export const evidence = (name: string) =>
	evidenceOverride
		? path.join(evidenceOverride, name)
		: proofEvidencePath("test-coverage-sweep-20260924/evidence", name);
export const decisionModelsEvidence = (name: string) =>
	evidenceOverride
		? path.join(evidenceOverride, "decision-models-20260929", name)
		: proofEvidencePath("decision-models-20260929", name);

export async function openSelector(
	page: Page,
	mode: "compact" | "persistent" = "compact",
	query = ""
): Promise<void> {
	const params = new URLSearchParams({ mode, reset: "true" });
	if (query) {
		for (const [key, value] of new URLSearchParams(query)) {
			params.set(key, value);
		}
	}
	await page.goto(`/node-selector-proof.html?${params.toString()}`);
	await expect(
		page.getByRole("heading", { name: "Node selector", exact: true })
	).toBeVisible();
}

export async function readSnapshot(page: Page): Promise<NodeSelectorSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.snapshot()
	);
}

export async function readState(page: Page) {
	return await page.evaluate(() =>
		/* SAFETY: node-selector-proof.tsx installs __READ_NODE_SELECTOR_STATE__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__READ_NODE_SELECTOR_STATE__()
	);
}

export async function openCompactMenu(
	page: Page,
	name: RegExp | string = "Your computer"
) {
	const trigger = page
		.getByTestId("node-selector-surface")
		.getByRole("button")
		.first();
	await expect(trigger).toContainText(name);
	await trigger.click();
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	return { menu, trigger };
}

/** Open the expanded computer dialog from the compact menu and go to its
 *  Engines & models page. The dialog's title follows the page stack, so it is
 *  returned by role alone. */
export async function openEnginesPage(page: Page) {
	const { menu } = await openCompactMenu(page);
	await menu
		.getByRole("menuitem", { name: /Engines, voice, toolkits/ })
		.click();
	await expect(page.getByRole("dialog", { name: "Computer" })).toBeVisible();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: /^Engines & models/ }).click();
	await expect(
		dialog.getByRole("heading", { name: "Decision Models", exact: true })
	).toBeVisible();
	return dialog;
}
