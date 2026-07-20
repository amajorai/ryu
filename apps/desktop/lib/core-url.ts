/** Default Core base URL — swappable via `VITE_CORE_URL` at build time. */
export const DEFAULT_CORE_URL =
	(import.meta.env.VITE_CORE_URL as string | undefined)?.replace(/\/$/, "") ||
	"http://127.0.0.1:7980";

/**
 * Core used for the device-auth broker (`/api/auth/login` + `/api/auth/status`).
 *
 * Desktop: same as {@link DEFAULT_CORE_URL} (local sidecar).
 * Webapp: set `VITE_AUTH_CORE_URL=https://core.ryuhq.com` so sign-in works
 * without a local node; after login the node store prefers local when reachable.
 */
export const AUTH_CORE_URL =
	(import.meta.env.VITE_AUTH_CORE_URL as string | undefined)?.replace(
		/\/$/,
		""
	) || DEFAULT_CORE_URL;
