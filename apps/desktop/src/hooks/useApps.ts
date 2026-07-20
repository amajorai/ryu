// apps/desktop/src/hooks/useApps.ts
//
// React hook for the Extensions page: loads all Plugins from Core's /api/plugins
// and exposes enable/disable lifecycle actions. Toggle actions update local
// state immediately (optimistic) then confirm with the server response so the
// UI reflects changes without a full refetch.

import { toast } from "@ryu/ui/components/sileo";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AppInfo,
	type AppRecord,
	type AppToggleResult,
	disableApp as apiDisableApp,
	enableApp as apiEnableApp,
	installApp as apiInstallApp,
	uninstallApp as apiUninstallApp,
	type DependencyError,
	describeDependencyError,
	fetchApps,
} from "@/src/lib/api/plugins.ts";
import {
	triggerGlobalRefresh,
	useCoreRefresh,
} from "@/src/lib/core-refresh.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseAppsResult {
	apps: AppInfo[];
	clearToggleError: () => void;
	error: string | null;
	/** Record the app as installed (transitions to disabled state). Updates local state immediately. */
	install: (id: string) => Promise<AppRecord>;
	loading: boolean;
	reload: () => Promise<void>;
	toggle: (id: string, enable: boolean) => Promise<void>;
	toggleError: string | null;
	/** Uninstall an installed plugin (disable + remove its record). A 409 refusal
	 *  (built-in, or enabled dependents) surfaces through `toggleError` in the SAME
	 *  banner the disable-refusal uses. Pass `{ cascade: true }` to also disable the
	 *  dependent chain. Refreshes the list on success. */
	uninstall: (id: string, options?: { cascade?: boolean }) => Promise<void>;
}

/** Surface Core's "the toggle did not reach the gateway" notice (a gateway-policy
 *  plugin toggled against a remote/unmanaged gateway) rather than implying the
 *  gateway was reconfigured. No-op on an ordinary toggle (no notice attached). */
function surfaceExternallyManaged(result: {
	externallyManaged?: boolean;
	notice?: string;
}) {
	if (result.externallyManaged && result.notice) {
		toast.warning({
			title: "Gateway not reconfigured",
			description: result.notice,
		});
	}
}

/** Recover the typed {@link DependencyError} the lifecycle client attaches to a
 *  rejected enable/disable (`Object.assign(new Error(msg), { dependencyError })`).
 *  Returns null for every other failure. */
function dependencyErrorOf(e: unknown): DependencyError | null {
	if (!(e instanceof Error)) {
		return null;
	}
	const candidate = (e as Error & { dependencyError?: unknown })
		.dependencyError;
	if (typeof candidate !== "object" || candidate === null) {
		return null;
	}
	return typeof (candidate as { code?: unknown }).code === "string"
		? (candidate as DependencyError)
		: null;
}

/** Load all Apps and expose enable/disable toggle with optimistic update. */
export function useApps(): UseAppsResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url, token } = target;

	const [apps, setApps] = useState<AppInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [toggleError, setToggleError] = useState<string | null>(null);

	// Latest app list, readable from `toggle`'s catch without making `apps` a
	// dependency of the callback (which would re-create it on every list update).
	// Used only to turn dependency-error plugin IDS into display NAMES.
	const appsRef = useRef<AppInfo[]>([]);
	useEffect(() => {
		appsRef.current = apps;
	}, [apps]);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		const node: ApiTarget = { url, token };
		try {
			const list = await fetchApps(node);
			setApps(list);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load extensions");
		} finally {
			setLoading(false);
		}
	}, [url, token]);

	useEffect(() => {
		reload().catch(() => undefined);
	}, [reload]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(reload);

	const toggle = useCallback(
		async (id: string, enable: boolean) => {
			setToggleError(null);

			// Optimistic update: flip enabled locally so the toggle feels instant.
			setApps((prev) =>
				prev.map((a) => (a.id === id ? { ...a, enabled: enable } : a))
			);

			const node: ApiTarget = { url, token };
			try {
				const record: AppToggleResult = enable
					? await apiEnableApp(node, id)
					: await apiDisableApp(node, id);

				// Confirm with the server's authoritative enabled state.
				setApps((prev) =>
					prev.map((a) => (a.id === id ? { ...a, enabled: record.enabled } : a))
				);

				// If a gateway-policy plugin was toggled against an unmanaged gateway,
				// the record flipped but the gateway was NOT reconfigured — say so.
				surfaceExternallyManaged(record);

				// A plugin's enabled state drives its contributions (composer controls,
				// settings tabs, slash commands). Fan out a global refresh so every
				// surface re-reads without a reload: invalidates the composer's
				// `["plugin-contributions"]` query and dispatches CORE_REFRESH_EVENT for
				// the manual-reload hooks (usePluginSettingsTabs, this list itself).
				triggerGlobalRefresh();
			} catch (e) {
				// Roll back the optimistic update on failure.
				setApps((prev) =>
					prev.map((a) => (a.id === id ? { ...a, enabled: !enable } : a))
				);

				// A dependency refusal (409) is not a generic failure — Core names the
				// exact plugins involved. Re-render the typed error with DISPLAY NAMES
				// (only this hook holds the id → name map) so the user reads
				// "Meetings is needed by Whiteboard, Canvas. Disable Whiteboard, Canvas
				// first." instead of id soup or "Failed to disable extension".
				const depError = dependencyErrorOf(e);
				if (depError) {
					const nameOf = (pluginId: string) =>
						appsRef.current.find((a) => a.id === pluginId)?.name ?? pluginId;
					setToggleError(describeDependencyError(depError, nameOf));
					return;
				}

				setToggleError(
					e instanceof Error
						? e.message
						: `Failed to ${enable ? "enable" : "disable"} extension`
				);
			}
		},
		[url, token]
	);

	const uninstall = useCallback(
		async (id: string, options?: { cascade?: boolean }) => {
			setToggleError(null);
			const node: ApiTarget = { url, token };
			try {
				const result = await apiUninstallApp(node, id, options);
				surfaceExternallyManaged(result);
				// Refresh from the authoritative list (the record is gone; any
				// cascaded dependents come back installed-but-disabled).
				await reload();
				// A plugin's presence drives contributions across every surface.
				triggerGlobalRefresh();
			} catch (e) {
				// A 409 refusal (built-in, or enabled dependents) is not a generic
				// failure. Re-render a dependency refusal with DISPLAY NAMES; every
				// other refusal (e.g. a built-in that can only be disabled) keeps the
				// backend's own message. Same `toggleError` banner as disable.
				const depError = dependencyErrorOf(e);
				if (depError) {
					const nameOf = (pluginId: string) =>
						appsRef.current.find((a) => a.id === pluginId)?.name ?? pluginId;
					setToggleError(describeDependencyError(depError, nameOf));
					return;
				}
				setToggleError(
					e instanceof Error ? e.message : "Failed to uninstall extension"
				);
			}
		},
		[url, token, reload]
	);

	const clearToggleError = useCallback(() => setToggleError(null), []);

	const install = useCallback(
		async (id: string) => {
			const node: ApiTarget = { url, token };
			const record = await apiInstallApp(node, id);
			// Mark app as installed (disabled) in local state.
			setApps((prev) =>
				prev.map((a) =>
					a.id === id
						? { ...a, installed: true, installedVersion: record.version }
						: a
				)
			);
			return record;
		},
		[url, token]
	);

	return {
		apps,
		loading,
		error,
		install,
		reload,
		toggle,
		toggleError,
		clearToggleError,
		uninstall,
	};
}
