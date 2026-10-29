// packages/services/src/managed-agents/routes.ts
//
// Ryu Managed Agents: routes whose writes the server deduplicates by `Idempotency-Key`.
// Verified against the seven `idempotencyOf(c, "<METHOD> <path>", body)` call
// sites in packages/api/src/routers/managed-agents.ts (the "Key" rows of the
// public endpoint table); test/conformance/managed-agents.test.ts re-reads
// them. The key is optional everywhere: without one a retried write can run
// twice, so the SDK adds one automatically. The server grammar is
// `^[A-Za-z0-9_-]{16,128}$`, which the SDK's UUID keys satisfy.

import type { ServiceRouteTable } from "../routes.ts";

/** Ryu Managed Agents idempotent routes, relative to the mount. */
export const MANAGED_AGENTS_ROUTES: ServiceRouteTable = {
	service: "managedAgents",
	mount: "/api/v1/managed-agents",
	idempotent: [
		{ method: "POST", path: "/agents", required: false },
		{ method: "PATCH", path: "/agents/{id}", required: false },
		{ method: "POST", path: "/environments", required: false },
		{ method: "PATCH", path: "/environments/{id}", required: false },
		{ method: "POST", path: "/credentials", required: false },
		{ method: "POST", path: "/sessions", required: false },
		{ method: "POST", path: "/sessions/{id}/events", required: false },
	],
};
