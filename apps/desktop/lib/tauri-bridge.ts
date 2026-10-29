// Every command here is called during boot (App.tsx starts Core and polls its
// status in its first effect), which is exactly when Tauri may not have injected
// its bridge yet — so they all go through the shared ready-gate.

import type { StandaloneAppBundle } from "@ryu/app-host/standalone";
import { invokeWhenReady, isTauriReady } from "@/src/lib/tauri-ready.ts";

export const startRyuCore = () => invokeWhenReady<string>("start_ryu_core");
export const stopRyuCore = () => invokeWhenReady<void>("stop_ryu_core");
export const getRyuStatus = () => invokeWhenReady<string>("get_ryu_status");
export const getStandaloneAppBundle = () =>
	invokeWhenReady<StandaloneAppBundle | null>("get_standalone_app_bundle");
export interface StandaloneBootstrapResult {
	appId: string;
	appName: string;
	companionId: string | null;
	token: string;
}
export const bootstrapStandaloneApp = () =>
	invokeWhenReady<StandaloneBootstrapResult>("bootstrap_standalone_app");
export const getLocalNodeToken = () =>
	invokeWhenReady<{ source: string; token: string | null }>("local_node_token");
/**
 * Download the `ryu-core` binary into `~/.ryu{profile}/bin` if it is missing,
 * resolving to its path. A no-op (`"dev"`) in dev builds, where turbo owns the
 * binary. Called by the onboarding "run locally" pick, which is the first moment
 * we know the user actually wants a local Core — the app itself no longer
 * requires one to open.
 */
export const ensureCoreInstalled = () =>
	invokeWhenReady<string>("ensure_core_installed");

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Stop then start the Core process. Waits for health to drop before starting so
 * a node-reset wipe (which runs at the next boot) sees unlocked SQLite files —
 * especially important on Windows where handles linger briefly after exit.
 *
 * Retries start a few times: if wipe is still blocked Core exits immediately
 * (exit 75) without opening stores; another start then retries the wipe.
 */
export const restartRyuCore = async (): Promise<string> => {
	await stopRyuCore().catch(() => undefined);
	for (let i = 0; i < 40; i++) {
		const status = await getRyuStatus().catch(() => "stopped");
		if (status === "stopped") {
			break;
		}
		await sleep(150);
	}
	// Brief settle for OS file-handle release after the process tree dies.
	await sleep(800);

	let last = "";
	for (let attempt = 0; attempt < 5; attempt++) {
		last = await startRyuCore();
		// Give apply_pending_reset time to finish (or exit 75 on failure).
		await sleep(1200);
		const status = await getRyuStatus().catch(() => "stopped");
		if (status === "running") {
			return last;
		}
		await sleep(500);
	}
	return last;
};
export const openExternal = (url: string) =>
	invokeWhenReady<void>("open_external", { url });

export interface LinkMetadataPreview {
	description?: string | null;
	image?: string | null;
	siteName?: string | null;
	title?: string | null;
	url: string;
}

/** Fetch a public page's Open Graph metadata through the native shell (no CORS). */
export const previewLinkMetadata = (url: string) =>
	invokeWhenReady<LinkMetadataPreview>("preview_link_metadata", { url });

/** Open a tab in a separate OS window (browser-style "open in new window").
 * The new window re-fetches the conversation by id and keeps targeting `node`. */
export const openTabWindow = (opts: {
	path?: string;
	conversationId?: string;
	entityKey?: string;
	node?: string;
	title?: string;
}) =>
	invokeWhenReady<void>("open_tab_window", {
		entityKey: opts.entityKey ?? null,
		path: opts.path ?? null,
		conversationId: opts.conversationId ?? null,
		node: opts.node ?? null,
		title: opts.title ?? null,
	});

/** Open or focus the app-first window for an installed app. */
export async function openStandaloneAppWindow(opts: {
	appId: string;
	title: string;
}): Promise<void> {
	if (!isTauriReady() && globalThis.window) {
		const url = new URL(window.location.href);
		url.pathname = "/";
		url.search = new URLSearchParams({
			appId: opts.appId,
			window: "standalone-app",
		}).toString();
		const opened = window.open(url.toString(), "_blank", "noopener,noreferrer");
		if (!opened) {
			throw new Error("The standalone app window was blocked by the browser.");
		}
		return;
	}
	await invokeWhenReady<void>("open_standalone_app_window", {
		appId: opts.appId,
		title: opts.title,
	});
}

/** Close the current app-first window without changing app lifecycle. */
export async function closeCurrentWindow(): Promise<void> {
	if (!isTauriReady() && globalThis.window) {
		window.close();
		return;
	}
	await invokeWhenReady<void>("close_current_window");
}
