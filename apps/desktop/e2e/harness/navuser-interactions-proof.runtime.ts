import { z } from "zod";
import type { LinkMetadataPreview } from "../../lib/tauri-bridge.ts";
import type { ProofJsonValue } from "../fixture-json.ts";
import { answerDesktopSecretSlot } from "./desktop-secret-slots.ts";
export interface NavUserProofState {
	externalUrls: string[];
	hiddenChrome: string[];
	nativeCalls: Array<{ args: unknown; command: string }>;
	openTabs: string[];
	upgradeRequests: string[];
}

declare global {
	interface Window {
		__NAVUSER_PROOF__?: NavUserProofState;
	}
}

const authStore = new Map<string, ProofJsonValue>();

export function navUserProofState(): NavUserProofState {
	window.__NAVUSER_PROOF__ ??= {
		externalUrls: [],
		hiddenChrome: [],
		nativeCalls: [],
		openTabs: [],
		upgradeRequests: [],
	};
	return window.__NAVUSER_PROOF__;
}

export async function openExternal(url: string): Promise<void> {
	navUserProofState().externalUrls.push(url);
}

type NavUserNativeArgs = Record<string, unknown>;

export async function invoke(command: string, args?: NavUserNativeArgs) {
	navUserProofState().nativeCalls.push({
		args: structuredClone(args ?? null),
		command,
	});
	// The sealed `auth-vault` / `license-key` slots, kept in this tab's
	// sessionStorage so they survive the spec's reloads. The plaintext vault the
	// spec seeds migrates into the slot on first load, as an upgraded install's
	// does, and every later switch, sign-in and sign-out is written there.
	const slot = answerDesktopSecretSlot(sessionStorage, command, args);
	if (slot.handled) {
		return slot.value;
	}
	if (command === "list_nodes") {
		return { default: "local", nodes: [] };
	}
	if (command === "get_ryu_status") {
		return "running";
	}
	return undefined;
}

export async function restartRyuCore(): Promise<string> {
	return "running";
}

export async function startRyuCore(): Promise<string> {
	return "running";
}

export async function getRyuStatus(): Promise<string> {
	return "running";
}

export async function listen<_T>(): Promise<() => void> {
	return () => undefined;
}

export async function openTabWindow(): Promise<void> {
	return undefined;
}

// The fixture serves no public pages, so the shell's Open Graph fetch fails the
// way the native command does when the page is unreachable.
export async function previewLinkMetadata(
	url: string
): Promise<LinkMetadataPreview> {
	await invoke("preview_link_metadata", { url });
	throw new Error(`Fixture serves no page to preview at ${url}`);
}

export async function openStandaloneAppWindow(options: {
	appId: string;
	title: string;
}): Promise<void> {
	await invoke("open_standalone_app_window", {
		appId: options.appId,
		title: options.title,
	});
}

export async function closeCurrentWindow(): Promise<void> {
	await invoke("close_current_window");
}

export class TauriUnavailableError extends Error {
	readonly target: string;

	constructor(target: string) {
		super(`Fixture Tauri command unavailable: ${target}`);
		this.name = "TauriUnavailableError";
		this.target = target;
	}
}

/** Mirrors tauri-ready.ts: a fixture's own unavailable error means "no backend". */
export function isNoDesktopBackend(error: unknown): boolean {
	return error instanceof TauriUnavailableError;
}

/** The proof renders the native shell, so the bridge is present. */
export function isTauriReady(): boolean {
	return true;
}

export async function invokeWhenReady(
	command: string,
	args?: NavUserNativeArgs
) {
	return invoke(command, args);
}

export async function listenWhenReady<T>(): Promise<() => void> {
	return listen<T>();
}

export async function withTauri<T>(work: () => Promise<T> | T): Promise<T> {
	return await work();
}

export async function load() {
	return {
		delete: async (key: string) => {
			authStore.delete(key);
		},
		get: async (key: string) => authStore.get(key),
		save: async () => undefined,
		set: async <Value>(key: string, value: Value) => {
			authStore.set(key, z.json().parse(value));
		},
	};
}

export async function getVersion(): Promise<string> {
	return "1.2.3";
}

export async function open(): Promise<null> {
	return null;
}

export async function save(): Promise<null> {
	return null;
}

export async function confirm(): Promise<boolean> {
	return true;
}

export async function message(): Promise<void> {
	return undefined;
}

export async function exit(): Promise<void> {
	return undefined;
}

export async function relaunch(): Promise<void> {
	return undefined;
}
