// packages/services/src/tools/idempotency.ts
//
// The `idempotencyKey` argument of the registry's open-world writes.
//
// The rule: every tool that creates something billed or reaches people takes
// a model-supplied `idempotencyKey`, because the SDK's automatic key only
// covers its own HTTP retries; a tool call the host re-issues after a timeout
// is a new call with a new automatic key. Mail and Messaging require the key
// (a duplicate email or SMS cannot be recalled). The others (box_create,
// managed_agents_create_session, managed_agents_send_message,
// notify_publish) take it as optional, with the same wording, so existing MCP
// callers keep working; the description tells the model to pass one. The
// accepted format is each service's own. notify_request_approval also takes
// an optional key but with its own wording (`approvalIdempotencyKey` in
// tools/notify.ts): a keyed retry gets 409 idempotency_conflict, not a replay.

import * as z from "zod";

/** What the key's description says about one tool. */
export interface IdempotencyKeyWording {
	/** What a second call without the key would do, e.g. "creating a second Box". */
	readonly duplicate: string;
	/** The format the service accepts, e.g. "printable ASCII, 1-128 characters". */
	readonly format: string;
	/** What a new key does, e.g. "creates a new Box". */
	readonly fresh: string;
	readonly pattern: RegExp;
	/** What the key identifies, e.g. "Box". */
	readonly subject: string;
}

/** Printable ASCII without spaces, 1-128 characters (Box, Notify). */
export const HEADER_KEY_128 = /^[\x21-\x7e]{1,128}$/u;
/** The Managed Agents key format. */
export const MANAGED_AGENTS_KEY = /^[A-Za-z0-9_-]{16,128}$/u;

/** The description every optional `idempotencyKey` carries. */
export function optionalIdempotencyKeyDescription(
	wording: IdempotencyKeyWording
): string {
	return `Recommended. A key unique to this ${wording.subject} (${wording.format}). Reuse the same key when you retry the same call: the server answers from the first attempt instead of ${wording.duplicate}. A new key ${wording.fresh}. Without a key, each tool call gets its own, so a call the host retries is not deduplicated.`;
}

/** An optional `idempotencyKey` argument with the shared wording. */
export function optionalIdempotencyKey(wording: IdempotencyKeyWording) {
	return z
		.string()
		.regex(wording.pattern, `idempotencyKey is ${wording.format}.`)
		.optional()
		.describe(optionalIdempotencyKeyDescription(wording));
}
