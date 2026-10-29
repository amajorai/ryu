// packages/services/src/messaging/routes.ts
//
// Ryu Messaging: routes whose writes the server deduplicates by
// `Idempotency-Key`. Verified against the `requireIdempotencyKey(c)` call
// sites in packages/api/src/routers/messaging.ts (the "Key" rows of the
// public endpoint table): every send and the number purchase spend the
// organization's credit, so the server refuses them without a key
// (`400 idempotency_key_required`). The wrapped client always sends one;
// messaging.test.ts re-reads the router so this table cannot drift.
//
// `nonReplaySafe` lists writes the shim must not resend after a network
// error, timeout or 5xx even though their method is idempotent:
// `PUT /orgs/{orgId}/settings` returns a newly created webhook secret only in
// the reply that creates it, so a replay after a lost reply answers without
// it. A `429` with a wait is still retried (the server refused before working).

import type { ServiceRouteTable } from "../routes.ts";

/** Ryu Messaging idempotent routes, relative to the mount. */
export const MESSAGING_ROUTES: ServiceRouteTable = {
	service: "messaging",
	mount: "/api/messaging",
	idempotent: [
		{ method: "POST", path: "/orgs/{orgId}/numbers", required: true },
		{ method: "POST", path: "/orgs/{orgId}/sms", required: true },
		{ method: "POST", path: "/orgs/{orgId}/mms", required: true },
		{ method: "POST", path: "/orgs/{orgId}/voice", required: true },
		{ method: "POST", path: "/orgs/{orgId}/whatsapp", required: true },
	],
	nonReplaySafe: [
		{
			method: "PUT",
			path: "/orgs/{orgId}/settings",
			reason:
				"The reply that first sets a webhook URL carries the new webhook secret once; a replay after a lost reply answers without it.",
		},
	],
};
