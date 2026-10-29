// packages/services/src/notify/routes.ts
//
// Ryu Notify: routes whose writes the server deduplicates by `Idempotency-Key`.
// apps/notify/src/service.ts reads the header in two places: `publishEvent`
// (`POST /v1/events` and `POST /v1/topics/:topic`, key optional) and the
// activity create (`POST /v1/activities`, key required, 400 without one).
// Keys are at most 128 characters; a UUID fits. test/conformance/notify.test.ts
// pins this table to those call sites.

import type { ServiceRouteTable } from "../routes.ts";

/** Ryu Notify idempotent routes, relative to the mount. */
export const NOTIFY_ROUTES: ServiceRouteTable = {
	service: "notify",
	mount: "",
	// Notify reports a replay as `{ idempotent: true }` in the body, never as a header.
	replayedBodyField: "idempotent",
	idempotent: [
		{ method: "POST", path: "/v1/events", required: false },
		{ method: "POST", path: "/v1/topics/{topic}", required: false },
		{ method: "POST", path: "/v1/activities", required: true },
	],
};
