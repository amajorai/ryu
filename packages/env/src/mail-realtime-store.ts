// packages/env/src/mail-realtime-store.ts
//
// `RYU_MAIL_REALTIME_STORE` on its own. `./server.ts` declares it with this
// schema, so a typo fails the whole server env at boot; `@ryu/api/lib/mail-realtime`
// reads it through `readMailRealtimeStore()` instead of importing `./server.ts`,
// so modules and tests that import mail realtime do not validate (and need)
// every server variable when they load. This module has no load-time effects.

import { z } from "zod";

/** Environment variable that selects the hosted Mail realtime backend. */
export const MAIL_REALTIME_STORE_ENV = "RYU_MAIL_REALTIME_STORE";

/** `memory` (the default, one replica) or `mongo` (shared via change streams). */
export type MailRealtimeStoreMode = "memory" | "mongo";

/** The schema `./server.ts` validates `RYU_MAIL_REALTIME_STORE` with. */
export const mailRealtimeStoreSchema = z
	.string()
	.trim()
	.toLowerCase()
	.pipe(z.enum(["memory", "mongo"]))
	.optional();

/**
 * Validates `RYU_MAIL_REALTIME_STORE` from `source` (default `process.env`)
 * with the server env's schema and rules: an empty value counts as unset, as
 * `emptyStringAsUndefined` makes it in `./server.ts`, and anything other than
 * `memory` or `mongo` throws.
 */
export function readMailRealtimeStore(
	source: Readonly<Record<string, string | undefined>> = process.env
): MailRealtimeStoreMode | undefined {
	const raw = source[MAIL_REALTIME_STORE_ENV];
	return mailRealtimeStoreSchema.parse(raw === "" ? undefined : raw);
}
