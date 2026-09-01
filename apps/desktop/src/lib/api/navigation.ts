// Desktop client for Core's agent/app shell-navigation events.
//
// Navigation rides the shared `/api/events/all` connection so a workspace with
// several live feeds does not spend another long-lived HTTP socket. Core filters
// targeted requests against the verified user before they reach this client.

import type { ApiTarget } from "./client.ts";
import { streamChannel } from "./eventStream.ts";

export type NavigationKind = "tab" | "panel" | "browser";

export interface NavigationRequest {
	force_new?: boolean;
	kind?: NavigationKind;
	plugin_id?: string;
	target: string;
	target_user_id?: string;
}

/** Subscribe to user-scoped shell navigation requests. */
export function streamNavigationRequests(
	target: ApiTarget,
	onRequest: (request: NavigationRequest) => void,
	signal?: AbortSignal
): Promise<void> {
	return streamChannel(
		target,
		"navigation",
		(data) => {
			if (
				typeof data === "object" &&
				data !== null &&
				typeof (data as { target?: unknown }).target === "string"
			) {
				onRequest(data as NavigationRequest);
			}
		},
		signal
	);
}
