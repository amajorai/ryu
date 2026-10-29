import type {
	AppRequestPayload,
	HostServices,
	RpcJsonResponse,
} from "./rpc.ts";
import { CodedRpcError } from "./rpc-errors.ts";

// Target resolution for the generic `app.request` host verb (Host API 1.18).
//
// Without `app` (or with the caller's own id) the request goes to the calling
// companion's OWN sidecar, exactly as before, under the `app:http` grant. With
// another app's id it goes to THAT app's sidecar, and only when the caller holds
// the reviewed per-target grant `app:http:<target id>`. The trusted host owns both
// ids; the frame can only name a target, never a host, mount, or credential. The
// relative path is still confined to the target's own `/api/ext/<target>` mount by
// the host's forwarder, and Core's ext-proxy still enforces the target manifest's
// declared routes and its enabled state.

/** The own-app grant. */
export const APP_HTTP_GRANT = "app:http";
/** Prefix of a per-target cross-app grant: `app:http:@scope/name`. */
export const APP_HTTP_TARGET_GRANT_PREFIX = "app:http:";

const SCOPED_APP_ID = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/;
const MAX_APP_ID_LENGTH = 214;

/** Whether `id` is a concrete scoped app id (`@scope/name`, no wildcard). */
export function isScopedAppId(id: string): boolean {
	return id.length <= MAX_APP_ID_LENGTH && SCOPED_APP_ID.test(id);
}

/** The per-target grant a caller needs to request `target`. */
export function appHttpTargetGrant(target: string): string {
	return `${APP_HTTP_TARGET_GRANT_PREFIX}${target}`;
}

/** The target app id named by a well-formed per-target grant, else `null`. */
export function appHttpGrantTarget(grant: string): string | null {
	if (!grant.startsWith(APP_HTTP_TARGET_GRANT_PREFIX)) {
		return null;
	}
	const target = grant.slice(APP_HTTP_TARGET_GRANT_PREFIX.length);
	return isScopedAppId(target) ? target : null;
}

export type AppRequestTarget =
	| { allowed: true; pluginId: string }
	| { allowed: false; reason: string };

/**
 * Decide which plugin an `app.request` reaches. `approvedGrants` MUST be the
 * Gateway-approved set, never the manifest claim.
 */
export function resolveAppRequestTarget(
	callerId: string,
	approvedGrants: readonly string[],
	app: string | undefined
): AppRequestTarget {
	const own = app === undefined || app === callerId;
	if (own) {
		return approvedGrants.includes(APP_HTTP_GRANT)
			? { allowed: true, pluginId: callerId }
			: { allowed: false, reason: `app.request requires ${APP_HTTP_GRANT}` };
	}
	if (!isScopedAppId(app)) {
		return {
			allowed: false,
			reason: "app.request target must be a scoped app id",
		};
	}
	const grant = appHttpTargetGrant(app);
	return approvedGrants.includes(grant)
		? { allowed: true, pluginId: app }
		: { allowed: false, reason: `app.request to ${app} requires ${grant}` };
}

type AppRequestService = NonNullable<HostServices["appRequest"]>;

/** Forward one validated relative request to `pluginId`'s ext-proxy mount. */
export type AppMountForwarder = (
	pluginId: string,
	input: Omit<AppRequestPayload, "app">,
	signal?: AbortSignal
) => Promise<RpcJsonResponse>;

/**
 * Build the host's `appRequest` service: resolve the target with
 * {@link resolveAppRequestTarget}, refuse with a coded `denied` when the grant is
 * missing, and forward to the resolved plugin's mount.
 */
export function appRequestService(options: {
	approvedGrants: readonly string[];
	callerId: string;
	forward: AppMountForwarder;
}): AppRequestService {
	return (input, signal) => {
		const { app, ...request } = input;
		const target = resolveAppRequestTarget(
			options.callerId,
			options.approvedGrants,
			app
		);
		if (!target.allowed) {
			return Promise.reject(new CodedRpcError("denied", target.reason));
		}
		return options.forward(target.pluginId, request, signal);
	};
}
