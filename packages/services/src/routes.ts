// packages/services/src/routes.ts
//
// Idempotent-route tables, one per service (`src/<svc>/routes.ts`). The fetch
// shim adds an `Idempotency-Key` only to POST/PATCH requests whose path,
// relative to the service mount, matches a row here, and the per-service
// OpenAPI documents declare the `Idempotency-Key` parameter on exactly these
// routes (apps/web/src/lib/openapi-services checks that).

import { BOX_ROUTES } from "./box/routes.ts";
import { CONNECT_ROUTES } from "./connect/routes.ts";
import type { RyuService } from "./errors.ts";
import { GATEWAY_ROUTES } from "./gateway/routes.ts";
import { MAIL_ROUTES } from "./mail/routes.ts";
import { MANAGED_AGENTS_ROUTES } from "./managed-agents/routes.ts";
import { MESSAGING_ROUTES } from "./messaging/routes.ts";
import { NOTIFY_ROUTES } from "./notify/routes.ts";
import { PASSPORT_ROUTES } from "./passport/routes.ts";
import { SITES_ROUTES } from "./sites/routes.ts";

/** One route whose writes the server deduplicates by `Idempotency-Key`. */
export interface IdempotentRoute {
	method: "POST" | "PATCH";
	/** Path relative to the mount; `{name}` matches one non-empty segment. */
	path: string;
	/** The server rejects the request without a key. */
	required: boolean;
}

/**
 * An idempotent route that only some server builds deduplicate. The shim keys
 * it (and so may retry it) only after the server advertised `capability`;
 * when that is unknown or false the route is treated as unlisted: no key and
 * no replay.
 */
export interface CapabilityIdempotentRoute extends IdempotentRoute {
	/** The feature flag the server must advertise as `true` (Passport `features.idempotency_keys`). */
	capability: string;
}

/**
 * A write that must never be sent twice once it may have reached the server,
 * although its method is idempotent by definition (a `PUT` whose reply carries
 * a one-time secret). The shim retries it only on a `429` that names a wait,
 * which the server refuses before doing any work.
 */
export interface NonReplaySafeRoute {
	method: "POST" | "PUT" | "PATCH" | "DELETE";
	/** Path relative to the mount; `{name}` matches one non-empty segment. */
	path: string;
	/** Why a replay is unsafe, for docs and reviews. */
	reason: string;
}

/** A service's mount and its idempotent routes. */
export interface ServiceRouteTable {
	/** Routes keyed only when the server advertises a capability (see {@link CapabilityIdempotentRoute}). */
	capabilityIdempotent?: readonly CapabilityIdempotentRoute[];
	idempotent: readonly IdempotentRoute[];
	/** Path prefix under the service base URL that `path` is relative to ("" for none). */
	mount: string;
	/** Writes the shim never replays after a network error, timeout or 5xx. */
	nonReplaySafe?: readonly NonReplaySafeRoute[];
	/**
	 * A top-level boolean in the JSON body of an idempotent-route 2xx that marks
	 * a replayed write, for services that report replays in the body instead of
	 * an `Idempotent-Replayed` header (Notify's `idempotent`).
	 */
	replayedBodyField?: string;
	/**
	 * The value of `replayedBodyField` that marks a replay. Default `true`; Box
	 * answers a replayed create or fork with `type: "box.existing"`.
	 */
	replayedBodyValue?: string | boolean;
	service: RyuService;
}

/** Every service's route table, keyed by service. */
export const SERVICE_ROUTES: Readonly<Record<RyuService, ServiceRouteTable>> = {
	box: BOX_ROUTES,
	connect: CONNECT_ROUTES,
	gateway: GATEWAY_ROUTES,
	mail: MAIL_ROUTES,
	managedAgents: MANAGED_AGENTS_ROUTES,
	messaging: MESSAGING_ROUTES,
	notify: NOTIFY_ROUTES,
	passport: PASSPORT_ROUTES,
	sites: SITES_ROUTES,
};
