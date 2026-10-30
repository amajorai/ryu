// Error-message helper for the provider login dialog.

import { ApiError } from "@/src/lib/api/client.ts";

/** Prefer Core's actionable error body over the generic HTTP path/status. */
export function providerLoginErrorMessage<TCause>(
	cause: TCause,
	fallback: string
): string {
	if (cause instanceof ApiError && cause.serverMessage) {
		return cause.serverMessage;
	}
	return cause instanceof Error ? cause.message : fallback;
}
