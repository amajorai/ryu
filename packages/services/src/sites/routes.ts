// packages/services/src/sites/routes.ts
//
// Ryu Sites: routes whose writes the server deduplicates by `Idempotency-Key`.
// No Sites management route deduplicates writes; every change is guarded by
// `expectedRevision` instead, and a stale revision answers `409 conflict`.
//
// `nonReplaySafe` lists the `PUT` and `DELETE` writes that carry
// `expectedRevision`. Their method is idempotent, but the server moves the
// revision when the first attempt commits, so resending the same
// `expectedRevision` after a lost reply answers `409 conflict` although the
// write applied (and `DELETE` bumps the revision before the Space database
// removal, so a retry after that fails can never succeed). The shim sends them
// once; only a `429` with a wait is retried.
//
// SITES_SDK_ROUTES lists every management route `ryu.sites` calls. The Sites
// OpenAPI test (apps/web/src/lib/openapi-services/sites.test.ts) checks each
// one against the route literals in the Sites satellite's server and the
// published document.

import type { ServiceRouteTable } from "../routes.ts";

/** Ryu Sites idempotent routes, relative to the mount. */
export const SITES_ROUTES: ServiceRouteTable = {
	service: "sites",
	mount: "/api/sites",
	idempotent: [],
	nonReplaySafe: [
		{
			method: "PUT",
			path: "/projects/{id}/settings",
			reason:
				"The write carries expectedRevision and moves it; a replay after a lost reply answers 409 conflict although the change applied.",
		},
		{
			method: "DELETE",
			path: "/projects/{id}",
			reason:
				"The write carries expectedRevision and moves it before the Space database is removed; a replay answers 409 conflict, or can never succeed after a partial failure.",
		},
	],
};

/** One route the SDK Sites client calls. */
export interface SitesSdkRoute {
	/** Upper-case HTTP method. */
	readonly method: "GET" | "POST" | "PUT" | "DELETE";
	/** Path template relative to the Sites base URL, starting with `/`. */
	readonly path: string;
}

/** Every route `ryu.sites` calls, in the order the namespace lists them. */
export const SITES_SDK_ROUTES: readonly SitesSdkRoute[] = [
	{ method: "GET", path: "/api/sites/status" },
	{ method: "GET", path: "/api/sites/projects" },
	{ method: "POST", path: "/api/sites/projects" },
	{ method: "GET", path: "/api/sites/projects/{id}" },
	{ method: "DELETE", path: "/api/sites/projects/{id}" },
	{ method: "PUT", path: "/api/sites/projects/{id}/settings" },
	{ method: "POST", path: "/api/sites/projects/{id}/versions" },
	{ method: "POST", path: "/api/sites/projects/{id}/deploy" },
	{ method: "POST", path: "/api/sites/projects/{id}/unpublish" },
];
