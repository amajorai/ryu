import { useEffect } from "react";
import { initAnalytics } from "@/src/lib/analytics.ts";
import { initCrashReporting } from "@/src/lib/crash.ts";
import { startSettingsSync } from "@/src/lib/settings-sync/engine.ts";
import { reloadWhenSettingsOwnerChanges } from "@/src/lib/settings-sync/owner-reload.ts";
import { useNodeStore } from "../store/useNodeStore.ts";

/** Starts the main window's boot services (analytics and crash tiers, settings
 *  sync, the node store) and reports when the node store has loaded. */
export function useBootServices(setNodesReady: (ready: boolean) => void): void {
	const initNodes = useNodeStore((s) => s.init);

	useEffect(() => {
		// Initialize product analytics once. Gated: a no-op unless a PostHog key is
		// configured AND the opt-out (seeded synchronously from the localStorage
		// mirror of `product-analytics-enabled`) is on. The Privacy tab seeds the
		// live gate from Core's canonical pref when opened.
		initAnalytics();
		// Initialize the crash reporting tier (SEPARATE consent from analytics).
		// Gated: a no-op unless a Sentry DSN is configured AND the opt-out (seeded
		// from the localStorage mirror of `crash-reports-enabled`) is on. The
		// Privacy tab seeds the live gate from Core's canonical pref when opened.
		initCrashReporting();
		// Settings sync. Starts the local-change observer unconditionally (so
		// per-key timestamps stay accurate for the moment sync is switched on) and
		// only uploads when the user has opted in. A window whose features loaded
		// another account's settings reloads once the account changes (this
		// window's switch or another window's), before any of them can write.
		const stopOwnerReload = reloadWhenSettingsOwnerChanges();
		const stopSettingsSync = startSettingsSync();
		let active = true;
		let unlisten: (() => void) | undefined;
		// The gate inside the store makes a too-early `list_nodes` wait for Tauri's
		// bridge, so this no longer rejects on a slow cold start. It can still fail
		// for a real reason (a broken node file), and an uncaught rejection here is
		// what surfaced as "Object.refresh(src/store/useNodeStore)" in production —
		// so the chain terminates in a catch rather than in the window.
		initNodes()
			.then((fn) => {
				if (!active) {
					fn();
					return;
				}
				unlisten = fn;
				setNodesReady(true);
			})
			.catch((error) => {
				console.error("node store init failed", error);
				if (active) {
					setNodesReady(true);
				}
			});
		return () => {
			active = false;
			unlisten?.();
			stopSettingsSync();
			stopOwnerReload();
		};
	}, [initNodes]);
}
