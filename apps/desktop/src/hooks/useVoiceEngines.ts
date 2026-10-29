// apps/desktop/src/hooks/useVoiceEngines.ts
//
// Backs the Store's "run-alongside" engine sections (Voice Recognition, Image, Embeddings).
// These engines — the catalog's `voice` (Voice Recognition/Audio), `media` (image/video), and
// `embedding` categories — all run *alongside* resident Chat (unlike
// the mutually-exclusive `provider` Chat runtime, which swaps). So instead of an
// active-swap, each has its own running state toggled via the generic sidecar
// start/stop endpoints. Pass the categories to include (defaults to `["voice"]`).
//
// This hook unifies two Core views into one per-engine row:
//   - install state, from the catalog (`/api/catalog`), so not-installed engines
//     still appear (their toggle is disabled);
//   - running state, from `/api/sidecar/status`, so the page can start/stop each.

import { useCallback, useEffect, useRef, useState } from "react";
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
import {
	useVoiceAuthority,
	VoiceRequestRetiredError,
} from "./useVoiceAuthority.ts";

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
	/** OS families this engine runs on (e.g. ["windows"]). Empty = every platform. */
	platforms: string[];
	/** True when this engine's sidecar process is currently running. */
	running: boolean;
	/** False until this authority has a readable current runtime status. */
	runningKnown: boolean;
	/** Whether the Core node can run this engine on its OS + CPU arch (false →
	 *  disable install/start). Fit is the serving node's, never this client's. */
	supported: boolean;
	/** Core's reason the node can't run it; null when supported / older Core. */
	unsupportedReason: string | null;
	/** The node's verdict that a reinstall would deliver a newer build. */
	updateAvailable: boolean;
}

/** Catalog categories whose engines run alongside Chat (start/stop). */
const DEFAULT_RUN_ALONGSIDE_CATEGORIES = ["voice"] as const;

export interface UseVoiceEnginesResult {
	engines: VoiceEngineEntry[];
	error: string | null;
	install: (name: string, force?: boolean) => Promise<void>;
	loading: boolean;
	reload: () => Promise<void>;
	/** Start or stop the engine's sidecar process. */
	setRunning: (name: string, running: boolean) => Promise<void>;
	uninstall: (name: string) => Promise<void>;
}

export function useVoiceEngines(
	categories: readonly string[] = DEFAULT_RUN_ALONGSIDE_CATEGORIES
): UseVoiceEnginesResult {
	const categoryKey = categories.join(",");
	const { authority, isCurrent } = useVoiceAuthority(categoryKey);
	const { url } = authority.node;
	const token = authority.node.token ?? null;
	const userJwt = authority.node.userJwt ?? null;
	const [view, setView] = useState<{
		authority: typeof authority;
		engines: VoiceEngineEntry[];
		loading: boolean;
		error: string | null;
	}>({ authority, engines: [], loading: true, error: null });
	const viewRef = useRef(view);
	const publish = (next: typeof view) => {
		viewRef.current = next;
		setView(next);
	};
	const reads = useRef(0);
	const readPending = useRef<{ authority: typeof authority; pending: boolean }>(
		{ authority, pending: true }
	);
	const writes = useRef<object | null>(null);

	const reload = useCallback(async () => {
		if (!isCurrent()) {
			return;
		}
		const sequence = ++reads.current;
		readPending.current = { authority, pending: true };
		const live = () => isCurrent() && sequence === reads.current;
		const old = viewRef.current;
		publish({
			authority,
			engines:
				old.authority === authority
					? old.engines.map((e) => ({ ...e, runningKnown: false }))
					: [],
			loading: true,
			error: null,
		});
		const [catalogResult, statusResult] = await Promise.allSettled([
			fetchCatalog(url, token, undefined, userJwt),
			fetchSidecarStatus(url, token, userJwt),
		]);
		if (!live()) {
			return;
		}
		readPending.current = { authority, pending: false };
		const previous =
			viewRef.current.authority === authority ? viewRef.current.engines : [];
		if (catalogResult.status === "rejected") {
			publish({
				authority,
				engines: previous.map((e) => ({ ...e, runningKnown: false })),
				loading: false,
				error: "Couldn’t load the runtime catalog. Retry to confirm its state.",
			});
			return;
		}
		const known = statusResult.status === "fulfilled";
		const wanted = new Set(categoryKey.split(","));
		const engines = catalogResult.value
			.filter((item) => wanted.has(item.category))
			.map((item) => ({
				name: item.name,
				displayName: item.displayName,
				description: item.description,
				category: item.category,
				installState: item.installState,
				installedVersion: item.installedVersion,
				latestVersion: item.latestVersion,
				deprecated: item.deprecated,
				platforms: item.platforms,
				supported: item.supported,
				unsupportedReason: item.unsupportedReason,
				updateAvailable: item.updateAvailable,
				running: known
					? (statusResult.value[item.name] ?? false)
					: (previous.find((e) => e.name === item.name)?.running ?? false),
				runningKnown: known,
			}));
		publish({
			authority,
			engines,
			loading: false,
			error: known
				? null
				: "Couldn’t load the runtime status. Status is unknown; retry to confirm it.",
		});
	}, [authority, url, token, userJwt, categoryKey]);

	useEffect(() => {
		void reload();
	}, [reload]);
	useCoreRefresh(reload);

	const mutate = useCallback(
		async (action: () => Promise<unknown>, needsStatus: boolean) => {
			if (!isCurrent()) {
				throw new VoiceRequestRetiredError();
			}
			if (writes.current !== null) {
				throw new Error("An audio runtime change is already pending.");
			}
			const currentView = viewRef.current;
			if (
				needsStatus &&
				(readPending.current.authority !== authority ||
					readPending.current.pending ||
					currentView.authority !== authority ||
					currentView.loading ||
					currentView.engines.some((e) => !e.runningKnown))
			) {
				throw new Error("Runtime status is unknown. Retry before changing it.");
			}
			const ticket = {};
			writes.current = ticket;
			try {
				await action();
				if (!isCurrent()) {
					throw new VoiceRequestRetiredError();
				}
				// The accepted write invalidates runtime status before its follow-up read.
				const old = viewRef.current;
				if (old.authority === authority) {
					publish({
						...old,
						engines: old.engines.map((e) => ({ ...e, runningKnown: false })),
					});
				}
				await reload();
				if (!isCurrent()) {
					throw new VoiceRequestRetiredError();
				}
			} finally {
				if (writes.current === ticket) {
					writes.current = null;
				}
			}
		},
		[authority, reload]
	);
	useEffect(() => {
		writes.current = null;
	}, [authority]);
	const install = useCallback(
		(name: string, force = false) =>
			mutate(
				() => installSidecar(url, token, name, force, undefined, userJwt),
				true
			),
		[url, token, userJwt, mutate]
	);
	const uninstall = useCallback(
		(name: string) =>
			mutate(() => uninstallSidecar(url, token, name, userJwt), true),
		[url, token, userJwt, mutate]
	);
	const setRunning = useCallback(
		(name: string, running: boolean) =>
			mutate(
				() =>
					running
						? startSidecar(url, token, name, userJwt)
						: stopSidecar(url, token, name, userJwt),
				true
			),
		[url, token, userJwt, mutate]
	);
	const visible =
		view.authority === authority
			? view
			: { engines: [], loading: true, error: null };
	return { ...visible, reload, install, uninstall, setRunning };
}
