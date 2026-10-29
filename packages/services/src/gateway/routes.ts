// packages/services/src/gateway/routes.ts
//
// Ryu Gateway: routes whose writes the server deduplicates by `Idempotency-Key`.
// No Gateway route deduplicates writes, so no POST is ever given a key or retried on a 5xx.
//
// GATEWAY_SDK_ROUTES lists every route the SDK Gateway client calls. The
// Gateway YAML ratchet (apps/web/src/lib/openapi-services/gateway-yaml-ratchet.test.ts)
// checks each one against the axum router and the hand-written Gateway
// OpenAPI document, and checks that the client sources name no other path.

import type { ServiceRouteTable } from "../routes.ts";

/** Ryu Gateway idempotent routes, relative to the mount. */
export const GATEWAY_ROUTES: ServiceRouteTable = {
	service: "gateway",
	mount: "",
	idempotent: [],
};

/** One route the SDK Gateway client calls. */
export interface GatewaySdkRoute {
	/** Upper-case HTTP method. */
	readonly method: "GET" | "POST";
	/** Path relative to the Gateway base URL, starting with `/`. */
	readonly path: string;
}

/** Every route `ryu.gateway` calls, in the order the namespace lists them. */
export const GATEWAY_SDK_ROUTES: readonly GatewaySdkRoute[] = [
	{ method: "GET", path: "/health" },
	{ method: "GET", path: "/v1/auth/status" },
	{ method: "GET", path: "/v1/models" },
	{ method: "POST", path: "/v1/chat/completions" },
	{ method: "POST", path: "/v1/embeddings" },
];
