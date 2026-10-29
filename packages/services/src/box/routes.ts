// packages/services/src/box/routes.ts
//
// Ryu Box: routes whose writes the server deduplicates by `Idempotency-Key`.
// Seeded from design §4.1; the Box client already sends a key on both routes, which the shim keeps unless the caller supplies one.

import type { ServiceRouteTable } from "../routes.ts";

/** Ryu Box idempotent routes, relative to the mount. */
export const BOX_ROUTES: ServiceRouteTable = {
	service: "box",
	mount: "",
	idempotent: [
		{ method: "POST", path: "/v1/boxes", required: true },
		{ method: "POST", path: "/v1/boxes/{id}/fork", required: true },
	],
	// A replayed create or fork answers 200 with `Idempotent-Replayed: true`
	// and `type: "box.existing"` (apps/box/src/service.ts). The shim reads the
	// header first; the body marker covers Box servers that predate it.
	replayedBodyField: "type",
	replayedBodyValue: "box.existing",
};
