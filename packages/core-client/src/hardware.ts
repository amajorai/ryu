// packages/core-client/src/hardware.ts
//
// Typed client for the Core hardware device-registry API (`/api/hardware/*`,
// PROTOCOL.md §6). This is the NON-realtime surface: pairing, listing, renaming
// and revoking devices. The realtime plane (the BLE<->WSS relay tunnel) lives in
// the mobile app (apps/native/lib/hardware/relay.ts) and speaks the WS protocol
// in `@ryuhq/protocol/hardware`, not this module.
//
// Wire shapes (RhpPairRequest/Response, RhpDevice, RhpDeviceUpdate) are owned by
// the protocol package so all three mirrors (C / Rust / TS) stay in lockstep —
// we import them here rather than redeclaring. Field names are snake_case to
// match Core's serde shapes exactly, same convention as meetings.ts.
//
// Auth model (do not confuse the two secrets):
//   - These REST calls authenticate with the NODE token (the ApiTarget bearer),
//     exactly like every other core-client module.
//   - `pair` RETURNS a per-device `device_token` — a DIFFERENT secret that the
//     relay later uses as the WS-upgrade Bearer. It is not used here.

import type {
	RhpDevice,
	RhpDeviceUpdate,
	RhpPairRequest,
	RhpPairResponse,
} from "@ryuhq/protocol/hardware";
import { type ApiTarget, request } from "./client.ts";

export type {
	RhpDevice,
	RhpDeviceUpdate,
	RhpPairRequest,
	RhpPairResponse,
} from "@ryuhq/protocol/hardware";

/**
 * Pair a freshly-scanned device to the signed-in user's node.
 *
 * The node verifies `pairing_nonce` against what the device advertised, registers
 * the device, and returns the per-device `device_token` + the `node_url` the
 * device (or the relay on its behalf) should connect the WS to.
 */
export async function pairDevice(
	target: ApiTarget,
	body: RhpPairRequest
): Promise<RhpPairResponse> {
	return await request<RhpPairResponse>(target, "/api/hardware/pair", {
		method: "POST",
		body,
	});
}

/** List the devices registered to this node, with live status. */
export async function listDevices(target: ApiTarget): Promise<RhpDevice[]> {
	const json = await request<{ devices?: RhpDevice[] } | RhpDevice[]>(
		target,
		"/api/hardware/devices"
	);
	if (Array.isArray(json)) {
		return json;
	}
	return json.devices ?? [];
}

/** Rename a device or update its prefs. */
export async function updateDevice(
	target: ApiTarget,
	deviceId: string,
	update: RhpDeviceUpdate
): Promise<RhpDevice> {
	const json = await request<{ device?: RhpDevice } | RhpDevice>(
		target,
		`/api/hardware/devices/${deviceId}`,
		{ method: "PATCH", body: update }
	);
	if ("device_id" in json) {
		return json;
	}
	if (json.device) {
		return json.device;
	}
	throw new Error("update returned no device");
}

/** Revoke a device's token and unregister it from the node. */
export async function revokeDevice(
	target: ApiTarget,
	deviceId: string
): Promise<void> {
	await request(target, `/api/hardware/devices/${deviceId}`, {
		method: "DELETE",
	});
}
