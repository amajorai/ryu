// packages/services/src/connect/routes.ts
//
// Ryu Connect: routes whose writes the server deduplicates by `Idempotency-Key`.
// No Connect route deduplicates writes; `tools.exec` and `composio.execute` are never retried.
//
// CONNECT_SDK_ROUTES lists every runtime route `ryu.connect` calls. The
// Connect OpenAPI document (apps/web/src/lib/openapi-services/connect.ts)
// must document each one. Management routes (account linking, triggers) are
// left out of v1 while their contract is being rewritten.

import type { ServiceRouteTable } from "../routes.ts";

/** Ryu Connect idempotent routes, relative to the mount. */
export const CONNECT_ROUTES: ServiceRouteTable = {
	service: "connect",
	mount: "",
	idempotent: [],
};

/** One route the SDK Connect client calls. */
export interface ConnectSdkRoute {
	/** Upper-case HTTP method. */
	readonly method: "GET" | "POST";
	/** OpenAPI-style path relative to the Connect base URL. */
	readonly path: string;
}

/** Every route `ryu.connect` calls. */
export const CONNECT_SDK_ROUTES: readonly ConnectSdkRoute[] = [
	{ method: "GET", path: "/v1/skills" },
	{ method: "GET", path: "/v1/skills/{skillId}" },
	{ method: "GET", path: "/v1/tools/search" },
	{ method: "GET", path: "/v1/tools/describe" },
	{ method: "POST", path: "/v1/exec/tool" },
	{ method: "POST", path: "/v1/composio/execute" },
	{ method: "GET", path: "/v1/usage" },
];
