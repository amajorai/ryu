// The control-plane (Better Auth) account backend the CLI talks to.
//
// RYU_AUTH_URL names it; unset, it falls back to the profile's default control
// plane (controlPlane.ts): the hosted origin, or under RYU_PROFILE=dev the local
// development server at http://localhost:3000. A loopback fallback is a
// plain-HTTP port with no server identity, so on a user's machine any local
// program can listen there. The account session token (Core's /api/auth/status)
// and the user JWT must never go to such a listener unless the user named that
// address themselves. So: an explicitly configured RYU_AUTH_URL is used as
// given, a hosted (HTTPS) default keeps TLS server authentication, and an
// unconfigured loopback fallback gets a transport that strips the bearer and
// the user JWT from every request.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { authBackendUrl as controlPlaneUrl } from "./controlPlane.ts";
import { isPlainHttpLoopback, withoutCredentials } from "./coreIdentity.ts";

type AuthBackendEnvironment = Readonly<Record<string, string | undefined>>;

/** The default account backend for the current profile, ignoring RYU_AUTH_URL. */
function defaultAuthBackendUrl(env: AuthBackendEnvironment): string {
	return controlPlaneUrl({ ...env, RYU_AUTH_URL: undefined });
}

/** The configured account backend, or the profile's default. */
export function authBackendUrl(
	env: AuthBackendEnvironment = process.env
): string {
	return controlPlaneUrl(env);
}

export const AUTH_BACKEND_URL = authBackendUrl();

/**
 * Whether account credentials may be sent to the account backend: always for
 * HTTPS or a non-loopback host, and for a plain-HTTP loopback address only
 * when the user set RYU_AUTH_URL to it explicitly.
 */
export function authBackendAcceptsCredentials(
	env: AuthBackendEnvironment = process.env
): boolean {
	if (env.RYU_AUTH_URL?.trim()) {
		return true;
	}
	return !isPlainHttpLoopback(defaultAuthBackendUrl(env));
}

/**
 * The ApiTarget for account-backend calls made with the account session
 * `token`. Every CLI request to the account backend must be built here.
 */
export function accountBackendTarget(
	token: string,
	env: AuthBackendEnvironment = process.env
): ApiTarget {
	const url = authBackendUrl(env);
	if (authBackendAcceptsCredentials(env)) {
		return { token, url };
	}
	return { fetch: withoutCredentials(), token, url };
}
