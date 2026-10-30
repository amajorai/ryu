import { decideUpdateEligibility } from "@ryu/auth/lib/plans";
import { notifyUpdateOutsideWindow } from "@/src/components/updater/AutoUpdater-window-notices.ts";
import { resolveAppUpdateSource } from "@/src/components/updater/app-update-policy.ts";
import type { UpdateCheck } from "@/src/lib/api/update.ts";
import { prepareAppUpdate } from "@/src/lib/app-update-preparation.ts";
import {
	getReleaseChannel,
	type ReleaseChannel,
} from "@/src/lib/release-channel.ts";
import { getUpdatesCutoffMs } from "@/src/lib/updates-window.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";

/**
 * Whether this release can honestly be booked for the quiet hour.
 *
 * A deferral only means anything if the build that lands later is the one the
 * user agreed to now, and that requires all three:
 *
 * - a LOCAL node answered. The verdict is replayed hours later without a
 *     re-check, so a remote node's `tag` would let it choose which signed Ryu
 *     build lands on this machine — the exposure `canPinInstall` exists to
 *     deny. The live "Update now" path is not exposed the same way: it resolves
 *     the static feed, which always yields genuine-latest whatever a node says.
 * - a `tag`. Without one there is nothing to pin to, and the install would
 *     fall through to the static feed and deliver whatever is newest at 03:00.
 * - a FIXED channel. `nightly` / `canary` are rolling pointers, so pinning to
 *     one installs whatever it holds at the window — the unpinned behaviour
 *     with extra steps.
 *
 * Exported so the surface can hide the offer rather than fail at the window.
 * Not offering a promise you cannot keep is the whole point of this feature.
 */
export function canDeferAppUpdate(
	verdict: UpdateCheck,
	node: { url: string } | undefined
): boolean {
	const channel = getReleaseChannel();
	return (
		node !== undefined &&
		isLocalNode(node) &&
		(verdict.tag ?? "") !== "" &&
		channel !== "nightly" &&
		channel !== "canary"
	);
}
export interface AppUpdateOptions {
	node?: { url: string };
	pinned?: boolean;
}

export function isEligibleForAppUpdate(verdict: UpdateCheck): boolean {
	const releasedAtMs = verdict.published_at
		? Date.parse(verdict.published_at)
		: Number.NaN;
	const eligibility = decideUpdateEligibility({
		cutoffMs: getUpdatesCutoffMs(),
		nowMs: Date.now(),
		releasePublishedAtMs: Number.isFinite(releasedAtMs) ? releasedAtMs : null,
	});
	return eligibility.eligible || verdict.cutoff_waived_for_security === true;
}

function sourceForUpdate(verdict: UpdateCheck, options?: AppUpdateOptions) {
	const channel = getReleaseChannel();
	if (verdict.restricted_by_cutoff) {
		const tag = verdict.tag ?? "";
		return resolveAppUpdateSource({
			channel,
			pin: {
				allowed: canPinInstall(verdict, tag, channel, options?.node),
				kind: "required",
				tag,
			},
		});
	}
	if (options?.pinned) {
		return resolveAppUpdateSource({
			channel,
			pin: {
				allowed: canDeferAppUpdate(verdict, options.node),
				kind: "required",
				tag: verdict.tag ?? "",
			},
		});
	}
	return resolveAppUpdateSource({
		channel,
		latest: {
			fromLocalNode: options?.node !== undefined && isLocalNode(options.node),
			tag: verdict.tag,
			version: verdict.latest,
		},
		pin: { kind: "none" },
	});
}

export async function prepareUpdate(
	verdict: UpdateCheck,
	options?: AppUpdateOptions
) {
	if (!isEligibleForAppUpdate(verdict)) {
		notifyUpdateOutsideWindow(verdict);
		return null;
	}
	const source = sourceForUpdate(verdict, options);
	if (!source) {
		return null;
	}
	return prepareAppUpdate({
		expectedVersion: verdict.latest,
		source,
	});
}

/**
 * Whether a clamped verdict may be installed by pinning to `verdict.tag`.
 *
 * Every input is a fact the CLIENT owns — never a flag the node asserted.
 * `checkForUpdate` accepts an arbitrary node URL, so a hostile or compromised
 * node could otherwise choose which signed Ryu build lands on this machine, and
 * signature verification does not help when the attacker is picking among
 * legitimately signed releases.
 */
function canPinInstall(
	verdict: UpdateCheck,
	tag: string,
	channel: ReleaseChannel,
	node: { url: string } | undefined
): boolean {
	if (node === undefined || !isLocalNode(node)) {
		return false;
	}
	const cutoffMs = getUpdatesCutoffMs();
	const publishedAtMs = verdict.published_at
		? Date.parse(verdict.published_at)
		: Number.NaN;
	// A security-waived release is published STRICTLY AFTER the cutoff by
	// construction (Core only waives to a marked release newer than the window),
	// so the at-or-before test below is its exact complement: without this
	// allowance the waiver could never install and the whole escape hatch would be
	// inert — a lapsed owner would never receive a security fix.
	//
	// This is the one node-asserted input we accept, and the exposure is bounded:
	// the pin resolves to `releases/download/<tag>/…` on Ryu's own repo, the tag
	// charset is validated in Rust, minisign verification is unchanged, and
	// tauri-plugin-updater refuses any version not strictly newer than the running
	// one. So a hostile node can at most choose among genuinely signed Ryu
	// releases newer than the current build — it cannot downgrade or substitute.
	const withinWindow =
		Number.isFinite(publishedAtMs) &&
		cutoffMs !== null &&
		publishedAtMs <= cutoffMs;
	return (
		cutoffMs !== null &&
		(withinWindow || verdict.cutoff_waived_for_security === true) &&
		tag !== "" &&
		// A rolling pointer (`nightly` / `canary`) does not identify a specific
		// build, so pinning to it is meaningless — it would install whatever the
		// pointer currently holds.
		channel !== "nightly" &&
		channel !== "canary"
	);
}
