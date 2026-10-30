import { installUpdate } from "@/src/components/updater/AutoUpdater-install.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	applyNodeUpdate,
	scheduleNodeUpdate,
	type UpdateCheck,
} from "@/src/lib/api/update.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";

/**
 * Apply the release-train update to the node the user is looking at.
 *
 * The single definition of "which updater is the right one", because it is not
 * always this app's: Core, Gateway and the CLI ship INSIDE the desktop bundle,
 * so for a local node the native updater moves all of them together. For a
 * remote node (a cloud or LAN Core) that same updater would replace the local
 * app and leave the remote binaries untouched — there the node must update
 * itself through `POST /api/update/apply`.
 *
 * Returns a message when it did remote work, `null` when the native updater took
 * over (it owns its own progress toasts and relaunch).
 */
/**
 * Defer a REMOTE node's update to that node's next quiet hour.
 *
 * Only meaningful for a node the desktop does not own. A local node's update
 * ships inside this app bundle and is installed by the native updater, which
 * has its own restart flow — there is nothing on the node to defer.
 *
 * Returns a human sentence naming the time AND the zone. "03:00" alone is the
 * ambiguity deferring exists to remove: the node's zone is usually not the
 * viewer's, and a user in Singapore scheduling a Frankfurt node means
 * Frankfurt's night.
 */
export async function scheduleReleaseUpdate(
	target: ApiTarget,
	node: { url: string },
	verdict: UpdateCheck
): Promise<string> {
	if (isLocalNode(node)) {
		throw new Error(
			"This node updates with the app itself, so there is nothing to schedule."
		);
	}
	if (!verdict.asset) {
		throw new Error(
			`No install asset published for v${verdict.latest} on this node's platform.`
		);
	}
	const pending = await scheduleNodeUpdate(
		target,
		verdict.asset,
		verdict.latest
	);
	const when = formatDateTime(pending.scheduled_for);
	return `v${pending.version} will install at ${when} (${pending.time_zone}).`;
}

export async function applyReleaseUpdate(
	target: ApiTarget,
	node: { url: string },
	verdict: UpdateCheck
): Promise<string | null> {
	if (!isLocalNode(node)) {
		if (!verdict.asset) {
			throw new Error(
				`No install asset published for v${verdict.latest} on this node's platform.`
			);
		}
		// `POST /api/update/apply` is deliberately ungated: the caller supplies the
		// asset URL, so an entitlement check there would be theatre. Do not "fix"
		// it — see docs/auto-update.md.
		const result = await applyNodeUpdate(target, verdict.asset);
		return result.message;
	}
	await installUpdate(verdict, { node });
	return null;
}
