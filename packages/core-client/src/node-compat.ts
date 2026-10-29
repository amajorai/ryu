// packages/core-client/src/node-compat.ts
//
// Whether a client can talk to the node it is pointed at — shared by EVERY
// surface rather than reimplemented per app.
//
// This lived only in `apps/desktop/src/lib/node-compat.ts`, so the island,
// mobile, TUI, web and extension had no version awareness at all: they would
// happily drive a node years newer or older than themselves and fail in whatever
// way that particular mismatch happened to fail. `packages/core-client` is the
// one module all seven already import, so the check belongs here.
//
// Two rules govern everything below, and both are deliberate:
//
//   1. WARN, NEVER BLOCK. A mismatch is always advisory. Refusing to connect can
//      lock someone out of their own node mid-upgrade, and driving a newer node
//      from an older client is a legitimate thing to do — it is how you test a
//      canary node from a stable app.
//   2. FAIL SOFT. Anything unknown (absent version, unparseable version, no
//      capability list) resolves to "fine". A node that predates a field must not
//      be reported as broken because it did not answer a question nobody used to
//      ask.
//
// Feature gating is a SEPARATE question and is answered by `capabilities`, not by
// version arithmetic — see `hasCapability`. That is what lets a client whose
// update window has lapsed keep working against a newer node: it asks what the
// node can do rather than deciding from a version number.

import type { ApiTarget } from "./client.ts";
import { request } from "./client.ts";
import { systemHealthResponseSchema } from "./system.ts";

/** The channel name for a build with no prerelease suffix. */
export const STABLE_CHANNEL = "stable";

/** The oldest Core version a client fully supports. Bump ONLY on a breaking API
 *  change — capability flags, not this floor, are how ordinary features are
 *  gated. */
export const MIN_CORE_VERSION = "0.0.1";

/** What `/api/health` reports about the node on the other end. */
export interface NodeIdentity {
	/** Advertised capability flags. Absent on nodes predating advertisement. */
	capabilities?: string[];
	/** Release channel (`stable` / `beta` / `nightly` / `canary`). Absent on nodes
	 *  predating the field — derive it from `version` instead. */
	channel?: string | null;
	status: string;
	/** Core's version. Null on older nodes that do not report one. */
	version?: string | null;
}

/** Parse "1.2.3" (or "v1.2.3") → [1,2,3]. Null if unparseable.
 *
 *  Deliberately ignores any prerelease suffix: a canary build of 0.0.18 really
 *  does clear a 0.0.18 floor. Channel is a separate axis — see `channelOf`. */
function parseSemver(v: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim().replace(/^v/, ""));
	if (!match) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1 if a<b, 0 if equal, 1 if a>b. Unparseable inputs compare equal (fail-soft). */
export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!(pa && pb)) {
		return 0;
	}
	for (let i = 0; i < 3; i++) {
		const aPart = pa[i] ?? 0;
		const bPart = pb[i] ?? 0;
		if (aPart !== bPart) {
			return aPart < bPart ? -1 : 1;
		}
	}
	return 0;
}

/**
 * The release channel a version belongs to: the first identifier of its semver
 * prerelease, or `"stable"` when there is none.
 *
 * Mirrors Core's `channel_of` (apps/core/src/update/mod.rs) exactly, so both
 * sides agree on what a build is with nothing stored anywhere — a build is
 * self-describing.
 */
export function channelOf(version: string | null | undefined): string {
	if (!version) {
		return STABLE_CHANNEL;
	}
	const normalized = version.trim().replace(/^v/, "");
	const dash = normalized.indexOf("-");
	if (dash === -1) {
		return STABLE_CHANNEL;
	}
	// Strip build metadata (`+sha`) before reading the prerelease.
	const pre = normalized.slice(dash + 1).split("+")[0] ?? "";
	const first = pre.split(".")[0]?.trim();
	return first || STABLE_CHANNEL;
}

/**
 * Whether a node's version clears the client's floor. Unknown ⇒ compatible.
 */
export function isNodeCompatible(version: string | null | undefined): boolean {
	if (!version) {
		return true;
	}
	return compareSemver(version, MIN_CORE_VERSION) >= 0;
}

/**
 * Whether a node advertises a capability.
 *
 * A node reporting NO capability list predates advertisement, and is treated as
 * having everything — otherwise upgrading the client would silently hide features
 * that actually work. The version floor warns about such nodes separately.
 */
export function hasCapability(
	capabilities: string[] | undefined,
	cap: string
): boolean {
	if (!capabilities || capabilities.length === 0) {
		return true;
	}
	return capabilities.includes(cap);
}

/** A verdict about the client↔node pairing. Every field is advisory. */
export interface NodeCompatibility {
	/** Node reports a version OLDER than the client's floor. */
	belowFloor: boolean;
	/** Node is on a different release channel than the client. */
	channelMismatch: { client: string; node: string } | null;
	/** Node is NEWER than the client. The interesting direction for a client whose
	 *  update window has lapsed: the node may expose features this build cannot
	 *  render, which is a prompt to extend updates, not an error. */
	nodeIsNewer: boolean;
	/** True when nothing is wrong. */
	ok: boolean;
}

/**
 * Assess a client against the node it is driving.
 *
 * `clientVersion` is the surface's own version (the desktop's app version, the
 * mobile bundle's, …). Pass null when a surface genuinely has no version of its
 * own; the channel and newer-node checks then no-op rather than guessing.
 */
export function assessNode(
	clientVersion: string | null | undefined,
	node: NodeIdentity | null | undefined
): NodeCompatibility {
	const ok: NodeCompatibility = {
		belowFloor: false,
		channelMismatch: null,
		nodeIsNewer: false,
		ok: true,
	};
	if (!node?.version) {
		return ok;
	}

	const belowFloor = !isNodeCompatible(node.version);

	// Prefer the channel the node reports; fall back to deriving it, so a node
	// predating the `channel` field still participates.
	const nodeChannel = node.channel?.trim() || channelOf(node.version);
	let channelMismatch: { client: string; node: string } | null = null;
	let nodeIsNewer = false;
	if (clientVersion) {
		const clientChannel = channelOf(clientVersion);
		if (clientChannel !== nodeChannel) {
			channelMismatch = { client: clientChannel, node: nodeChannel };
		}
		nodeIsNewer = compareSemver(node.version, clientVersion) > 0;
	}

	return {
		belowFloor,
		channelMismatch,
		nodeIsNewer,
		ok: !(belowFloor || channelMismatch || nodeIsNewer),
	};
}

/**
 * Read the node's identity from `/api/health`.
 *
 * Every field is optional because this endpoint has grown over time and a client
 * must keep working against a node that predates any of them.
 */
export async function fetchNodeIdentity(
	target: ApiTarget
): Promise<NodeIdentity> {
	const json = await request(
		target,
		"/api/health",
		{},
		systemHealthResponseSchema
	);
	return {
		capabilities: json.capabilities,
		channel: json.channel ?? null,
		status: json.status ?? "ok",
		version: json.version ?? null,
	};
}
