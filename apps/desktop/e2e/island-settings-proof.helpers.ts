import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { IslandSettingsProofPublisher } from "./harness/island-settings-proof.tsx";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for island-settings-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const WINDOWS_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface IslandSettingsProofWindow extends Window {
	__islandSettingsProof: IslandSettingsProofPublisher;
}
declare const window: IslandSettingsProofWindow;
export type IslandSettingsSnapshot = ReturnType<
	IslandSettingsProofPublisher["snapshot"]
>;
export type CapturedRequest = IslandSettingsSnapshot["requests"][number];

export const NODE_TOKEN = "island-settings-proof-token";
export const ISLAND_PREFERENCE_KEYS = new Set([
	"island-appearance",
	"island-edge-offset",
	"island-auto-jump",
	"island-hide-on-fullscreen",
	"island-screen-privacy",
	"island-agents",
	"voice-input",
	"island-command-shortcut",
	"island-tts",
	"island-consent",
]);

// Verification runs set RYU_PROOF_OUTPUT_ROOT so screenshots land in scratch
// space instead of rewriting the tracked sweep evidence.
export function evidencePath(name: string): string {
	return process.env.RYU_PROOF_OUTPUT_ROOT
		? path.resolve(process.env.RYU_PROOF_OUTPUT_ROOT, `${name}.png`)
		: proofEvidencePath(`test-coverage-sweep-20260924/evidence/${name}.png`);
}

export async function readProof(page: Page): Promise<IslandSettingsSnapshot> {
	return page.evaluate(() =>
		/* SAFETY: island-settings-proof.tsx installs __islandSettingsProof before this proof page is evaluated. */ (
			window as IslandSettingsProofWindow
		).__islandSettingsProof.snapshot()
	);
}

export function preferenceWrite(
	key: string,
	value: string,
	status = 200
): CapturedRequest {
	return {
		body: { value },
		headerAuthorization: `Bearer ${NODE_TOKEN}`,
		method: "PUT",
		path: `/api/preferences/${key}`,
		status,
	};
}

export function expectNodeAuthorization(requests: CapturedRequest[]): void {
	expect(requests.length).toBeGreaterThan(0);
	for (const request of requests) {
		expect(request.headerAuthorization).toBe(`Bearer ${NODE_TOKEN}`);
	}
}

export function preferenceWrites(
	snapshot: IslandSettingsSnapshot,
	key: string
): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.path === `/api/preferences/${key}` && request.method === "PUT"
	);
}

export function islandPreferenceWrites(
	snapshot: IslandSettingsSnapshot
): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.method === "PUT" &&
			ISLAND_PREFERENCE_KEYS.has(request.path.slice("/api/preferences/".length))
	);
}

export function shadowWrites(
	snapshot: IslandSettingsSnapshot
): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/shadow/capture/control") &&
			request.method === "POST"
	);
}

export async function openIslandSettings(
	page: Page,
	query = ""
): Promise<void> {
	await page.goto(`/island-settings-proof.html${query}`);
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Privacy & permissions" })
	).toBeVisible();
	await expect(
		page.getByText("Island is turned off", { exact: true })
	).toHaveCount(0);
}

export async function armFailure(
	page: Page,
	method: string,
	path: string,
	status = 503
): Promise<void> {
	await page.evaluate(
		({ requestMethod, requestPath, responseStatus }) =>
			/* SAFETY: island-settings-proof.tsx installs __islandSettingsProof before this proof page is evaluated. */ (
				window as IslandSettingsProofWindow
			).__islandSettingsProof.armFailure(
				requestMethod,
				requestPath,
				responseStatus
			),
		{ requestMethod: method, requestPath: path, responseStatus: status }
	);
}

export async function expectPreferenceReadsReady(page: Page): Promise<void> {
	await expect
		.poll(async () => {
			const { requests } = await readProof(page);
			return requests
				.filter(
					(request) =>
						request.method === "GET" &&
						request.path.startsWith("/api/preferences/")
				)
				.map((request) => request.path);
		})
		.toEqual(
			expect.arrayContaining([
				"/api/preferences/island-appearance",
				"/api/preferences/island-edge-offset",
				"/api/preferences/island-auto-jump",
				"/api/preferences/island-hide-on-fullscreen",
				"/api/preferences/island-screen-privacy",
				"/api/preferences/island-agents",
				"/api/preferences/voice-input",
				"/api/preferences/island-command-shortcut",
				"/api/preferences/island-tts",
				"/api/preferences/island-consent",
			])
		);
}

export async function selectOption(
	page: Page,
	label: string,
	option: string
): Promise<void> {
	await page.getByRole("combobox", { exact: true, name: label }).click();
	if (label === "Proactive suggestion agent") {
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: evidencePath("island-settings-agent-routing-options-open"),
		});
	}
	await page.getByRole("option", { name: option, exact: true }).click();
}

export async function expectPreference(
	page: Page,
	key: string,
	value: string
): Promise<void> {
	await expect
		.poll(async () => (await readProof(page)).preferences[key])
		.toBe(value);
}
