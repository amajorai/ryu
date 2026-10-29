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

import { useQueryClient } from "@tanstack/react-query";
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
	restartSidecar,
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
	/** True when this engine's process is currently the live resident server. */
	running: boolean;
	/** Whether the Core node can run this engine (false → disable install/swap). */
	supported: boolean;
	/** Core's reason the node can't run it; null when supported / older Core. */
	unsupportedReason: string | null;
	/** The node's verdict that a reinstall would deliver a newer build. */
	updateAvailable: boolean;
}

export interface UseEnginesResult {
	/** Swap the resident engine; resolves with the swap result (gatewayRefreshed). */
	activate: (name: string) => Promise<EngineSwap>;
	/** The resident engine + whether its process is live (null until first load). */
	activeEngine: ActiveEngine | null;
	engines: EngineEntry[];
	error: string | null;
	install: (name: string, force?: boolean) => Promise<void>;
	loading: boolean;
	reload: () => Promise<void>;
	restart: (name: string) => Promise<void>;
	uninstall: (name: string) => Promise<void>;
}

export function useEngines(): UseEnginesResult {
	const activeNode = useActiveNode();
	const queryClient = useQueryClient();
	// Derive primitives, not an object: an object literal is a fresh identity every
	// render, so depending on it would make `reload` (and the effect that calls it)
	// re-run on every render — an infinite refetch loop that flickers the list.
	const url = activeNode.url;
	const token = activeNode.token ?? null;
	const userJwt = activeNode.userJwt ?? null;

	const [engines, setEngines] = useState<EngineEntry[]>([]);
	const [activeEngine, setActiveEngine] = useState<ActiveEngine | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const target: ApiTarget = { url, token, userJwt };
			const [catalog, active] = await Promise.all([
				fetchCatalog(url, token, undefined, userJwt),
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
					running: item.name === activeName && active?.running === true,
					platforms: item.platforms,
					supported: item.supported,
					unsupportedReason: item.unsupportedReason,
					updateAvailable: item.updateAvailable,
				}))
			);
			setActiveEngine(active);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load engines");
		} finally {
			setLoading(false);
		}
	}, [url, token, userJwt]);

	useEffect(() => {
		reload().catch(() => undefined);
	}, [reload]);

	// Auto-recover when Core reconnects or the user hits "Refresh all".
	useCoreRefresh(reload);

	// `force` turns an install into an UPDATE: Core's installers are idempotent by
	// design, so without it a press on an already-installed engine returns success
	// having re-downloaded nothing.
	const install = useCallback(
		async (name: string, force = false) => {
			await installSidecar(url, token, name, force, undefined, userJwt);
			await reload();
		},
		[url, token, userJwt, reload]
	);

	const uninstall = useCallback(
		async (name: string) => {
			await uninstallSidecar(url, token, name, userJwt);
			await reload();
		},
		[url, token, userJwt, reload]
	);

	const activate = useCallback(
		async (name: string) => {
			const swap = await apiSetActiveEngine({ url, token, userJwt }, name);
			await reload();
			await queryClient.invalidateQueries({ queryKey: ["engine-models", url] });
			return swap;
		},
		[url, token, userJwt, reload, queryClient]
	);

	const restart = useCallback(
		async (name: string) => {
			await restartSidecar(url, token, name, userJwt);
			await reload();
		},
		[url, token, userJwt, reload]
	);

	return {
		engines,
		activeEngine,
		loading,
		error,
		reload,
		restart,
		install,
		uninstall,
		activate,
	};
}
