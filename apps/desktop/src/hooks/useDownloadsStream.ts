// apps/desktop/src/hooks/useDownloadsStream.ts
//
// Mounts one app-wide subscription to Core's download SSE stream and pipes
// snapshots + deltas into the downloads store. Follows the active node and
// re-subscribes when it changes, and auto-reconnects if the stream drops (Core
// restart, transient network). This is a side-effect-only hook — mount it once
// near the app shell (Layout) alongside the other headless watchers.

import { useEffect } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import { streamDownloads } from "@/src/lib/api/downloads.ts";
import { useDownloadsStore } from "@/src/store/useDownloadsStore.ts";
import { useInstallStore } from "@/src/store/useInstallStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export function useDownloadsStream(): void {
	// The global overlay tracks the active (default) node; switching the default
	// node re-runs this effect via the url/token/user JWT deps below.
	const node = useNodeStore((s) => s.getActiveNode());
	const url = node.url;
	const token = node.token;
	// A managed node may have no node token and authenticate with the user's
	// delegation JWT instead; dropping it 401s the stream into endless reconnects.
	const userJwt = node.userJwt;
	const applySnapshot = useDownloadsStore((s) => s.applySnapshot);
	const applyUpdate = useDownloadsStore((s) => s.applyUpdate);
	const removeTask = useDownloadsStore((s) => s.removeTask);
	const reset = useDownloadsStore((s) => s.reset);

	useEffect(() => {
		const controller = new AbortController();
		const target = toTarget({ url, token, userJwt });

		// Drop the mirror from any previous node; the snapshot event refills it.
		reset();
		// The in-flight install flags are node-scoped too — an add running on the
		// node we just left has no way to report back here, so its id would spin
		// forever on a node where nothing is happening.
		useInstallStore.getState().reset();

		// The shared event multiplexer owns reconnect/backoff for this channel.
		streamDownloads(
			target,
			(event) => {
				if (event.type === "snapshot") {
					applySnapshot(event.tasks);
				} else if (event.type === "update") {
					applyUpdate(event.task);
				} else if (event.type === "removed") {
					removeTask(event.id);
				}
			},
			controller.signal
		).catch(() => undefined);

		return () => {
			controller.abort();
		};
	}, [url, token, userJwt, applySnapshot, applyUpdate, removeTask, reset]);
}
