// Renderer hook: the enabled plugins' companion contributions.
//
// Mirrors the desktop `usePluginContributions`, but island fetches over IPC (the
// renderer cannot reach Core directly — CORS) and has no react-query, so it uses a
// plain `useState`/`useEffect` read. Best-effort: a missing/old Core or an
// unreachable node simply leaves `companions` empty, so the companion tab-strip is
// absent and the chat surface is unchanged.

import { useEffect, useState } from "react";
import type { PluginCompanion, PluginView } from "../../shared/ipc.ts";

export interface PluginContributions {
	companions: PluginCompanion[];
	views: PluginView[];
}

/** Stable empty payload so an unreachable Core yields an identical reference. */
const EMPTY: PluginContributions = { companions: [], views: [] };

export function usePluginContributions(): PluginContributions {
	const [contributions, setContributions] =
		useState<PluginContributions>(EMPTY);

	useEffect(() => {
		let cancelled = false;
		let request = 0;
		const reload = () => {
			const current = ++request;
			setContributions(EMPTY);
			window.island.plugins
				.contributions()
				.then((result) => {
					if (cancelled || current !== request || !result.available) {
						return;
					}
					setContributions({
						companions: result.companions,
						views: result.views,
					});
				})
				.catch(() => {
					// Best-effort surface: keep the stable empty payload on any failure.
				});
		};
		reload();
		const unsubscribe = window.island.plugins.onSourceChanged(reload);
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	return contributions;
}
