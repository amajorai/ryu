// Shared fixtures for the Desktop General settings proof specs (split from
// desktop-general-settings-proof.spec.ts to stay under the file-size limit).
import { expect, test } from "@playwright/test";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { PluginDocument } from "../src/lib/api/plugin-wire-values.ts";

const runtimeErrors = new WeakMap<import("@playwright/test").Page, string[]>();

export const STORY_URL = "/desktop-general-settings-proof.html";
export const NATIVE_STORE_MODE = parseNativeStoreMode(
	process.env.RYU_GENERAL_SETTINGS_STORE_MODE ?? "native"
);
export function parseNativeStoreMode(
	mode: string
): "native" | "browser-fallback" {
	if (mode === "native" || mode === "browser-fallback") {
		return mode;
	}
	throw new Error(
		"RYU_GENERAL_SETTINGS_STORE_MODE must be native or browser-fallback"
	);
}
export const ACCOUNT_STORE_KEY = "general-proof:native-store:auth.bin";
export const COVERAGE_ACCOUNT = {
	email: "coverage@example.test",
	image: null,
	name: "Coverage Account",
	token: "fixture-token",
	userId: "coverage-user",
};
export const SAVED_ACCOUNT_VAULT = {
	accounts: [COVERAGE_ACCOUNT],
	activeUserId: COVERAGE_ACCOUNT.userId,
};
export const VAULT_SLOT_KEY = "general-proof:sealed-slot:auth-vault";
export const ROOT_PROOF_SCREENSHOT = "desktop-general-settings-root-proof.png";
export const TERMINAL_PROOF_SCREENSHOT =
	"desktop-general-settings-terminal-proof.png";
export const PROOF_SCREENSHOT = "desktop-general-settings-proof.png";

export const DEFAULT_PROJECTLESS_FOLDER = String.raw`C:\Users\Proof\Documents\Ryu\Projects`;

export function evidencePath(name: string): string {
	return test.info().outputPath(`${name}.png`);
}

export interface GeneralProofCall {
	args?: InvokeArgs;
	command: string;
}

export interface GeneralGatewayCall {
	body: PluginDocument | null;
	method: string;
	path: string;
}

declare global {
	interface Window {
		__GENERAL_NATIVE_STORE_MODE__?: "native" | "browser-fallback";
		__generalGatewayCalls: GeneralGatewayCall[];
		__generalNativeStoreCalls: Array<{
			args?: Record<string, unknown>;
			command: string;
			acknowledged: boolean;
			value?: unknown;
		}>;
		__generalProofCalls: GeneralProofCall[];
		__generalProofFixture: {
			failNextCommand: (command: string, message?: string) => void;
			failNextGatewayRequest: (path: string, message?: string) => void;
			failNextFolderDialog: (message?: string) => void;
			setFolderSelection: (path: string | null) => void;
		};
		__generalUnknownCommands: string[];
	}
}

export async function proofCalls(
	page: import("@playwright/test").Page
): Promise<GeneralProofCall[]> {
	return page.evaluate(() => window.__generalProofCalls);
}

export async function gatewayCalls(
	page: import("@playwright/test").Page
): Promise<GeneralGatewayCall[]> {
	return page.evaluate(() => window.__generalGatewayCalls);
}

export const LEGACY_VAULT_KEYS = [
	"ryu_accounts",
	"ryu_active_user_id",
	"ryu_session_token",
] as const;
export const AUTH_STORE_VAULT_KEYS = ["accounts", "activeUserId", "token"];

export async function legacyVaultCopies(page: import("@playwright/test").Page) {
	return page.evaluate(
		({ keys, storeKey }) => ({
			webStorage: keys.map((key) => localStorage.getItem(key)),
			authStore: JSON.parse(localStorage.getItem(storeKey) ?? "{}"),
		}),
		{ keys: [...LEGACY_VAULT_KEYS], storeKey: ACCOUNT_STORE_KEY }
	);
}

// The account vault lives only in the sealed `auth-vault` slot: never in web
// storage and never in the plaintext `auth.bin` plugin store.
export async function assertAccountStoreBoundary(
	page: import("@playwright/test").Page,
	reloaded = false
) {
	if (NATIVE_STORE_MODE === "browser-fallback") {
		expect(
			await page.evaluate((key) => localStorage.getItem(key), VAULT_SLOT_KEY)
		).toBeNull();
		expect(
			await page.evaluate((key) => localStorage.getItem(key), ACCOUNT_STORE_KEY)
		).toBeNull();
		return;
	}
	await expect
		.poll(async () => {
			const saved = await page.evaluate(
				(key) => localStorage.getItem(key),
				VAULT_SLOT_KEY
			);
			return saved === null ? null : JSON.parse(saved);
		})
		.toEqual(SAVED_ACCOUNT_VAULT);
	const copies = await legacyVaultCopies(page);
	expect(copies.webStorage).toEqual([null, null, null]);
	for (const key of AUTH_STORE_VAULT_KEYS) {
		expect(copies.authStore).not.toHaveProperty(key);
	}
	const calls = await page.evaluate(() => window.__generalNativeStoreCalls);
	expect(
		calls.filter(
			(call) =>
				call.command === "plugin:store|set" &&
				AUTH_STORE_VAULT_KEYS.includes(String(call.args?.key))
		)
	).toEqual([]);
	const slotWrites = calls
		.filter((call) => call.command === "desktop_secret_set")
		.map((call) => ({
			acknowledged: call.acknowledged,
			name: call.args?.name,
			value: JSON.parse(String(call.args?.value)),
		}));
	if (reloaded) {
		expect(slotWrites).toEqual([]);
		const slotReads = calls
			.filter(
				(call) =>
					call.command === "desktop_secret_get" &&
					call.args?.name === "auth-vault" &&
					call.acknowledged
			)
			.map((call) => JSON.parse(String(call.value)));
		expect(slotReads).toContainEqual(SAVED_ACCOUNT_VAULT);
		return;
	}
	expect(slotWrites).toEqual([
		{ acknowledged: true, name: "auth-vault", value: SAVED_ACCOUNT_VAULT },
	]);
}

export async function failNativeCommand(
	page: import("@playwright/test").Page,
	command: string,
	message?: string
): Promise<void> {
	await page.evaluate(
		({ failureMessage, failureCommand }) =>
			window.__generalProofFixture.failNextCommand(
				failureCommand,
				failureMessage
			),
		{ failureCommand: command, failureMessage: message }
	);
}

export async function failGatewayRequest(
	page: import("@playwright/test").Page,
	path: string,
	message?: string
): Promise<void> {
	await page.evaluate(
		({ failureMessage, failurePath }) =>
			window.__generalProofFixture.failNextGatewayRequest(
				failurePath,
				failureMessage
			),
		{ failurePath: path, failureMessage: message }
	);
}

export async function setFolderSelection(
	page: import("@playwright/test").Page,
	path: string | null
): Promise<void> {
	await page.evaluate(
		(folderPath) => window.__generalProofFixture.setFolderSelection(folderPath),
		path
	);
}

export async function failFolderDialog(
	page: import("@playwright/test").Page,
	message?: string
): Promise<void> {
	await page.evaluate(
		(failureMessage) =>
			window.__generalProofFixture.failNextFolderDialog(failureMessage),
		message
	);
}

export async function chooseOption(
	page: import("@playwright/test").Page,
	triggerId: string,
	optionName: string
) {
	const trigger = page.locator(`#${triggerId}`);
	await expect(trigger).toBeVisible();
	await trigger.click();
	const listboxId = await trigger.getAttribute("aria-controls");
	const listbox = listboxId
		? page.locator(`[id="${listboxId}"]`)
		: page.getByRole("listbox").last();
	await listbox.getByRole("option", { exact: true, name: optionName }).click();
}

export function settingSwitch(
	page: import("@playwright/test").Page,
	id: string
): import("@playwright/test").Locator {
	// Base UI assigns id to the hidden input; click and assert its visible switch.
	return page.locator(`#${id}`).locator("..").getByRole("switch");
}

export async function togglePreference(
	page: import("@playwright/test").Page,
	control: import("@playwright/test").Locator,
	storageKey: string,
	serializedValue: (checked: boolean) => string = String
): Promise<boolean> {
	const before = await control.isChecked();
	await control.click();
	await expect(control).toBeChecked({ checked: !before });
	await expect(
		page.evaluate(({ key }) => localStorage.getItem(key), { key: storageKey })
	).resolves.toBe(serializedValue(!before));
	return !before;
}

declare global {
	interface Window {
		__generalGatewayCalls: GeneralGatewayCall[];
		__generalProofCalls: GeneralProofCall[];
		__generalProofFixture: {
			failNextCommand: (command: string, message?: string) => void;
			failNextGatewayRequest: (path: string, message?: string) => void;
			failNextFolderDialog: (message?: string) => void;
			setFolderSelection: (path: string | null) => void;
		};
	}
}

/**
 * The per-test guards every General settings spec shares: runtime errors,
 * the native-store mode and unknown native commands fail the test.
 */
export function registerGeneralProofHooks(): void {
	test.describe.configure({ timeout: 120_000 });
	test.afterEach(async ({ page }) => {
		expect(runtimeErrors.get(page) ?? []).toEqual([]);
		expect(
			await page.evaluate(() => window.__GENERAL_NATIVE_STORE_MODE__)
		).toBe(NATIVE_STORE_MODE);
		expect(await page.evaluate(() => window.__generalUnknownCommands)).toEqual(
			[]
		);
	});

	test.beforeEach(async ({ page }) => {
		const errors: string[] = [];
		runtimeErrors.set(page, errors);
		page.on("pageerror", (error) => errors.push(error.message));
		await page.addInitScript((mode) => {
			window.__GENERAL_NATIVE_STORE_MODE__ = mode;
		}, NATIVE_STORE_MODE);
		await page.route("**/favicon.ico", (route) =>
			route.fulfill({ status: 204 })
		);
	});
}
