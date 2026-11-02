import { expect, type Page } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for developer-account-sessions-settings-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

declare const window: Window;

export const STORY_URL = "/developer-account-sessions-settings-proof.html";
// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
export const EVIDENCE_DIR =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	proofEvidencePath("test-coverage-sweep-20260924/evidence");

export interface NativeProofClipboard {
	fail: boolean;
	text: string;
}

declare global {
	interface Window {
		__settingsProofClipboard: NativeProofClipboard;
	}
}

export interface ProofWindow extends Window {
	__settingsProofAuthCalls: Array<{ body?: unknown; method: string }>;
	__settingsProofCalls: Array<{ body?: unknown; method: string; path: string }>;
	__settingsProofClearToasts: () => void;
	__settingsProofClipboard: NativeProofClipboard;
	__settingsProofDelayRequest: (path: string, durationMs: number) => void;
	__settingsProofFailAuth: (method: string) => void;
	__settingsProofFailCommand: (command: string) => void;
	__settingsProofFailRequest: (path: string) => void;
	__settingsProofReadMetrics: () => {
		devMode: string | null;
		enabled: boolean;
		text: string;
	};
	__settingsProofRecordMetrics: () => void;
}

export async function openProof(page: Page, query = "") {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.addInitScript(() => {
		const clipboard = { fail: false, text: "" };
		Object.defineProperty(window, "__settingsProofClipboard", {
			configurable: true,
			value: clipboard,
		});
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				readText: async () => clipboard.text,
				writeText: async (text: string) => {
					if (clipboard.fail) {
						throw new Error("Fixture clipboard failure");
					}
					clipboard.text = text;
				},
			},
		});
	});
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(`${STORY_URL}${query}`);
	await expect(page.getByTestId("developer-tab")).toBeVisible();
	await expect(page.getByTestId("account-tab")).toBeVisible();
	await expect(page.getByTestId("sessions-tab")).toBeVisible();
}

export async function clipboardText(page: Page): Promise<string> {
	return page.evaluate(() => window.__settingsProofClipboard.text);
}

export async function setClipboardFailure(page: Page, fail: boolean) {
	await page.evaluate((shouldFail) => {
		window.__settingsProofClipboard.fail = shouldFail;
	}, fail);
}

export async function failRequest(page: Page, requestPath: string) {
	await page.evaluate((value) => {
		/* SAFETY: developer-account-sessions-settings-proof.tsx installs __settingsProofFailRequest before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofFailRequest(value);
	}, requestPath);
}

export async function failAuth(page: Page, method: string) {
	await page.evaluate((value) => {
		/* SAFETY: proof-auth-client.ts installs __settingsProofFailAuth before this proof page is evaluated. */ (
			window as ProofWindow
		).__settingsProofFailAuth(value);
	}, method);
}
