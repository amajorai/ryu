// apps/desktop/src/lib/api/events.ts
//
// Client for Core's app-events feed: built-in agent actions (e.g.
// `notify__desktop`) publish desktop notifications in Core; this reads them so
// the desktop can render a native OS notification. Delivery now rides the shared
// multiplexed event stream (`/api/events/all`, see eventStream.ts) so it no
// longer holds its own HTTP connection.

import type { ApiTarget } from "./client.ts";
import { streamChannel } from "./eventStream.ts";

/** A desktop notification pushed by Core. */
export interface DesktopNotification {
	body?: string | null;
	level?: string;
	title: string;
}

/**
 * Subscribe to desktop-notification events and invoke `onNotification` for each.
 * Resolves when `signal` aborts. Shares the single multiplexed node connection.
 */
export function streamDesktopNotifications(
	target: ApiTarget,
	onNotification: (n: DesktopNotification) => void,
	signal?: AbortSignal
): Promise<void> {
	return streamChannel(target, "notifications", onNotification, signal);
}
