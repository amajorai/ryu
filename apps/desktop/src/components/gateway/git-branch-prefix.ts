import type { LiteralMessage } from "@ryu/i18n/react";

/** Core refuses a branch prefix longer than this many UTF-8 bytes. */
const MAX_BRANCH_PREFIX_BYTES = 80;

/** Why a Git branch prefix cannot be saved, in the reader's language, or
 *  `null` when it is acceptable. */
export function branchPrefixErrorText(
	value: string,
	tl: LiteralMessage
): string | null {
	if (new TextEncoder().encode(value).byteLength > MAX_BRANCH_PREFIX_BYTES) {
		return tl("Branch prefixes must be at most 80 bytes.");
	}
	if (/\s/u.test(value) || value.includes("..")) {
		return tl("Branch prefixes cannot contain whitespace or '..'.");
	}
	return null;
}
