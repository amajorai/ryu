// Resolve the bearer a LOCAL surface should present to its own Core node.
//
// Core mints a node-admittance token on first boot and persists it at
// `<data dir>/secrets/node-auth.token` (see `apps/core/src/node_token.rs`). Before that,
// a default install ran with no token at all and Core's `require_auth` let every
// request through — so any process on the machine could drive the whole local
// API. Now that a token exists, a surface that does not present it gets a 401.
//
// Surfaces Core SPAWNS (sidecars, ACP agents, the gateway) inherit `RYU_TOKEN`
// from Core's environment and need none of this. Surfaces that run as their own
// process — the TUI, the MCP server, the CLI, the desktop — are not children of
// Core, so they read the file instead.
//
// NODE-ONLY. This imports `node:fs`/`node:os` and must never be pulled into a
// browser bundle; browser surfaces (the webapp, the extension) cannot read a
// local file at all and pair with the node explicitly instead.

import { readFileSync } from "node:fs";

import { type DataDirEnvironment, ryuHomeDir, secretPath } from "./data-dir.ts";

// Re-exported so existing callers keep one import for "where is Core's data".
export { ryuHomeDir } from "./data-dir.ts";

/** Path to the token Core mints: `<data dir>/secrets/node-auth.token`. */
export function nodeAuthTokenPath(
	env: DataDirEnvironment = process.env
): string {
	return secretPath(ryuHomeDir(env), "node-auth.token");
}

/**
 * True when `url` addresses Core on THIS machine — the only node whose token
 * lives on local disk.
 *
 * Parsed with `URL` rather than by string matching, because hand-rolled parsing
 * gets this wrong in a way that LEAKS the token: in `http://localhost:80@evil.com/`
 * the `localhost:80` part is USERINFO and the real host is `evil.com`.
 * `URL.hostname` strips userinfo, so this sees the authority the request will
 * actually reach. Fails closed on anything that will not parse.
 */
export function isLocalCoreUrl(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return false;
	}
	// `URL` keeps IPv6 literals bracketed; a trailing dot is the DNS root and
	// resolves identically, so normalize both before comparing.
	const host = hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * The bearer to present to the Core at `coreUrl`, or `null` when there is none.
 *
 * Precedence mirrors Core's own resolution so a surface can never disagree with
 * the node it is talking to:
 *   1. `RYU_CORE_TOKEN` — the explicit per-surface override (an operator
 *      pointing a TUI at a REMOTE node, with that node's token).
 *   2. `RYU_TOKEN` — an operator-provisioned node token; this is what Core
 *      itself prefers, and spawned children inherit it. Under the shared-fleet
 *      convention the same value is installed on every node, so it is valid to
 *      send to a remote node too.
 *   3. `<data dir>/secrets/node-auth.token` — the token Core MINTED for itself. This one
 *      is machine-local, so it is only used when `coreUrl` is local.
 *
 * That last gate is the security-relevant one. `RYU_CORE_URL` is operator- (or
 * attacker-) controlled; without it, pointing a surface at a remote host would
 * transmit this machine's node-admittance secret to that host, which would then
 * hold full access to the local node. The remote would reject it anyway, so the
 * gate costs nothing. Callers that cannot name a URL get the env tiers only.
 *
 * Returns `null` rather than throwing when the file is absent or unreadable:
 * that is the legitimate "Core has not booted yet" state, and a null bearer is
 * exactly what Core accepts when it has no token configured either.
 */
export function resolveLocalNodeToken(coreUrl?: string): string | null {
	const explicit = process.env.RYU_CORE_TOKEN?.trim();
	if (explicit) {
		return explicit;
	}
	const inherited = process.env.RYU_TOKEN?.trim();
	if (inherited) {
		return inherited;
	}
	return readMintedNodeToken(coreUrl);
}

/**
 * Only the third tier of {@link resolveLocalNodeToken}: the token Core minted in
 * the data directory `env` names, and only when `coreUrl` is this machine.
 * For a caller that must not pick up `RYU_CORE_TOKEN` (which may be a REMOTE
 * node's token), such as the CLI's identity broker for a remote target.
 */
export function readMintedNodeToken(
	coreUrl: string | undefined,
	env: DataDirEnvironment = process.env
): string | null {
	// Fail closed: with no URL to check, never risk sending the minted token to
	// something that is not this machine.
	if (coreUrl === undefined || !isLocalCoreUrl(coreUrl)) {
		return null;
	}
	try {
		const raw = readFileSync(nodeAuthTokenPath(env), "utf8").trim();
		return raw || null;
	} catch {
		return null;
	}
}
