import { randomUUID } from "node:crypto";

// The marker on Ryu's own server-side calls to a cooldown endpoint that must
// not claim in the request path again (lib/deferred-auth-request.ts): a
// per-process secret, so no outside request can carry it.

export const REPLAY_HEADER = "x-ryu-deferred-auth-request";
export const REPLAY_MARKER = randomUUID();

/**
 * Headers that let Ryu's own server-side call to a cooldown endpoint through
 * without a request-path claim, for a caller whose send claims for itself.
 */
export function deferredReplayHeaders(): Headers {
	return new Headers({ [REPLAY_HEADER]: REPLAY_MARKER });
}
