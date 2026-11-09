// Typed client for Core's device-tools lane ("let Ryu use apps on this
// phone"). Every device-lane action is signed by a key held in the Secure
// Enclave / Android Keystore; this module builds the canonical string, asks the
// platform signer for an ECDSA P-256 signature and sends the exact bytes it
// signed. The signer never leaves the platform layer.
//
// Core side: apps/core/src/device_tools/ and
// apps/core/src/server/device_tools_api/. Internal design: docs/device-tools.md.

import {
	type ClientDevice,
	DEVICE_CLIENT_ID_HEADER,
	DEVICE_SIGNATURE_HEADER,
	DEVICE_TIMESTAMP_HEADER,
	type DeviceClaimResponse,
	type DeviceConfirmResponse,
	type DeviceToolResult,
	deviceCanonicalString,
	deviceClaimResponseSchema,
	deviceConfirmMessage,
	deviceConfirmResponseSchema,
	deviceToolCapsSchema,
	type HomeAccessoryReport,
} from "@ryuhq/protocol/device-tools";
import { z } from "zod";
import {
	type ApiTarget,
	apiErrorFromBody,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "./client.ts";

/** The platform signer (Secure Enclave / Keystore / WebCrypto in tests). */
export interface DeviceSigner {
	/** Base64 DER SubjectPublicKeyInfo of the P-256 public key. */
	publicKeySpki(): Promise<string>;
	/**
	 * ECDSA P-256 over SHA-256 of `data`. DER or raw 64-byte r‖s are both
	 * accepted by Core.
	 */
	sign(data: Uint8Array): Promise<Uint8Array>;
}

/** Who and what is signing: the paired row is `(principalId, deviceId)`. */
export interface DeviceIdentity {
	deviceId: string;
	/** From the pair response (`user:<id>` or `owner:local`). */
	principalId: string;
	signer: DeviceSigner;
}

/** Route templates covered by the signature (not full URLs). */
export const DEVICE_ROUTES = {
	chatStream: "/api/chat/stream",
	claim: "/api/device-tools/claim",
	confirm: "/api/device-tools/confirm",
	homeAccessories: "/api/device-tools/home-accessories",
	pair: "/api/device-tools/devices/pair",
	presence: "/api/device-tools/presence",
	result: "/api/chat/client-tool-result",
	stream: "/api/device-tools/stream",
} as const;

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** The three signed-request headers for `body` sent to `route`. */
export async function signDeviceRequest(
	identity: DeviceIdentity,
	route: string,
	body: Uint8Array,
	method = "POST",
	now: () => number = Date.now
): Promise<Record<string, string>> {
	const timestampMs = now();
	const canonical = await deviceCanonicalString({
		body,
		deviceId: identity.deviceId,
		method,
		principalId: identity.principalId,
		route,
		timestampMs,
	});
	const signature = await identity.signer.sign(
		new TextEncoder().encode(canonical)
	);
	return {
		[DEVICE_CLIENT_ID_HEADER]: identity.deviceId,
		[DEVICE_SIGNATURE_HEADER]: toBase64(signature),
		[DEVICE_TIMESTAMP_HEADER]: String(timestampMs),
	};
}

/** Serialize once, sign those bytes, send them. */
async function signedPost<T>(
	target: ApiTarget,
	identity: DeviceIdentity,
	route: string,
	payload: unknown,
	codec: z.ZodType<T>
): Promise<T> {
	const text = JSON.stringify(payload);
	const body = new TextEncoder().encode(text);
	const signed = await signDeviceRequest(identity, route, body);
	const resp = await fetchForTarget(target)(apiUrl(target, route), {
		body: text,
		headers: { ...makeHeaders(target.token, target.userJwt), ...signed },
		method: "POST",
	});
	const responseText = await resp.text();
	if (!resp.ok) {
		throw apiErrorFromBody(route, resp.status, responseText);
	}
	return codec.parse(responseText ? JSON.parse(responseText) : undefined);
}

export const pairResponseSchema = z.object({
	device_id: z.string(),
	/** Whether a user-presence confirmation key was registered. */
	confirmations: z.boolean().optional(),
	principal_id: z.string(),
	state: z.enum(["active", "pending"]),
});
export type PairResponse = z.infer<typeof pairResponseSchema>;

/**
 * Pair this device. Signed with the key being registered; `principalId` is
 * the principal the caller expects (`owner:local` on a token-only personal
 * node, else `user:<id>`). A `pending` device must be approved on the host.
 */
export function pairDevice(
	target: ApiTarget,
	identity: DeviceIdentity,
	device: {
		app: "ryu-bot" | "ryu-native";
		attestation?: string;
		/**
		 * Base64 DER SPKI of a SECOND P-256 key that the OS releases only
		 * after biometrics or the passcode; it approves Home security actions
		 * (`confirmOnDevice`). Without it those actions are refused.
		 */
		confirmPublicKeySpki?: string;
		label: string;
		platform: "ios" | "android";
		publicKeySpki: string;
	}
): Promise<PairResponse> {
	return signedPost(
		target,
		identity,
		DEVICE_ROUTES.pair,
		{
			app: device.app,
			attestation: device.attestation,
			confirm_public_key_spki: device.confirmPublicKeySpki,
			device_id: identity.deviceId,
			label: device.label,
			platform: device.platform,
			public_key_spki: device.publicKeySpki,
		},
		pairResponseSchema
	);
}

const presenceResponseSchema = z.object({
	lease_ttl_ms: z.number(),
	ok: z.literal(true),
});

/** Refresh the foreground lease (send on every foreground change and every 60 s). */
export function sendPresence(
	target: ApiTarget,
	identity: DeviceIdentity,
	device: ClientDevice
): Promise<z.infer<typeof presenceResponseSchema>> {
	return signedPost(
		target,
		identity,
		DEVICE_ROUTES.presence,
		device,
		presenceResponseSchema
	);
}

/** Claim a device call once; the response carries the frozen input. */
export function claimDeviceCall(
	target: ApiTarget,
	identity: DeviceIdentity,
	call: {
		conversationId: string;
		phase?: "execute" | "permission";
		toolCallId: string;
	}
): Promise<DeviceClaimResponse> {
	return signedPost(
		target,
		identity,
		DEVICE_ROUTES.claim,
		{
			conversation_id: call.conversationId,
			device_id: identity.deviceId,
			phase: call.phase ?? "execute",
			tool_call_id: call.toolCallId,
		},
		deviceClaimResponseSchema
	);
}

/**
 * Answer a `requiresOnDeviceConfirmation` card from the target phone. An
 * approval is signed by `confirmSigner` (the user-presence key, so the OS
 * runs biometrics first) over `deviceConfirmMessage`; a deny needs no
 * biometrics. The request itself is signed by the device key as usual.
 */
export async function confirmOnDevice(
	target: ApiTarget,
	identity: DeviceIdentity,
	answer: {
		confirmSigner: Pick<DeviceSigner, "sign">;
		inputSha256: string;
		optionId: "allow_once" | "deny";
		requestId: string;
	},
	now: () => number = Date.now
): Promise<DeviceConfirmResponse> {
	const confirmedAtMs = now();
	const confirmSignature =
		answer.optionId === "deny"
			? undefined
			: toBase64(
					await answer.confirmSigner.sign(
						new TextEncoder().encode(
							deviceConfirmMessage({
								confirmedAtMs,
								inputSha256: answer.inputSha256,
								optionId: answer.optionId,
								requestId: answer.requestId,
							})
						)
					)
				);
	return signedPost(
		target,
		identity,
		DEVICE_ROUTES.confirm,
		{
			confirm_signature: confirmSignature,
			confirmed_at_ms: confirmedAtMs,
			device_id: identity.deviceId,
			input_sha256: answer.inputSha256,
			option_id: answer.optionId,
			request_id: answer.requestId,
		},
		deviceConfirmResponseSchema
	);
}

const homeAccessoriesResponseSchema = z.object({
	accessories: z.number(),
	ok: z.literal(true),
});

/**
 * After every `device.home.list`, report each accessory's HomeKit service
 * types. Core decides from this (never from the model) which Home changes
 * must be confirmed on the phone.
 */
export function postHomeAccessories(
	target: ApiTarget,
	identity: DeviceIdentity,
	accessories: HomeAccessoryReport[]
): Promise<z.infer<typeof homeAccessoriesResponseSchema>> {
	return signedPost(
		target,
		identity,
		DEVICE_ROUTES.homeAccessories,
		{ accessories, device_id: identity.deviceId },
		homeAccessoriesResponseSchema
	);
}

const resultResponseSchema = z.object({ ok: z.literal(true) }).passthrough();

/** Post a signed result bound to the claim and its frozen input hash. */
export function postDeviceResult(
	target: ApiTarget,
	identity: DeviceIdentity,
	submission: {
		app: "ryu-bot" | "ryu-native";
		claim: DeviceClaimResponse;
		conversationId: string;
		platform: "ios" | "android";
		result: DeviceToolResult;
		toolCallId: string;
	}
): Promise<z.infer<typeof resultResponseSchema>> {
	return signedPost(
		target,
		identity,
		DEVICE_ROUTES.result,
		{
			claim_id: submission.claim.claim_id,
			conversation_id: submission.conversationId,
			input_sha256: submission.claim.input_sha256,
			provenance: {
				app: submission.app,
				device_id: identity.deviceId,
				platform: submission.platform,
				source: "ryu-device",
			},
			result: submission.result,
			tool_call_id: submission.toolCallId,
		},
		resultResponseSchema
	);
}

/**
 * Sign a chat-stream body that carries `client_device`. Returns the exact
 * text to send as the body plus the headers to merge into the request.
 */
export async function signChatStreamBody(
	identity: DeviceIdentity,
	payload: unknown
): Promise<{ body: string; headers: Record<string, string> }> {
	const body = JSON.stringify(payload);
	const headers = await signDeviceRequest(
		identity,
		DEVICE_ROUTES.chatStream,
		new TextEncoder().encode(body)
	);
	return { body, headers };
}

export const pairedDeviceSchema = z.object({
	always_allowed: z.array(z.string()),
	app: z.string(),
	device_id: z.string(),
	foreground: z.boolean(),
	label: z.string(),
	last_seen_ms: z.number(),
	paired_at_ms: z.number(),
	platform: z.string(),
	state: z.enum(["active", "pending"]),
});
export type PairedDevice = z.infer<typeof pairedDeviceSchema>;

const devicesResponseSchema = z.object({
	devices: z.array(pairedDeviceSchema),
	principal_id: z.string(),
});

/** The caller's paired devices (no signature needed). */
export function listDevices(
	target: ApiTarget
): Promise<z.infer<typeof devicesResponseSchema>> {
	return request(
		target,
		"/api/device-tools/devices",
		{ method: "GET" },
		devicesResponseSchema
	);
}

const patchResponseSchema = z.object({
	always_allowed: z.array(z.string()),
	device_id: z.string(),
});

/** Rename a device or revoke per-tool "Always allow" grants. */
export function updateDevice(
	target: ApiTarget,
	deviceId: string,
	patch: { label?: string; revoke?: string[] }
): Promise<z.infer<typeof patchResponseSchema>> {
	return request(
		target,
		`/api/device-tools/devices/${encodeURIComponent(deviceId)}`,
		{ body: patch, method: "PATCH" },
		patchResponseSchema
	);
}

/** Forget a device with its key, grants and quota rows. */
export function forgetDevice(
	target: ApiTarget,
	deviceId: string
): Promise<{ forgotten: true }> {
	return request(
		target,
		`/api/device-tools/devices/${encodeURIComponent(deviceId)}`,
		{ method: "DELETE" },
		z.object({ forgotten: z.literal(true) })
	);
}

/** Host only (loopback): activate a pending device. */
export function approveDevicePairing(
	target: ApiTarget,
	deviceId: string
): Promise<{ device_id: string; state: "active" }> {
	return request(
		target,
		`/api/device-tools/devices/${encodeURIComponent(deviceId)}/approve-pair`,
		{ method: "POST" },
		z.object({ device_id: z.string(), state: z.literal("active") })
	);
}

const catalogResponseSchema = z.object({
	caps: deviceToolCapsSchema,
	catalog: z.unknown(),
	enabled: z.boolean(),
	principal_id: z.string(),
});

/** The catalog, the caller's caps and whether `mobile.device_tools` is on. */
export function fetchDeviceToolCatalog(
	target: ApiTarget
): Promise<z.infer<typeof catalogResponseSchema>> {
	return request(
		target,
		"/api/device-tools/catalog",
		{ method: "GET" },
		catalogResponseSchema
	);
}

/**
 * Open this phone's device stream (P3): an SSE response carrying calls routed
 * to it from a turn it did not start (`data-device-tool-request`, needs-
 * permission and status parts, each with an id; never an input). Signed with
 * method `GET` over an empty body. Hold it only while Ryu is in the
 * foreground; a new connect replaces the old one. Act on a request by
 * claiming it.
 */
export async function openDeviceStream(
	target: ApiTarget,
	identity: DeviceIdentity,
	signal?: AbortSignal
): Promise<Response> {
	const signed = await signDeviceRequest(
		identity,
		DEVICE_ROUTES.stream,
		new Uint8Array(),
		"GET"
	);
	const resp = await fetchForTarget(target)(
		apiUrl(target, DEVICE_ROUTES.stream),
		{
			headers: {
				...makeHeaders(target.token, target.userJwt),
				...signed,
				accept: "text/event-stream",
			},
			method: "GET",
			signal,
		}
	);
	if (!resp.ok) {
		throw apiErrorFromBody(
			DEVICE_ROUTES.stream,
			resp.status,
			await resp.text()
		);
	}
	return resp;
}
