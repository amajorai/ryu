// Desktop client for Core's agent/app shell-navigation events.
//
// Navigation rides the shared `/api/events/all` connection so a workspace with
// several live feeds does not spend another long-lived HTTP socket. Core filters
// targeted requests against the verified user before they reach this client.

import type { ApiTarget } from "./client.ts";
import { streamChannel } from "./eventStream.ts";
import {
	type NavigationLegacyRequest,
	navigationLegacySchema,
} from "./navigation-wire-contracts.ts";

export type NavigationKind = "browser" | "interface" | "panel" | "tab";

export type NavigationRequest = NavigationLegacyRequest;

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
			const request = navigationLegacySchema.safeParse(data);
			if (request.success) {
				onRequest(request.data);
			}
		},
		signal,
		navigationLegacySchema
	);
}
