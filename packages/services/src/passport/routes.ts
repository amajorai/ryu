// packages/services/src/passport/routes.ts
//
// Ryu Passport: routes whose writes the server deduplicates by `Idempotency-Key`.
// No route is keyed unconditionally. Newer servers honour an optional key on
// `POST /v1/connections` and advertise it as `features.idempotency_keys` on
// `GET /v1/capabilities` (apps/passport/src/idempotency.rs); an older one
// ignores the header, so a keyed retry there could duplicate a connection.
// The create is therefore a capability-gated route: the shim keys it, and may
// retry it, only once this Ryu instance has read `idempotency_keys: true` from
// that base URL. Unknown (the probe failed) or false means no key and no retry.
//
// PASSPORT_SDK_ROUTES lists every route `ryu.passport` calls. The Passport
// OpenAPI test (apps/web/src/lib/openapi-services/passport.test.ts) checks
// each one against the axum router in apps/passport/src/lib.rs and the
// published document.

import type { ServiceRouteTable } from "../routes.ts";

/** The `features` flag Passport sets when it honours `Idempotency-Key` on `POST /v1/connections`. */
export const PASSPORT_IDEMPOTENCY_CAPABILITY = "idempotency_keys";

/** Ryu Passport idempotent routes, relative to the mount. */
export const PASSPORT_ROUTES: ServiceRouteTable = {
	service: "passport",
	mount: "",
	idempotent: [],
	capabilityIdempotent: [
		{
			method: "POST",
			path: "/v1/connections",
			required: false,
			capability: PASSPORT_IDEMPOTENCY_CAPABILITY,
		},
	],
};

/** One route the SDK Passport client calls. */
export interface PassportSdkRoute {
	/** Which bearer the SDK sends: the administration key, the runtime grant, or either. */
	readonly credential: "admin" | "runtime" | "admin-or-runtime";
	/** Upper-case HTTP method. */
	readonly method: "GET" | "POST" | "DELETE";
	/** Path template relative to the Passport base URL, starting with `/`. */
	readonly path: string;
}

/** Every route `ryu.passport` calls, in the order the namespace lists them. */
export const PASSPORT_SDK_ROUTES: readonly PassportSdkRoute[] = [
	{ method: "GET", path: "/v1/capabilities", credential: "admin" },
	{ method: "GET", path: "/v1/profiles", credential: "admin" },
	{ method: "GET", path: "/v1/connections", credential: "admin" },
	{ method: "POST", path: "/v1/connections", credential: "admin" },
	{ method: "GET", path: "/v1/connections/{id}", credential: "admin" },
	{ method: "DELETE", path: "/v1/connections/{id}", credential: "admin" },
	{ method: "POST", path: "/v1/connections/{id}/login", credential: "admin" },
	{ method: "POST", path: "/v1/connections/{id}/import", credential: "admin" },
	{
		method: "POST",
		path: "/v1/connections/{id}/fetch",
		credential: "admin-or-runtime",
	},
	{ method: "GET", path: "/v1/runtime/connections", credential: "runtime" },
	{ method: "GET", path: "/v1/usage", credential: "admin" },
];
