import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { normalizeState } from "../../../apps-store/autopilot/ui/src/model.ts";
import type { AutopilotState } from "../../../apps-store/autopilot/ui/src/types.ts";
import { parseProofJson } from "./fixture-json.ts";
import type {
	AutopilotProofApi,
	AutopilotProofCall,
} from "./harness/autopilot-companion-proof.types.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for autopilot-companion-proof.autopilot.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const appHtmlPath = process.env.RYU_AUTOPILOT_BUILD_HTML;
if (!appHtmlPath) {
	throw new Error(
		"Run this proof with autopilot-companion-proof.playwright.config.ts so the production satellite is built first."
	);
}
export const evidenceDirectory = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);
export const APP_HTML = await readFile(appHtmlPath, "utf8");

declare global {
	interface Window {
		__autopilotProof: AutopilotProofApi;
	}
}

export async function mount(
	page: Page,
	options: { fresh?: boolean; section?: string } = {}
): Promise<FrameLocator> {
	if (!page.url().endsWith("/autopilot-companion-proof.html")) {
		await page.goto("/autopilot-companion-proof.html", {
			waitUntil: "domcontentloaded",
		});
	}
	await expect(page.locator("body")).toHaveAttribute("data-harness-ready", "1");
	await expect
		.poll(() => page.evaluate(() => Boolean(window.__autopilotProof)))
		.toBe(true);
	if (options.fresh) {
		await page.evaluate(() => window.__autopilotProof.reset());
	}
	await page.evaluate(
		({ appHtml, section }) =>
			window.__autopilotProof.mount({
				appHtml,
				...(section ? { section } : undefined),
			}),
		{ appHtml: APP_HTML, section: options.section }
	);
	await expect
		.poll(() => page.evaluate(() => window.__autopilotProof.connected()))
		.toBe(true);
	const companion = page.frameLocator('iframe[title="Autopilot proof"]');
	await expect(companion.locator(".autopilot-root")).toBeVisible();
	return companion;
}

export async function remount(
	page: Page,
	section?: string
): Promise<FrameLocator> {
	return await mount(page, { section });
}

export async function storedState(page: Page): Promise<AutopilotState | null> {
	const value = await page.evaluate(() =>
		window.__autopilotProof.storedState()
	);
	return value ? normalizeState(parseProofJson(value)) : null;
}

export async function calls(page: Page): Promise<AutopilotProofCall[]> {
	return await page.evaluate(() => window.__autopilotProof.calls());
}

export async function waitForStoredState(
	page: Page,
	predicate: (state: AutopilotState | null) => boolean
): Promise<AutopilotState> {
	await expect.poll(async () => predicate(await storedState(page))).toBe(true);
	const state = await storedState(page);
	if (!state) {
		throw new Error("Autopilot did not persist its state to the local host.");
	}
	return state;
}

export async function waitForCall(
	page: Page,
	method: AutopilotProofCall["method"],
	count: number
): Promise<AutopilotProofCall[]> {
	await expect
		.poll(
			async () =>
				(await calls(page)).filter((call) => call.method === method).length
		)
		.toBeGreaterThanOrEqual(count);
	return await calls(page);
}

export async function capture(
	companion: FrameLocator,
	filename: string
): Promise<void> {
	await mkdir(evidenceDirectory, { recursive: true });
	await companion.locator("body").screenshot({
		path: path.join(evidenceDirectory, filename),
	});
}

export async function scrollToTop(companion: FrameLocator): Promise<void> {
	await companion.locator(".autopilot-main").evaluate((element) => {
		if (element instanceof HTMLElement) {
			element.scrollTo(0, 0);
		}
	});
}

export function lastCall(
	allCalls: AutopilotProofCall[],
	method: AutopilotProofCall["method"]
): AutopilotProofCall {
	const call = allCalls.filter((item) => item.method === method).at(-1);
	if (!call) {
		throw new Error(`No Autopilot ${method} call was recorded.`);
	}
	return call;
}
