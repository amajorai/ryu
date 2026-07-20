// apps/desktop/src/hooks/useEngines.ts
//
// Backs the Engines page (DA4). A "local engine" is a swappable inference
// runtime (llama.cpp / Ollama / vLLM) — exactly the catalog's `provider`
// category. This hook unifies two Core views into one per-engine row:
//   - install state, from the catalog (`/api/catalog`), so not-installed engines
//     still appear (their switch is disabled);
//   - the active/resident engine, from `/api/engine/active`, so the page can show
//     and swap which engine Core currently binds local agents to.
//
// Install/uninstall and the active swap run on Core asynchronously; after each
// mutation we reload so the row reflects live status.

import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type ActiveEngine,
	setActiveEngine as apiSetActiveEngine,
	type EngineSwap,
	fetchActiveEngine,
} from "@/src/lib/api/engines.ts";
import { useCoreRefresh } from "@/src/lib/core-refresh.ts";
import {
	type CatalogItem,
	fetchCatalog,
	installSidecar,
	uninstallSidecar,
} from "@/src/lib/services-api.ts";
import { useActiveNode } from "./useActiveNode.ts";

/** A local inference engine plus its install + active state for one row. */
export interface EngineEntry {
	/** True when this engine is the resident/active local engine. */
	active: boolean;
	/** Catalog says this engine is superseded — never offer an update to it. */
	deprecated: boolean;
	description: string;
	displayName: string;
	installedVersion: string | null;
	installState: CatalogItem["installState"];
	/** Newest version the registry knows about; drives the "Update" affordance. */
	latestVersion: string | null;
	name: string;
	/** OS families this engine runs on (e.g. ["macos"]). Empty = every platform. */
	platforms: string[];
	/** Whether the Core node can run this engine (false → disable install/swap). */
	supported: boolean;
}

export interface UseEnginesResult {
	/** Swap the resident engine; resolves with the swap result (gatewayRefreshed). */
	activate: (name: string) => Promise<EngineSwap>;
	/** The resident engine + whether its process is live (null until first load). */
	activeEngine: ActiveEngine | null;
	engines: EngineEntry[];
	error: string | null;
	install: (name: string) => Promise<void>;
	loading: boolean;
	reload: () => Promise<void>;
	uninstall: (name: string) => Promise<void>;
}

export function useEngines(): UseEnginesResult {
	const activeNode = useActiveNode();
	// Derive primitives, not an object: an object literal is a fresh identity every
	// render, so depending on it would make `reload` (and the effect that calls it)
	// re-run on every render — an infinite refetch loop that flickers the list.
	const url = activeNode.url;
	const token = activeNode.token ?? null;

	const [engines, setEngines] = useState<EngineEntry[]>([]);
	const [activeEngine, setActiveEngine] = useState<ActiveEngine | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const target: ApiTarget = { url, token };
			const [catalog, active] = await Promise.all([
				fetchCatalog(url, token),
				fetchActiveEngine(target).catch(() => null),
			]);
			// The swappable local engines are exactly the catalog's providers.
			const providers = catalog.filter((item) => item.category === "provider");
			const activeName = active?.active ?? null;
			setEngines(
				providers.map((item) => ({
					name: item.name,
					displayName: item.displayName,
					description: item.description,
					installState: item.installState,
					installedVersion: item.installedVersion,
					latestVersion: item.latestVersion,
					deprecated: item.deprecated,
					active: item.name === activeName,
					platforms: item.platforms,
					supported: item.supported,
				}))
			);
			setActiveEngine(active);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load engines");
		} finally {
			setLoading(false);
		}
	}, [url, token]);

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

	const activate = useCallback(
		async (name: string) => {
			const swap = await apiSetActiveEngine({ url, token }, name);
			await reload();
			return swap;
		},
		[url, token, reload]
	);

	return {
		engines,
		activeEngine,
		loading,
		error,
		reload,
		install,
		uninstall,
		activate,
	};
}
