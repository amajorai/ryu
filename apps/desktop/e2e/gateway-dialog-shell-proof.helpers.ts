import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

// Shared by gateway-dialog-shell-proof.spec.ts: the proof page URL, the
// evidence ledger path and the snapshot/opening helpers.

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
export function evidencePath(ledgerPath: string): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	return override
		? path.join(override, ledgerPath)
		: fileURLToPath(
				new URL(`../../../docs/proof/${ledgerPath}`, import.meta.url)
			);
}

export const STORY_URL = "/gateway-dialog-shell-proof.html";

interface GatewayDialogShellSnapshot {
	calls: { body: unknown; method: string; path: string }[];
	preferences: Record<string, string>;
	tauriCalls: { args: unknown; command: string }[];
}

interface GatewayDialogShellWindow extends Window {
	__gatewayDialogShellProof: { snapshot: () => GatewayDialogShellSnapshot };
}

export async function readSnapshot(page: Page) {
	return page.evaluate(() =>
		/* SAFETY: gateway-dialog-shell-proof.tsx installs __gatewayDialogShellProof before this proof page is evaluated. */ (
			window as GatewayDialogShellWindow
		).__gatewayDialogShellProof.snapshot()
	);
}

/** The settings body is a lazy chunk. Until it resolves, its Suspense fallback
 *  renders the same dialog shell with an "Opening settings" description, so
 *  wait for the real body before asserting on its contents. */
export async function waitForSettingsBody(page: Page) {
	await expect(page.getByText("Opening settings", { exact: true })).toHaveCount(
		0,
		{ timeout: 60_000 }
	);
}

export async function openDialog(
	page: Page,
	query = "reset=true&gatewayDown=true&freezeStatusPoll=true"
) {
	await page.goto(`${STORY_URL}?${query}`);
	await expect(
		page.locator('[data-slot="dialog-content"]').first()
	).toBeVisible();
	await waitForSettingsBody(page);
}
