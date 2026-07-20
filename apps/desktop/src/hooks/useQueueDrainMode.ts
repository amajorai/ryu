import { useEffect, useState } from "react";

/** How the message queue drains while a run is streaming.
 *
 *  - `oldest-first` (default): send the message that has waited longest, one per
 *    turn — first in, first out.
 *  - `latest-first`: send the most recently queued message next — a last-in,
 *    first-out stack, so a late correction jumps the line.
 *  - `send-all`: collapse the whole queue into a single combined turn on the
 *    next drain instead of trickling one per turn.
 *
 *  Window-local + reactive across the composer, queue bar, and settings via the
 *  same localStorage + `storage`-event pattern as the other desktop UI prefs
 *  (see `useTabLayout`). Purely client-side — the queue is a desktop-side turn
 *  scheduler, so this never touches Core. */
export type QueueDrainMode = "oldest-first" | "latest-first" | "send-all";

const KEY = "ryu_queue_drain_mode";
const DEFAULT: QueueDrainMode = "oldest-first";

function read(): QueueDrainMode {
	const value = localStorage.getItem(KEY);
	if (value === "latest-first" || value === "send-all") {
		return value;
	}
	return DEFAULT;
}

export function useQueueDrainMode(): QueueDrainMode {
	const [mode, setMode] = useState<QueueDrainMode>(read);

	useEffect(() => {
		const handler = () => setMode(read());
		window.addEventListener("storage", handler);
		return () => window.removeEventListener("storage", handler);
	}, []);

	return mode;
}

export function setQueueDrainMode(mode: QueueDrainMode) {
	localStorage.setItem(KEY, mode);
	// Same-document listeners don't get the native `storage` event, so broadcast
	// one ourselves — every useQueueDrainMode() consumer re-reads on this.
	window.dispatchEvent(new Event("storage"));
}
