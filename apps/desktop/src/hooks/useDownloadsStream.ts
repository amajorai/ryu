// apps/desktop/src/hooks/useDownloadsStream.ts
//
// Mounts one app-wide subscription to Core's download SSE stream and pipes
// snapshots + deltas into the downloads store. Follows the active node and
// re-subscribes when it changes, and auto-reconnects if the stream drops (Core
// restart, transient network). This is a side-effect-only hook — mount it once
// near the app shell (Layout) alongside the other headless watchers.

import { useEffect } from "react";
import { streamDownloads } from "@/src/lib/api/downloads.ts";
import { useDownloadsStore } from "@/src/store/useDownloadsStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

const RECONNECT_DELAY_MS = 2000;

export function useDownloadsStream(): void {
	// The global overlay tracks the active (default) node; switching the default
	// node re-runs this effect via the url/token deps below.
	const node = useNodeStore((s) => s.getActiveNode());
	const url = node.url;
	const token = node.token;
	const applySnapshot = useDownloadsStore((s) => s.applySnapshot);
	const applyUpdate = useDownloadsStore((s) => s.applyUpdate);
	const removeTask = useDownloadsStore((s) => s.removeTask);
	const reset = useDownloadsStore((s) => s.reset);

	useEffect(() => {
		let cancelled = false;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		const controller = new AbortController();
		const target = { url, token: token ?? null };

		// Drop the mirror from any previous node; the snapshot event refills it.
		reset();

		const run = async () => {
			while (!cancelled) {
				try {
					await streamDownloads(
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
					);
				} catch {
					// Aborted (node switch/unmount) or transient — fall through to retry.
				}
				if (cancelled) {
					break;
				}
				await new Promise<void>((resolve) => {
					reconnectTimer = setTimeout(resolve, RECONNECT_DELAY_MS);
				});
			}
		};
		run();

		return () => {
			cancelled = true;
			controller.abort();
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
			}
		};
	}, [url, token, applySnapshot, applyUpdate, removeTask, reset]);
}
