/**
 * Host-side approval of phone pairings for the desktop.
 *
 * A phone that pairs with an unbound personal node as its owner (node token,
 * no user JWT) starts `pending` and cannot take device-tool calls until the
 * host approves it. Approval is deliberately limited to the node's own
 * machine: `POST /api/device-tools/devices/:id/approve-pair` requires the
 * owner principal over a trusted local peer, so a phone that holds the node
 * token can never approve itself remotely. The desktop reaches its local
 * Core over loopback with the owner token and so can list and approve.
 */

import type { ApiTarget } from "./client.ts";
import {
	approveDevicePairing,
	listDevices,
	type PairedDevice,
} from "./device-tools.ts";

/** The caller's devices still waiting for host approval. */
export async function listPendingDevicePairings(
	target: ApiTarget
): Promise<PairedDevice[]> {
	const { devices } = await listDevices(target);
	return devices.filter((device) => device.state === "pending");
}

/**
 * Approve every listed pending device whose id is in `deviceIds`, in order.
 * Returns the ids that are now active; a device that is no longer pending (or
 * was forgotten meanwhile) is skipped, not an error.
 */
export async function approvePendingDevicePairings(
	target: ApiTarget,
	deviceIds: readonly string[]
): Promise<string[]> {
	const pending = new Set(
		(await listPendingDevicePairings(target)).map((device) => device.device_id)
	);
	const approved: string[] = [];
	for (const deviceId of deviceIds) {
		if (!pending.has(deviceId)) {
			continue;
		}
		const result = await approveDevicePairing(target, deviceId);
		approved.push(result.device_id);
	}
	return approved;
}
