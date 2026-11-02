import type { LiteralMessage } from "@ryu/i18n/react";
import {
	securityKeyErrorCode,
	securityKeyErrorDetail,
} from "@/src/lib/api/security-key.ts";

/**
 * What to tell the user about a native security-key failure. The native side
 * leads every error with a stable code (`timeout: …`); the detail after it is
 * English diagnostic text, so only the code picks the sentence.
 */
export function securityKeyErrorMessage(
	error: unknown,
	tl: LiteralMessage
): string {
	switch (securityKeyErrorCode(error)) {
		case "timeout":
			return tl(
				"No security key answered in time. Make sure it is plugged in, then try again."
			);
		case "cancelled":
			return tl("The security key request was cancelled.");
		case "unavailable":
			return tl(
				"No security key is available on this device. Plug one in, then try again."
			);
		case "pin_blocked":
			return tl(
				"This key's PIN is blocked after too many wrong tries. Reset the key to use it again."
			);
		case "pin_not_set":
			return tl(
				"This site needs a PIN, but this key has none. Set a PIN on the key, then try again."
			);
		case "credential_excluded":
			return tl("This key is already registered with this site.");
		case "no_credentials":
			return tl("This key has no sign-in saved for this site.");
		case "expired":
			return tl("This request is no longer waiting.");
		case "unsupported":
		case "invalid":
			return tl("This request can't be completed with a security key.");
		default:
			return tl("The security key reported an error. Try again.");
	}
}

/**
 * The line shown above the PIN field after the key refused a PIN, or null for
 * the first ask. `pin_required: wrong PIN (2 attempts left)` keeps its count.
 */
export function securityKeyPinMessage(
	error: unknown,
	tl: LiteralMessage
): string | null {
	const detail = securityKeyErrorDetail(error);
	if (!detail) {
		return null;
	}
	if (/wrong pin/iu.test(detail)) {
		const left = /\((\d+) attempts? left\)/u.exec(detail)?.[1];
		if (left === "1") {
			return tl("Wrong PIN. 1 attempt left before the key locks.");
		}
		return left
			? tl("Wrong PIN. {count} attempts left.", { count: left })
			: tl("Wrong PIN. Try again.");
	}
	return tl(
		"That PIN can't be used. Security key PINs have at least 4 characters."
	);
}
