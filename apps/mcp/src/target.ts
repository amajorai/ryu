// Build a single ApiTarget for the running Ryu Core node from the environment.
//
// RYU_CORE_URL  - base URL of the Core node (profile-aware by default)
// RYU_CORE_TOKEN - explicit bearer for the target node; when unset, a loopback
// target uses this machine's node-auth.token and a remote target gets no header
// RYU_DIR       - Core's relocated data directory for that local token file
//
// The token now falls back to the one Core mints at `<ryu_home>/node-auth.token`
// (see `resolveLocalNodeToken`). Core authenticates its local API by default, so
// an MCP server launched by hand — not spawned by Core, and therefore not
// inheriting `RYU_TOKEN` — would otherwise 401 on every call.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { resolveLocalNodeToken } from "@ryuhq/core-client/node-token";

const ryuProfile = (process.env.RYU_PROFILE ?? "").trim().toLowerCase();
const PROFILE_PORT_OFFSETS = new Map([
	["beta", 4000],
	["canary", 2000],
	["dev", 1000],
	["nightly", 3000],
	["release", 0],
]);

export function coreUrlForProfile(profile: string): string {
	const normalized = profile.trim().toLowerCase();
	const offset = PROFILE_PORT_OFFSETS.get(normalized) ?? 0;
	return `http://127.0.0.1:${7980 + offset}`;
}

export const DEFAULT_CORE_URL = coreUrlForProfile(ryuProfile);

export const buildTarget = (): ApiTarget => {
	const url = process.env.RYU_CORE_URL?.trim() || DEFAULT_CORE_URL;
	// The URL is passed so the MINTED token is only ever sent to a local Core:
	// `RYU_CORE_URL` can point anywhere, and this machine's node secret must not
	// travel to a remote host.
	return { url, token: resolveLocalNodeToken(url) };
};
