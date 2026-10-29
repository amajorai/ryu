// packages/core-client/src/hardware.ts
//
// Typed client for the Core hardware device-registry API (`/api/hardware/*`,
// PROTOCOL.md §6). This is the NON-realtime surface: pairing (legacy v1 and the
// v1.1 begin/reveal/confirm/cancel flow), listing, renaming, revoking devices and
// resetting the node's hardware identity. The realtime plane (the BLE<->WSS relay tunnel) lives in
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
//   - legacy `pair` RETURNS a per-device `device_token` — a DIFFERENT secret that
//     a v1 relay later uses as the WS-upgrade Bearer. It is not used here.
//   - v2 `pairConfirm` returns only a WS-only `relay_token` for this phone plus
//     credentials sealed to the device; the phone never sees the device token.
//
// Pairing v2 errors are `{"error":{"code","message"}}`; they surface as a
// HardwareApiError whose `code` the pairing UI maps to user-facing copy.

import type {
	RhpDevice,
	RhpDeviceUpdate,
	RhpIdentityResetResponse,
	RhpNodeIdentityStatus,
	RhpPairBeginRequest,
	RhpPairBeginResponse,
	RhpPairCancelRequest,
	RhpPairConfirmRequest,
	RhpPairConfirmResponse,
	RhpPairRequest,
	RhpPairResponse,
	RhpPairRevealRequest,
	RhpPairRevealResponse,
} from "@ryuhq/protocol/hardware";
import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import {
	ApiError,
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "./client.ts";

export type {
	RhpDevice,
	RhpDeviceCapabilitySummary,
	RhpDevicePrefs,
	RhpDeviceUpdate,
	RhpIdentityResetResponse,
	RhpNodeIdentityStatus,
	RhpPairBeginRequest,
	RhpPairBeginResponse,
	RhpPairCancelRequest,
	RhpPairConfirmRequest,
	RhpPairConfirmResponse,
	RhpPairRequest,
	RhpPairResponse,
	RhpPairRevealRequest,
	RhpPairRevealResponse,
} from "@ryuhq/protocol/hardware";

// Complete native REST models from crates/core/hardware/src/protocol.rs.
// Keep original decoded values and additive metadata after validating every field.
function hardwareResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const hardwareNumberSchema = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
export const hardwarePairResponseSchema = hardwareResponse(
	z.object({ device_token: z.string(), node_url: z.string() })
);
// v1.1 device fields are optional so an older node (which omits them) still
// validates; a present field must have the documented shape.
const hardwareCapabilitySummarySchema = z.looseObject({
	name: z.string(),
	description: z.string(),
	sensitive: z.boolean(),
	confirm: z.string(),
	enabled: z.boolean(),
});
export const hardwareDeviceSchema = hardwareResponse(
	z.object({
		device_id: z.string(),
		type: z.enum(["watch", "necklace", "desk"]),
		name: z.string(),
		last_seen: hardwareNumberSchema.nullable(),
		online: z.boolean(),
		battery_pct: hardwareNumberSchema.nullable(),
		protocol_level: z.number().optional(),
		secure: z.boolean().optional(),
		key_verification: z.string().nullable().optional(),
		key_source: z.string().nullable().optional(),
		key_fingerprint: z.string().nullable().optional(),
		needs_repair: z.boolean().optional(),
		capabilities: z.array(hardwareCapabilitySummarySchema).optional(),
		prefs: z.record(z.string(), z.json()).optional(),
	})
);
export const hardwareNodeIdentitySchema = z.looseObject({
	status: z.string(),
	fingerprint: z.string().nullable().optional(),
});
// Old node/client wire versions expose direct arrays and omission-friendly envelopes.
const hardwareDevicesResponseSchema = hardwareResponse(
	z.union([
		z.array(hardwareDeviceSchema),
		z.object({
			devices: z.array(hardwareDeviceSchema).optional(),
			node_identity: hardwareNodeIdentitySchema.optional(),
		}),
	])
);
// `device_id` belongs exclusively to the complete direct-device variant: do not
// admit an incomplete direct device through the legacy envelope's missing key.
const hardwareLegacyUpdateFields = z.object({
	device: hardwareDeviceSchema.optional(),
	ok: z.boolean().optional(),
});
const hardwareLegacyUpdateSchema = z.custom<
	z.output<typeof hardwareLegacyUpdateFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		hardwareLegacyUpdateFields.safeParse(value).success &&
		!("device_id" in Object.call(undefined, value))
);
const hardwareUpdateResponseSchema = hardwareResponse(
	z.union([hardwareDeviceSchema, hardwareLegacyUpdateSchema])
);
const hardwareRevokeResponseSchema = hardwareResponse(
	z.object({ ok: z.boolean() })
);
export const hardwarePairBeginResponseSchema = hardwareResponse(
	z.object({
		pairing_id: z.string().min(1),
		node_pub: z.string().min(1),
		node_fingerprint: z.string(),
		expires_in: z.number(),
	})
);
export const hardwarePairRevealResponseSchema = hardwareResponse(
	z.object({
		sas: z.string().regex(/^\d{6}$/),
		transcript_hash: z.string(),
		device_fingerprint: z.string(),
	})
);
export const hardwarePairConfirmResponseSchema = hardwareResponse(
	z.object({
		relay_token: z.string().min(1),
		sealed_credentials: z.string().min(1),
		device: hardwareDeviceSchema,
	})
);
const hardwarePairCancelResponseSchema = hardwareResponse(
	z.object({ ok: z.boolean() })
);
export const hardwareIdentityResetResponseSchema = hardwareResponse(
	z.object({
		node_fingerprint: z.string(),
		devices_needing_repair: z.union([z.number(), z.array(z.string())]),
	})
);

/**
 * A non-2xx hardware response. `code` is the machine code from Core's
 * `{"error":{"code","message"}}` body (for example `commitment_mismatch`), or
 * undefined when the node returned no structured error (an older node answers a
 * v2 route with a bare 404).
 */
export class HardwareApiError extends ApiError {
	readonly code: string | undefined;

	constructor(
		path: string,
		status: number,
		code: string | undefined,
		message: string | undefined
	) {
		super(path, status, message);
		this.name = "HardwareApiError";
		this.code = code;
	}
}

const hardwareErrorBodySchema = z.object({
	error: z.union([
		z.string(),
		z.object({ code: z.string(), message: z.string().optional() }),
	]),
});

function hardwareErrorFromBody(text: string): {
	code: string | undefined;
	message: string | undefined;
} {
	try {
		const parsed = hardwareErrorBodySchema.safeParse(JSON.parse(text));
		if (!parsed.success) {
			return { code: undefined, message: undefined };
		}
		const { error } = parsed.data;
		return typeof error === "string"
			? { code: undefined, message: error }
			: { code: error.code, message: error.message };
	} catch {
		return { code: undefined, message: undefined };
	}
}

/** POST a hardware route, keeping the structured error code on failure. */
async function hardwarePost<T>(
	target: ApiTarget,
	path: string,
	body: object,
	responseCodec: z.ZodType<T>
): Promise<T> {
	const response = await fetchForTarget(target)(apiUrl(target, path), {
		method: "POST",
		headers: makeHeaders(target.token, target.userJwt),
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) {
		const { code, message } = hardwareErrorFromBody(text);
		throw new HardwareApiError(path, response.status, code, message);
	}
	return responseCodec.parse(text ? JSON.parse(text) : undefined);
}

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
	return await request(
		target,
		"/api/hardware/pair",
		{
			method: "POST",
			body,
		},
		hardwarePairResponseSchema
	);
}

/**
 * Pairing v2 step 4: open a pending pairing for the device key and commitment
 * read from `pairing_info`. A node without pairing v2 answers 404.
 */
export async function pairBegin(
	target: ApiTarget,
	body: RhpPairBeginRequest
): Promise<RhpPairBeginResponse> {
	return await hardwarePost(
		target,
		"/api/hardware/pair/begin",
		body,
		hardwarePairBeginResponseSchema
	);
}

/**
 * Pairing v2 step 6: reveal the device's random value. The node checks it
 * against the commitment and returns the 6-digit code the user compares.
 */
export async function pairReveal(
	target: ApiTarget,
	body: RhpPairRevealRequest
): Promise<RhpPairRevealResponse> {
	return await hardwarePost(
		target,
		"/api/hardware/pair/reveal",
		body,
		hardwarePairRevealResponseSchema
	);
}

/**
 * Pairing v2 step 9: send the device's press-bound confirm tag and the user's
 * decision. Call it only after BOTH have arrived.
 */
export async function pairConfirm(
	target: ApiTarget,
	body: RhpPairConfirmRequest
): Promise<RhpPairConfirmResponse> {
	return await hardwarePost(
		target,
		"/api/hardware/pair/confirm",
		body,
		hardwarePairConfirmResponseSchema
	);
}

/** Cancel a pending pairing (idempotent). `mismatch` is logged as a warning. */
export async function pairCancel(
	target: ApiTarget,
	body: RhpPairCancelRequest
): Promise<void> {
	await hardwarePost(
		target,
		"/api/hardware/pair/cancel",
		body,
		hardwarePairCancelResponseSchema
	);
}

/**
 * Regenerate the node's hardware identity. Every end-to-end paired device then
 * needs to be paired again.
 */
export async function resetHardwareIdentity(
	target: ApiTarget
): Promise<RhpIdentityResetResponse> {
	return await hardwarePost(
		target,
		"/api/hardware/identity/reset",
		{},
		hardwareIdentityResetResponseSchema
	);
}

/** The device list plus the node identity status, when the node reports it. */
export interface HardwareDeviceListing {
	devices: RhpDevice[];
	node_identity: RhpNodeIdentityStatus | null;
}

/** List devices together with the node identity status (v1.1 nodes). */
export async function listDevicesWithIdentity(
	target: ApiTarget
): Promise<HardwareDeviceListing> {
	const json = await request(
		target,
		"/api/hardware/devices",
		{},
		hardwareDevicesResponseSchema
	);
	if (Array.isArray(json)) {
		return { devices: json, node_identity: null };
	}
	return {
		devices: json.devices ?? [],
		node_identity: json.node_identity ?? null,
	};
}

/** List the devices registered to this node, with live status. */
export async function listDevices(target: ApiTarget): Promise<RhpDevice[]> {
	return (await listDevicesWithIdentity(target)).devices;
}

/** Rename a device or update its prefs. */
export async function updateDevice(
	target: ApiTarget,
	deviceId: string,
	update: RhpDeviceUpdate
): Promise<RhpDevice> {
	const json = await request(
		target,
		`/api/hardware/devices/${deviceId}`,
		{ method: "PATCH", body: update },
		hardwareUpdateResponseSchema
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
	await request(
		target,
		`/api/hardware/devices/${deviceId}`,
		{
			method: "DELETE",
		},
		hardwareRevokeResponseSchema
	);
}
