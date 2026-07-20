import { invoke } from "@tauri-apps/api/core";
import { AUTH_CORE_URL } from "@/lib/core-url.ts";
import { LOCAL_FALLBACK, useNodeStore } from "@/src/store/useNodeStore.ts";

const TRAILING_SLASH = /\/$/;
const normalize = (url: string): string => url.replace(TRAILING_SLASH, "");

const CLOUD_NAME = "cloud";
const LOCAL_NUDGE_KEY = "ryu_webapp_local_nudge";

export type PreferLocalResult = "local" | "cloud" | "skipped";

/**
 * Webapp-only: after sign-in (or on return visits), prefer the local Core when
 * reachable; otherwise fall back to the hosted auth Core (`cloud`). Callers
 * surface the node-selector nudge via {@link shouldNudgeLocalMissing}.
 *
 * Desktop is a no-op — it already runs against the local sidecar.
 */
export async function preferLocalOrCloud(): Promise<PreferLocalResult> {
	if (import.meta.env.VITE_RYU_SURFACE !== "webapp") {
		return "skipped";
	}

	const authUrl = normalize(AUTH_CORE_URL);
	const localUrl = normalize(LOCAL_FALLBACK.url);

	let store = useNodeStore.getState();
	const hasLocal = store.nodes.some(
		(n) => normalize(n.url) === localUrl || n.name === LOCAL_FALLBACK.name
	);
	if (!hasLocal) {
		await store.addNode(LOCAL_FALLBACK.name, LOCAL_FALLBACK.url);
	}

	if (authUrl !== localUrl) {
		store = useNodeStore.getState();
		const hasCloud = store.nodes.some((n) => normalize(n.url) === authUrl);
		if (!hasCloud) {
			await store.addNode(CLOUD_NAME, AUTH_CORE_URL);
		}
	}

	store = useNodeStore.getState();
	const localName =
		store.nodes.find((n) => normalize(n.url) === localUrl)?.name ??
		LOCAL_FALLBACK.name;

	const { online } = await invoke<{ online: boolean }>("test_node", {
		name: localName,
	}).catch(() => ({ online: false }));

	if (online) {
		await store.setDefault(localName);
		await store.refresh();
		return "local";
	}

	store = useNodeStore.getState();
	const cloudName =
		store.nodes.find((n) => normalize(n.url) === authUrl)?.name ?? CLOUD_NAME;
	if (authUrl !== localUrl) {
		await store.setDefault(cloudName);
		await store.refresh();
	}

	return "cloud";
}

/** True when we should surface the "no local node" prompt (once per tab session). */
export function shouldNudgeLocalMissing(): boolean {
	try {
		return sessionStorage.getItem(LOCAL_NUDGE_KEY) !== "shown";
	} catch {
		return true;
	}
}

export function markLocalNudgeShown(): void {
	try {
		sessionStorage.setItem(LOCAL_NUDGE_KEY, "shown");
	} catch {
		// ignore
	}
}
