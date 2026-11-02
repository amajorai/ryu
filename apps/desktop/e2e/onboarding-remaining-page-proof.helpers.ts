// Native-bridge fixture and navigation helpers for the onboarding
// remaining-page proof.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import {
	type ProofJsonRecord,
	type ProofJsonValue,
	parseProofJsonRecord,
} from "./fixture-json.ts";
import { answerDesktopSecretSlot } from "./harness/desktop-secret-slots.ts";
import {
	type NativeOnboardingFixtureState,
	parseNativeOnboardingFixtureState,
} from "./onboarding-fixture-contract.ts";
import { EVIDENCE } from "./onboarding-remaining-page-proof.fixture.ts";

declare global {
	interface Window {
		remainingNativeInvoke?: (
			command: string,
			args?: ProofJsonRecord
		) => Promise<ProofJsonValue>;
	}
}

export async function nativeFixture(page: Page, phase: string) {
	const dir = await mkdtemp(path.join(tmpdir(), "ryu-remaining-native-"));
	const statePath = path.join(dir, "native.json");
	const calls: {
		command: string;
		args: ProofJsonRecord | undefined;
	}[] = [];
	const state: NativeOnboardingFixtureState = {
		autostart: false,
		tray: true,
		automatic: false,
		prepared: null,
		installed: false,
	};
	const failures = new Set<string>();
	// The sealed `auth-vault` / `license-key` slots, kept for this page's life
	// across reloads. Empty, so a vault a test seeds in localStorage migrates in.
	const slotRecord = new Map<string, string>();
	const slotStorage = {
		getItem: (key: string) => slotRecord.get(key) ?? null,
		setItem: (key: string, value: string) => {
			slotRecord.set(key, value);
		},
	};
	await writeFile(statePath, JSON.stringify(state));
	await page.exposeBinding(
		"remainingNativeInvoke",
		async (_source, command: string, rawArgs?: ProofJsonRecord) => {
			const args =
				rawArgs === undefined
					? undefined
					: parseProofJsonRecord(JSON.stringify(rawArgs));
			calls.push({ command, args });
			if (failures.delete(command)) {
				throw new Error("Fixture native command denied");
			}
			const slot = answerDesktopSecretSlot(slotStorage, command, args ?? {});
			if (slot.handled) {
				return slot.value;
			}
			let value: ProofJsonValue = null;
			switch (command) {
				case "plugin:autostart|is_enabled":
					value = state.autostart;
					break;
				case "plugin:autostart|enable":
					state.autostart = true;
					break;
				case "plugin:autostart|disable":
					state.autostart = false;
					break;
				case "get_close_to_tray":
					value = state.tray;
					break;
				case "set_close_to_tray":
					state.tray = args?.enabled === true;
					break;
				case "get_app_update_download_preference":
					value = state.automatic;
					break;
				case "set_app_update_download_preference":
					state.automatic = args?.enabled === true;
					break;
				case "plugin:app|version":
					value = "0.1.0";
					break;
				case "get_prepared_app_update":
					value = state.prepared;
					break;
				case "prepare_app_update":
					state.prepared = {
						schemaVersion: 1,
						version: "0.2.0",
						signature: "fixture-signature",
						artifactFile: "fixture.zip",
						artifactSize: 100,
						source: { kind: "stable" },
					};
					value = state.prepared;
					break;
				case "install_prepared_app_update":
					state.installed = true;
					value = true;
					break;
				case "plugin:event|listen":
					value = 1;
					break;
				case "plugin:event|unlisten":
					break;
				case "open_external":
					break;
				default:
					throw new Error(`Unimplemented native fixture command ${command}`);
			}
			await writeFile(statePath, JSON.stringify(state));
			return value;
		}
	);
	await page.addInitScript(
		({ phase }) => {
			localStorage.setItem("ryu_desktop_onboarding_phase", phase);
			localStorage.setItem("ryu_autostart_seeded", "true");
			const invoke = window.remainingNativeInvoke;
			if (!invoke) {
				throw new Error("Fixture native binding unavailable");
			}
			Object.assign(window, {
				__TAURI_INTERNALS__: {
					invoke,
					transformCallback: () => 1,
					unregisterCallback: () => {},
					metadata: {
						currentWindow: { label: "main" },
						currentWebview: { label: "main" },
					},
				},
			});
		},
		{ phase }
	);
	return {
		calls,
		failures,
		read: async () =>
			parseNativeOnboardingFixtureState(await readFile(statePath, "utf8")),
	};
}
export async function screenshot(page: Page, name: string) {
	await mkdir(EVIDENCE, { recursive: true });
	await page.screenshot({
		path: path.join(EVIDENCE, `onboarding-remaining-${name}.png`),
		fullPage: true,
		animations: "disabled",
	});
}
export async function phase(page: Page, value: string, nodePending = false) {
	await page.addInitScript(
		({ value, nodePending }) => {
			localStorage.setItem("ryu_desktop_onboarding_phase", value);
			if (nodePending) {
				localStorage.setItem("remaining_node_pending", "true");
			}
		},
		{ value, nodePending }
	);
}
