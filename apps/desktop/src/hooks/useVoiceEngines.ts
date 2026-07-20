// apps/desktop/src/hooks/useVoiceEngines.ts
//
// Backs the Store's "run-alongside" engine sections (Speech, Image, Embeddings).
// These engines — the catalog's `voice` (STT/TTS), `media` (image/video), and
// `embedding` categories — all run *alongside* the resident chat engine (unlike
// the mutually-exclusive `provider` chat engines, which swap). So instead of an
// active-swap, each has its own running state toggled via the generic sidecar
// start/stop endpoints. Pass the categories to include (defaults to `["voice"]`).
//
// This hook unifies two Core views into one per-engine row:
//   - install state, from the catalog (`/api/catalog`), so not-installed engines
//     still appear (their toggle is disabled);
//   - running state, from `/api/sidecar/status`, so the page can start/stop each.

import { useCallback, useEffect, useState } from "react";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import {
	type CatalogItem,
	fetchCatalog,
	fetchSidecarStatus,
	installSidecar,
	startSidecar,
	stopSidecar,
	uninstallSidecar,
} from "@/src/lib/services-api.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** A run-alongside engine plus its install + running state for one row. */
export interface VoiceEngineEntry {
	/** Catalog category — `voice` | `media` | `embedding` — used to group rows. */
	category: string;
	/** Catalog says this engine is superseded — never offer an update to it. */
	deprecated: boolean;
	description: string;
	displayName: string;
	installedVersion: string | null;
	installState: CatalogItem["installState"];
	/** Newest version the registry knows about; drives the "Update" affordance. */
	latestVersion: string | null;
	name: string;
	/** True when this engine's sidecar process is currently running. */
	running: boolean;
}

/** Catalog categories whose engines run alongside the chat engine (start/stop). */
const DEFAULT_RUN_ALONGSIDE_CATEGORIES = ["voice"] as const;

export interface UseVoiceEnginesResult {
	engines: VoiceEngineEntry[];
	error: string | null;
	install: (name: string) => Promise<void>;
	loading: boolean;
	reload: () => Promise<void>;
	/** Start or stop the engine's sidecar process. */
	setRunning: (name: string, running: boolean) => Promise<void>;
	uninstall: (name: string) => Promise<void>;
}

export function useVoiceEngines(
	categories: readonly string[] = DEFAULT_RUN_ALONGSIDE_CATEGORIES
): UseVoiceEnginesResult {
	const activeNode = useActiveNode();
	const url = activeNode.url;
	const token = activeNode.token ?? null;
	// Stable key so the reload callback only changes when the set actually changes.
	const categoryKey = categories.join(",");

	const [engines, setEngines] = useState<VoiceEngineEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [catalog, status] = await Promise.all([
				fetchCatalog(url, token),
				fetchSidecarStatus(url, token).catch(
					() => ({}) as Record<string, boolean>
				),
			]);
			const wanted = new Set(categoryKey.split(","));
			const runAlongside = catalog.filter((item) => wanted.has(item.category));
			setEngines(
				runAlongside.map((item) => ({
					name: item.name,
					displayName: item.displayName,
					description: item.description,
					category: item.category,
					installState: item.installState,
					installedVersion: item.installedVersion,
					latestVersion: item.latestVersion,
					deprecated: item.deprecated,
					running: status[item.name] ?? false,
				}))
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load engines");
		} finally {
			setLoading(false);
		}
	}, [url, token, categoryKey]);

	useEffect(() => {
		reload().catch(() => undefined);
	}, [reload]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(reload);

	const install = useCallback(
		async (name: string) => {
			await installSidecar(url, token, name);
			await reload();
		},
		[url, token, reload]
	);

	const uninstall = useCallback(
		async (name: string) => {
			await uninstallSidecar(url, token, name);
			await reload();
		},
		[url, token, reload]
	);

	const setRunning = useCallback(
		async (name: string, running: boolean) => {
			if (running) {
				await startSidecar(url, token, name);
			} else {
				await stopSidecar(url, token, name);
			}
			await reload();
		},
		[url, token, reload]
	);

	return { engines, loading, error, reload, install, uninstall, setRunning };
}
