// Node compatibility for the desktop.
//
// The implementation moved to `@ryuhq/core-client/node-compat` so every surface
// shares one answer. It used to live here and ONLY here, which meant the island,
// mobile, TUI, web and extension had no version awareness at all — they drove
// whatever node they were pointed at and failed in whatever way that particular
// mismatch happened to fail.
//
// Re-exported (rather than deleted) so the existing desktop call sites and this
// module's tests keep working unchanged. Behaviour is identical: a minimum-version
// floor plus capability negotiation instead of a compatibility matrix, both
// fail-soft, and every verdict advisory — the desktop and a *local* node move in
// lockstep (one release train, and a lapsed-updates install pins both), so the
// real skew is a *remote* node on its own release schedule.

import { assessNode } from "@ryuhq/core-client/node-compat.ts";

export {
	assessNode,
	channelOf,
	compareSemver,
	fetchNodeIdentity,
	hasCapability,
	isNodeCompatible,
	MIN_CORE_VERSION,
	type NodeCompatibility,
	type NodeIdentity,
	STABLE_CHANNEL,
} from "@ryuhq/core-client/node-compat.ts";

/**
 * Whether the desktop and the node it is driving are on different release
 * channels — e.g. a stable app pointed at a canary node.
 *
 * Kept as a desktop-level helper because the announcement/preflight UI wants just
 * this one axis, named for the two sides it compares; {@link assessNode} is the
 * full verdict.
 */
export function channelMismatch(
	desktopVersion: string | null | undefined,
	nodeVersion: string | null | undefined
): { desktop: string; node: string } | null {
	const verdict = assessNode(desktopVersion, {
		status: "ok",
		version: nodeVersion ?? null,
	});
	if (!verdict.channelMismatch) {
		return null;
	}
	return {
		desktop: verdict.channelMismatch.client,
		node: verdict.channelMismatch.node,
	};
}
