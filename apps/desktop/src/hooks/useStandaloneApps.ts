import type { StandaloneAppInstallation } from "@ryu/app-host/standalone";
import {
	parseStandaloneAppRegistry,
	removeStandaloneAppInstallation,
	serializeStandaloneAppRegistry,
	upsertStandaloneAppInstallation,
} from "@ryu/app-host/standalone";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import {
	closeCurrentWindow,
	openStandaloneAppWindow,
} from "@/lib/tauri-bridge.ts";
import { translatedAppName } from "@/src/pages/hosted-standalone-window-title.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** Local host state, intentionally not Core app data or a second lifecycle row. */
const STORAGE_PREFIX = "ryu:standalone-apps:v1:";
const CHANGE_EVENT = "ryu:standalone-apps-changed";

export interface StandaloneAppTarget {
	appId: string;
	name: string;
	version: string;
}

function storageKey(nodeUrl: string): string {
	return `${STORAGE_PREFIX}${nodeUrl}`;
}

function readRegistry(key: string): StandaloneAppInstallation[] {
	try {
		return parseStandaloneAppRegistry(localStorage.getItem(key));
	} catch {
		return [];
	}
}

function writeRegistry(
	key: string,
	apps: readonly StandaloneAppInstallation[]
): void {
	try {
		localStorage.setItem(key, serializeStandaloneAppRegistry(apps));
		window.dispatchEvent(new Event(CHANGE_EVENT));
	} catch {
		throw new Error("Standalone app settings could not be saved.");
	}
}

function validAppId(appId: string): boolean {
	return (
		appId.length > 0 &&
		appId.length <= 200 &&
		/^[a-zA-Z0-9@._/-]+$/.test(appId) &&
		!appId.startsWith("/") &&
		!appId.endsWith("/") &&
		!appId.includes("//") &&
		appId.split("/").every((segment) => segment !== "." && segment !== "..")
	);
}

/**
 * Persist and launch app-first Desktop windows without touching app lifecycle.
 * Each window still resolves its Companion through the ordinary plugin bridge,
 * so the hosted and standalone views read/write the same node-owned data.
 */
export function useStandaloneApps() {
	const node = useActiveNode();
	const queryClient = useQueryClient();
	const key = useMemo(() => storageKey(node.url), [node.url]);
	const queryKey = useMemo(
		() => ["standalone-apps", node.url] as const,
		[node.url]
	);
	const query = useQuery({
		queryKey,
		queryFn: () => readRegistry(key),
		staleTime: Number.POSITIVE_INFINITY,
	});

	const sync = useCallback(() => {
		queryClient.invalidateQueries({ queryKey });
	}, [queryClient, queryKey]);

	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (event.key === key) {
				sync();
			}
		};
		window.addEventListener("storage", onStorage);
		window.addEventListener(CHANGE_EVENT, sync);
		return () => {
			window.removeEventListener("storage", onStorage);
			window.removeEventListener(CHANGE_EVENT, sync);
		};
	}, [key, sync]);

	const update = useCallback(
		(
			transform: (
				apps: StandaloneAppInstallation[]
			) => StandaloneAppInstallation[]
		) => {
			const next = transform(readRegistry(key));
			writeRegistry(key, next);
			queryClient.setQueryData(queryKey, next);
		},
		[key, queryClient, queryKey]
	);

	const install = useCallback(
		(target: StandaloneAppTarget) => {
			if (!validAppId(target.appId)) {
				return Promise.reject(
					new Error("This app cannot be opened standalone.")
				);
			}
			update((apps) =>
				upsertStandaloneAppInstallation(apps, {
					appId: target.appId,
					installedAt: new Date().toISOString(),
					version: target.version || "unknown",
				})
			);
			return Promise.resolve();
		},
		[update]
	);

	const uninstall = useCallback(
		(appId: string) => {
			if (!validAppId(appId)) {
				return Promise.resolve();
			}
			update((apps) => removeStandaloneAppInstallation(apps, appId));
			return Promise.resolve();
		},
		[update]
	);

	const tl = useLiteralMessages();
	const open = useCallback(
		(target: StandaloneAppTarget) => {
			if (!validAppId(target.appId)) {
				return Promise.reject(
					new Error("This app cannot be opened standalone.")
				);
			}
			// Localize the first frame; brand names are not catalog keys.
			return openStandaloneAppWindow({
				appId: target.appId,
				title: translatedAppName(tl, target.name),
			});
		},
		[tl]
	);

	const installedAppIds = useMemo(
		() => new Set((query.data ?? []).map((app) => app.appId)),
		[query.data]
	);

	const closeStandaloneWindow = useCallback(() => closeCurrentWindow(), []);

	return {
		closeStandaloneWindow,
		error: query.error instanceof Error ? query.error.message : null,
		install,
		installedAppIds,
		isInstalled: (appId: string) => installedAppIds.has(appId),
		loading: query.isLoading,
		open,
		reload: query.refetch,
		uninstall,
	};
}
