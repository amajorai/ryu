// Where the CLI reaches the Ryu control plane (Better Auth, waitlist, managed
// nodes) and the web app it links people to.
//
// RYU_AUTH_URL     - control-plane API origin
// RYU_FRONTEND_URL - web app origin used in printed links
//
// Unset, both default to the hosted Ryu origins so an installed `ryu-cli` works
// without configuration; under RYU_PROFILE=dev they default to the local
// `apps/server` (:3000) and `apps/web` (:3001) a checkout runs. Mirrors
// `defaultAuthBackendUrl` in apps/mcp/src/auth.ts.

const PRODUCTION_AUTH_BACKEND = "https://api.ryuhq.com";
const PRODUCTION_FRONTEND = "https://ryuhq.com";
const DEV_AUTH_BACKEND = "http://localhost:3000";
const DEV_FRONTEND = "http://localhost:3001";

type ControlPlaneEnvironment = Readonly<Record<string, string | undefined>>;

const isDevProfile = (env: ControlPlaneEnvironment): boolean =>
	(env.RYU_PROFILE ?? "").trim().toLowerCase() === "dev";

/** `RYU_AUTH_URL` when set, else the profile's default control plane. */
export function authBackendUrl(
	env: ControlPlaneEnvironment = process.env
): string {
	return (
		env.RYU_AUTH_URL?.trim() ||
		(isDevProfile(env) ? DEV_AUTH_BACKEND : PRODUCTION_AUTH_BACKEND)
	);
}

/** `RYU_FRONTEND_URL` when set, else the profile's default web app. */
export function frontendUrl(
	env: ControlPlaneEnvironment = process.env
): string {
	return (
		env.RYU_FRONTEND_URL?.trim() ||
		(isDevProfile(env) ? DEV_FRONTEND : PRODUCTION_FRONTEND)
	);
}
