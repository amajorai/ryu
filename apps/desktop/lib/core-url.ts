import { standalonePortOffset } from "@ryu/app-host/standalone";
import { channelOf } from "@ryuhq/core-client/node-compat.ts";
import { isRyuStandaloneApp, STANDALONE_APP_ID } from "@/src/lib/product.ts";
import { PLAYGROUND_BUILD, playgroundCoreUrl } from "./playground.ts";

/** Default Core base URL — swappable via `VITE_CORE_URL` at build time. The
 *  Codespaces playground build uses the page's own origin instead (see
 *  `./playground.ts`); every other build ignores that branch. */
const configuredCoreUrl =
	playgroundCoreUrl(PLAYGROUND_BUILD, globalThis.location?.origin) ??
	import.meta.env.VITE_CORE_URL?.replace(/\/$/, "");

const CORE_BASE_PORT = 7980;
const RELEASE_CORE_URL = `http://127.0.0.1:${CORE_BASE_PORT}`;

/**
 * Port offsets for the channels whose builds activate their own profile.
 * Mirrors `VERSION_ACTIVATED_PROFILES` + `PROFILE_PORT_OFFSETS` in
 * `src-tauri/src/profile.rs`, which starts and dials Core on that port; the
 * `core-url.test.ts` sync test keeps the two tables together.
 */
export const VERSION_ACTIVATED_PORT_OFFSETS: ReadonlyMap<string, number> =
	new Map([
		["canary", 2000],
		["nightly", 3000],
	]);

/**
 * Precedence: the standalone app namespace, then an explicitly non-release
 * `VITE_CORE_URL` (dev's 8980, a custom URL), then the profile the bundle's own
 * version activates (canary/nightly), then the release Core.
 */
export function resolveDefaultCoreUrl(
	configuredUrl: string | undefined,
	standaloneAppId: string,
	buildVersion?: string
): string {
	if (standaloneAppId) {
		return `http://127.0.0.1:${CORE_BASE_PORT + standalonePortOffset(standaloneAppId)}`;
	}
	const url = configuredUrl || RELEASE_CORE_URL;
	if (url !== RELEASE_CORE_URL) {
		return url;
	}
	const offset = VERSION_ACTIVATED_PORT_OFFSETS.get(channelOf(buildVersion));
	return offset ? `http://127.0.0.1:${CORE_BASE_PORT + offset}` : url;
}

export const DEFAULT_CORE_URL = resolveDefaultCoreUrl(
	configuredCoreUrl,
	isRyuStandaloneApp() ? STANDALONE_APP_ID : "",
	// The hosted webapp shares this module and the stamped version, but has no
	// version-activated local profile of its own.
	import.meta.env.VITE_RYU_SURFACE === "webapp"
		? undefined
		: import.meta.env.VITE_APP_VERSION
);

/**
 * Core used for the device-auth broker (`/api/auth/login` + `/api/auth/status`).
 *
 * Desktop: same as {@link DEFAULT_CORE_URL} (local sidecar).
 * Webapp: set `VITE_AUTH_CORE_URL=https://core.ryuhq.com` so sign-in works
 * without a local node; after login the node store prefers local when reachable.
 */
export const AUTH_CORE_URL =
	import.meta.env.VITE_AUTH_CORE_URL?.replace(/\/$/, "") || DEFAULT_CORE_URL;
