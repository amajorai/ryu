// apps/desktop/src/lib/api/events.ts
//
// Client for Core's app-events SSE stream (`/api/events/notifications/stream`).
// Built-in agent actions (e.g. `notify__desktop`) publish desktop notifications
// in Core; this reads them so the desktop can render a native OS notification.
// Uses a fetch-based SSE reader (not EventSource) so the node's bearer token can
// be sent as a header — mirrors `streamMonitorAlerts`.

import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

/** A desktop notification pushed by Core. */
export interface DesktopNotification {
	body?: string | null;
	level?: string;
	title: string;
}

const FRAME_SEP = "\n\n";
const DATA_PREFIX = "data:";

/**
 * Open the desktop-notification SSE stream and invoke `onNotification` for each
 * event. Resolves when the stream ends or `signal` aborts; throws on a non-2xx
 * connect so the caller can reconnect.
 */
export async function streamDesktopNotifications(
	target: ApiTarget,
	onNotification: (n: DesktopNotification) => void,
	signal?: AbortSignal
): Promise<void> {
	const resp = await fetch(apiUrl(target, "/api/events/notifications/stream"), {
		method: "GET",
		headers: makeHeaders(target.token),
		signal,
	});
	if (!(resp.ok && resp.body)) {
		throw new Error(`notifications stream failed: ${resp.status}`);
	}
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let sep = buffer.indexOf(FRAME_SEP);
		while (sep !== -1) {
			const frame = buffer.slice(0, sep);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith(DATA_PREFIX))
				.map((line) => line.slice(DATA_PREFIX.length).trim())
				.join("\n");
			if (data) {
				try {
					onNotification(JSON.parse(data) as DesktopNotification);
				} catch {
					// Ignore malformed frames; the next event self-heals the feed.
				}
			}
			buffer = buffer.slice(sep + FRAME_SEP.length);
			sep = buffer.indexOf(FRAME_SEP);
		}
	}
}
