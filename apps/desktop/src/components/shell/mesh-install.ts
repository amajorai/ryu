// apps/desktop/src/components/shell/mesh-install.ts
//
// The shared "Core is installing the network client" watcher for the two
// surfaces that can turn the mesh on: the node selector's Tunnel layer and
// Gateway → Network. Core installs the selected Tailscale/Headscale client or
// Tailcat binary itself and starts the sidecar when it lands (`installing: true`
// on `POST /api/mesh/config`), so both surfaces need the same thing — show
// progress, wait, report what actually happened.
//
// One toast SLOT, not one toast per call: sileo has no caller-supplied id, so the
// live progress toast is tracked here and dismissed before another is raised.
// Without that, two enables (or an enable from each surface) leave a progress
// toast on screen that nothing ever expires.
//
// Byte-level progress is NOT duplicated here — the install registers with the
// download center, so the existing downloads overlay already shows the transfer.
// This only answers "did it work", which the overlay cannot.

import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchMeshInstallStatus,
	fetchMeshStatus,
	MESH_BACKEND_TAILCAT,
	type MeshBackend,
	type MeshStatus,
} from "@/src/lib/api/mesh.ts";

/** How often the mesh status is re-read while the install runs. */
const POLL_INTERVAL_MS = 3000;
/**
 * When to stop waiting. Generous because the leg decides the duration: a ~38 MB
 * archive over a bad link, or a `brew install tailscale` that decides to update
 * Homebrew first. Hitting it is not a failure verdict — the install may still
 * land, so the message says so rather than claiming it broke.
 */
const INSTALL_DEADLINE_MS = 10 * 60 * 1000;

/** The live progress toast, so a second call replaces it instead of stacking. */
let progressToastId: string | null = null;

function dismissProgress(): void {
	if (progressToastId !== null) {
		sileo.dismiss(progressToastId);
		progressToastId = null;
	}
}

/**
 * Wait out a Core-side network client install, toasting progress and the outcome.
 *
 * Resolves with the last status read (or `null` if none could be read), and calls
 * `onStatus` with every successful poll so a caller's own status line settles
 * without a second request.
 *
 * The verdict is `reachable`, not "the download finished": Core starts the daemon
 * itself once the binary lands, and a node that downloaded a client but is not
 * reachable yet is not connected. Reporting success on the download alone
 * would be the same dead end this whole path replaced.
 */
export async function watchMeshInstall(
	target: ApiTarget,
	backend: MeshBackend,
	onStatus?: (status: MeshStatus) => void
): Promise<MeshStatus | null> {
	dismissProgress();
	const isTailcat = backend === MESH_BACKEND_TAILCAT;
	const clientLabel = isTailcat ? "Tailcat" : "Tailscale client";
	progressToastId = sileo.info({
		title: `Installing ${clientLabel}…`,
		description: `Ryu is downloading ${clientLabel} for this node and will connect it when it's ready.`,
		duration: null,
	});

	const deadline = Date.now() + INSTALL_DEADLINE_MS;
	let last: MeshStatus | null = null;
	while (Date.now() < deadline) {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, POLL_INTERVAL_MS);
		});
		let status: MeshStatus;
		let installState: Awaited<
			ReturnType<typeof fetchMeshInstallStatus>
		> | null = null;
		try {
			status = await fetchMeshStatus(target);
			installState = await fetchMeshInstallStatus(target, backend).catch(
				() => null
			);
		} catch {
			// A transient read failure is not a verdict — Core may be busy with the
			// install. Keep waiting until the deadline.
			continue;
		}
		last = status;
		onStatus?.(status);
		if (status.reachable) {
			dismissProgress();
			sileo.success({
				title: isTailcat ? "Tailcat ready" : "Mesh connected",
				description: isTailcat
					? "This node has a short-lived Tailcat address ready to share."
					: status.magicDnsName
						? `This node is on the tailnet as ${status.magicDnsName}.`
						: "This node is on the tailnet.",
			});
			return status;
		}
		// The user turned the mesh back off while we waited — stop, silently. They
		// know what they did; a toast about an install they abandoned is noise.
		if (!status.enabled) {
			dismissProgress();
			return status;
		}
		if (installState?.state === "failed") {
			dismissProgress();
			sileo.error({
				title: `${clientLabel} install failed`,
				description:
					installState.error ?? "Ryu could not install the network client.",
			});
			return status;
		}
	}

	dismissProgress();
	sileo.warning({
		title: "Still setting up the mesh",
		description: `${clientLabel} is taking a while to install. Check the downloads overlay — this node will connect once it finishes.`,
	});
	return last;
}
