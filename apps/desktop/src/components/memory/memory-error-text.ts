// Readable text for a failed Memory API call. `ApiError.message` keeps the
// transport shape ("/api/memory failed: 400") for logs, so it is never shown:
// the page shows Core's own refusal when it sent one, otherwise the caller's
// localized fallback.

import { ApiError } from "@/src/lib/api/client.ts";

export function memoryErrorText(error: unknown, fallback: string): string {
	if (error instanceof ApiError && error.serverMessage) {
		return error.serverMessage;
	}
	return fallback;
}
