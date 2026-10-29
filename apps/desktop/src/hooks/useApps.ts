// apps/desktop/src/hooks/useApps.ts
//
// React hook for the Extensions page: loads all Plugins from Core's /api/plugins
// and exposes enable/disable lifecycle actions. Toggle actions update local
// state immediately (optimistic) then confirm with the server response so the
// UI reflects changes without a full refetch.

import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AppInfo,
	type AppRecord,
	type AppToggleResult,
	disableApp as apiDisableApp,
	enableApp as apiEnableApp,
	installApp as apiInstallApp,
	uninstallApp as apiUninstallApp,
	describeDependencyError,
	fetchApps,
} from "@/src/lib/api/plugins.ts";
import { triggerGlobalRefresh } from "@/src/lib/core-refresh.ts";
import { dependencyErrorOf } from "@/src/lib/plugin-dependency-errors.ts";
import { queryClient } from "@/src/lib/query-client.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseAppsResult {
	apps: AppInfo[];
	clearToggleError: () => void;
	error: string | null;
	/** Record the app as installed (transitions to disabled state). Updates local state immediately. */
	install: (id: string) => Promise<AppRecord>;
	loading: boolean;
	reload: () => Promise<void>;
	toggle: (id: string, enable: boolean) => Promise<AppToggleOutcome>;
	toggleError: string | null;
	/** Uninstall an installed plugin (disable + remove its record). A 409 refusal
	 *  (built-in, or enabled dependents) surfaces through `toggleError` in the SAME
	 *  banner the disable-refusal uses. Pass `{ cascade: true }` to also disable the
	 *  dependent chain, and `{ deleteStorage: true }` to also delete the app's
	 *  saved key-value data (its saved secrets are always removed). Refreshes the
	 *  list on success. */
	uninstall: (
		id: string,
		options?: { cascade?: boolean; deleteStorage?: boolean }
	) => Promise<void>;
}

export type AppToggleOutcome =
	| { success: true }
	| { error: string; success: false };

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

/** Core acknowledged a lifecycle request with another app's record. Nothing about
 *  the requested app is confirmed, so callers must not report success. */
class WrongAppCompletionError extends Error {
	constructor(acknowledgedId: string) {
		super(
			`Core confirmed a different app (${acknowledgedId}); the app list was reloaded.`
		);
		this.name = "WrongAppCompletionError";
	}
}

const EMPTY_APPS: AppInfo[] = [];
const APP_ROSTER_NOTIFY_PROPS: ("data" | "error" | "isPending")[] = [
	"data",
	"error",
	"isPending",
];

/** Load all Apps and expose enable/disable toggle with optimistic update. */
export function useApps(): UseAppsResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};
	const { url, token, userJwt } = target;

	const queryKey = useMemo(
		() => ["desktop-app-roster", url, token, userJwt],
		[url, token, userJwt]
	);
	const fetchRoster = useCallback(
		({ signal }: { signal: AbortSignal }) =>
			fetchApps({ url, token, userJwt }, { signal }),
		[url, token, userJwt]
	);
	const query = useQuery(
		{
			queryKey,
			queryFn: fetchRoster,
			// App consumers need the roster, initial pending state and terminal errors;
			// a background refetch's `isFetching` transition should not rebuild every
			// mounted app section when the records themselves are unchanged.
			notifyOnChangeProps: APP_ROSTER_NOTIFY_PROPS,
			staleTime: 30_000,
		},
		queryClient
	);
	const apps = query.data ?? EMPTY_APPS;
	const loading = query.isPending;
	const error = query.error?.message ?? null;
	const setApps = useCallback(
		(update: (apps: AppInfo[]) => AppInfo[]) => {
			queryClient.setQueryData<AppInfo[]>(queryKey, (current) =>
				update(current ?? EMPTY_APPS)
			);
		},
		[queryKey]
	);
	// Mutations keep updating their captured node's cache after navigation, but
	// their error banner belongs only to the authority that started them.
	const activeErrorScope = useRef(queryKey);
	activeErrorScope.current = queryKey;
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const [scopedToggleError, setScopedToggleError] = useState<{
		scope: typeof queryKey;
		message: string;
	} | null>(null);
	const setToggleError = useCallback(
		(message: string | null) => {
			if (activeErrorScope.current !== queryKey) {
				return;
			}
			setScopedToggleError(
				message === null ? null : { scope: queryKey, message }
			);
		},
		[queryKey]
	);
	const toggleError =
		scopedToggleError?.scope === queryKey ? scopedToggleError.message : null;

	const reload = useCallback(async () => {
		await queryClient.refetchQueries(
			{ queryKey, exact: true },
			{ cancelRefetch: false }
		);
	}, [queryKey]);

	const toggle = useCallback(
		async (id: string, enable: boolean) => {
			setToggleError(null);

			await queryClient.cancelQueries({ queryKey, exact: true });
			const previousEnabled = queryClient
				.getQueryData<AppInfo[]>(queryKey)
				?.find((app) => app.id === id)?.enabled;
			// Optimistic update: flip enabled locally so the toggle feels instant.
			setApps((prev) =>
				prev.map((a) => (a.id === id ? { ...a, enabled: enable } : a))
			);

			const node: ApiTarget = { url, token, userJwt };
			try {
				const record: AppToggleResult = enable
					? await apiEnableApp(node, id)
					: await apiDisableApp(node, id);
				if (record.id !== id) {
					throw new WrongAppCompletionError(record.id);
				}

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
				return { success: true } as const;
			} catch (e) {
				// Roll back the optimistic update on failure.
				setApps((prev) =>
					prev.map((a) =>
						a.id === id && previousEnabled !== undefined
							? { ...a, enabled: previousEnabled }
							: a
					)
				);

				// A completion for another app may still have changed this one: the
				// rollback above is provisional, Core's re-read roster is authoritative.
				if (e instanceof WrongAppCompletionError) {
					await reload();
					setToggleError(e.message);
					return { error: e.message, success: false } as const;
				}

				// A dependency refusal (409) is not a generic failure — Core names the
				// exact plugins involved. Re-render the typed error with DISPLAY NAMES
				// (only this hook holds the id → name map) so the user reads
				// "Meetings is needed by Whiteboard, Canvas. Disable Whiteboard, Canvas
				// first." instead of id soup or "Failed to disable extension".
				const depError = dependencyErrorOf(e);
				if (depError) {
					const nameOf = (pluginId: string) =>
						queryClient
							.getQueryData<AppInfo[]>(queryKey)
							?.find((a) => a.id === pluginId)?.name ?? pluginId;
					const message = describeDependencyError(depError, nameOf);
					setToggleError(message);
					return { error: message, success: false } as const;
				}

				const message =
					e instanceof Error
						? e.message
						: enable
							? tlRef.current("Failed to enable extension")
							: tlRef.current("Failed to disable extension");
				setToggleError(message);
				return { error: message, success: false } as const;
			}
		},
		[url, token, userJwt, setApps, queryKey, setToggleError, reload]
	);

	const uninstall = useCallback(
		async (
			id: string,
			options?: { cascade?: boolean; deleteStorage?: boolean }
		) => {
			setToggleError(null);
			const node: ApiTarget = { url, token, userJwt };
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
						queryClient
							.getQueryData<AppInfo[]>(queryKey)
							?.find((a) => a.id === pluginId)?.name ?? pluginId;
					setToggleError(describeDependencyError(depError, nameOf));
					return;
				}
				setToggleError(
					e instanceof Error ? e.message : "Failed to uninstall extension"
				);
			}
		},
		[url, token, userJwt, reload, queryKey, setToggleError]
	);

	const clearToggleError = useCallback(
		() => setToggleError(null),
		[setToggleError]
	);

	const install = useCallback(
		async (id: string) => {
			const node: ApiTarget = { url, token, userJwt };
			const record = await apiInstallApp(node, id);
			if (record.id !== id) {
				await reload();
				throw new WrongAppCompletionError(record.id);
			}
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
		[url, token, userJwt, setApps, queryKey, reload]
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
