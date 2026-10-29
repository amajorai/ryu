import { z } from "zod";

// @ryuhq/protocol — Ryu Hardware Protocol (RHP) v1.1, TypeScript mirror.
//
// This is the TS implementation of the SAME wire contract defined in
// `apps/hardware/PROTOCOL.md`. It is consumed by the mobile app (apps/native).
//
// In Mode A the phone relays between the device's GATT characteristics and the
// node WebSocket. A legacy (v1) relay pipes the plaintext JSON control messages
// below and narrows them on `type`. A v1.1 secure relay is an OPAQUE forwarder:
// the device and node speak an end-to-end Noise session, and the phone only
// reassembles and segments ciphertext with the BLE link codec at the bottom of
// this module. It never parses, replays or forges control messages there.
//
// Keep this in lockstep with the sibling implementations:
//   - C    (firmware): apps/hardware/firmware/shared/protocol/include/rhp_protocol.h
//   - Rust (node):     crates/core/hardware/src/protocol.rs
//   - Core ingress:    apps/core/src/server/hardware_ws.rs
//
// Message `type` strings and field names are NORMATIVE. This module is pure
// contracts with native boundary codecs and no side effects; zod is its only
// dependency.

// ---------------------------------------------------------------------------
// Enums (string literal unions — the wire values themselves)
// ---------------------------------------------------------------------------

/** Physical device class. */
export type RhpDeviceType = "watch" | "necklace" | "desk";

/** Device operating mode. */
export type RhpMode = "idle" | "chat" | "ambient";

/** Chat-turn boundary marker (push-to-talk / wake / VAD). */
export type RhpListenState = "start" | "stop";

/** Face/emotion state driving the "Island eyes" renderer. */
export type RhpEmotion =
	| "neutral"
	| "listening"
	| "thinking"
	| "happy"
	| "sad"
	| "surprised"
	| "speaking";

/** Native face-state admission for UI consumers; the relay still preserves raw envelopes. */
export const rhpEmotionSchema = z.enum([
	"neutral",
	"listening",
	"thinking",
	"happy",
	"sad",
	"surprised",
	"speaking",
]);

/** Display surface a server `display` message targets. */
export type RhpSurface = "eink" | "lcd";

// ---------------------------------------------------------------------------
// Shared sub-objects
// ---------------------------------------------------------------------------

/** Audio format descriptor (mic uplink and TTS downlink). */
export interface RhpAudioFormat {
	codec: "opus";
	/** 60 ms frames. */
	frame_ms: number;
	/** 16000 for mic uplink, 24000 for TTS downlink. */
	sample_rate: number;
}

/** Capability profile a device advertises in `hello`. */
export interface RhpCaps {
	camera: boolean;
	display: boolean;
	mic: boolean;
	speaker: boolean;
}

// ---------------------------------------------------------------------------
// Client -> Server control messages (§3.1)
// ---------------------------------------------------------------------------

/** First frame on connect: identifies the device and its capabilities. */
export interface RhpHello {
	audio: RhpAudioFormat;
	caps: RhpCaps;
	/** Stable per-device id (from NVS, set at pairing). */
	device_id: string;
	device_type: RhpDeviceType;
	fw_version: string;
	/** True if tunneled via the phone (Mode A relay). */
	relay: boolean;
	type: "hello";
}

/** Device operating-mode change. */
export interface RhpModeMsg {
	type: "mode";
	value: RhpMode;
}

/** Chat-turn boundary. */
export interface RhpListen {
	state: RhpListenState;
	type: "listen";
}

/** Typed/derived text input (fallback path when no mic turn). */
export interface RhpText {
	content: string;
	type: "text";
}

/** Barge-in: stop current TTS + generation. */
export interface RhpAbort {
	type: "abort";
}

/** Announces that the next BINARY frame is a JPEG of these dimensions. */
export interface RhpCameraMeta {
	bytes: number;
	fmt: string;
	h: number;
	type: "camera_meta";
	w: number;
}

/** Periodic device telemetry. */
export interface RhpTelemetry {
	battery_pct: number;
	charging: boolean;
	rssi: number;
	type: "telemetry";
}

/** Liveness probe. */
export interface RhpPing {
	type: "ping";
}

// ---------------------------------------------------------------------------
// Device capabilities (§6.1). Secure (v1.1) sessions only.
// ---------------------------------------------------------------------------

/** Scalar type of one capability parameter. */
export type RhpParamType = "string" | "integer" | "number" | "boolean";

/** Flat, bounded parameter spec (§6.2). Unknown keys are `invalid_schema`. */
export interface RhpParamSpec {
	description: string;
	/** string and integer only; at most 16 entries. */
	enum?: (string | number)[];
	/** integer and number only. */
	max?: number;
	/** string only; at most 4096, counted in Unicode scalar values. */
	max_len?: number;
	/** integer and number only. */
	min?: number;
	type: RhpParamType;
}

/** How a capability call is confirmed on the device itself. */
export type RhpCapabilityConfirm = "none" | "device_press";

/** One capability a device registers. */
export interface RhpCapabilityDescriptor {
	/** none (default) or device_press (the device asks "Allow <name>?"). */
	confirm?: RhpCapabilityConfirm;
	description: string;
	/** `^[a-z][a-z0-9_]{0,31}([.][a-z][a-z0-9_]{0,31}){0,2}$`, at most 32 chars. */
	name: string;
	params: {
		optional: Record<string, RhpParamSpec>;
		required: Record<string, RhpParamSpec>;
	};
	/** Hidden from agents unless the user enables it. Default false. */
	sensitive?: boolean;
	/** 100..60000, default 10000. */
	timeout_ms?: number;
}

/** Device -> node: replaces the whole capability table. */
export interface RhpCapabilitiesRegister {
	capabilities: RhpCapabilityDescriptor[];
	/** u32 >= 1, strictly increasing within a session. */
	generation: number;
	type: "capabilities_register";
}

/** Error codes a device may return for a capability call. */
export type RhpCapabilityErrorCode =
	| "invalid_args"
	| "unknown_capability"
	| "stale_generation"
	| "busy"
	| "timeout"
	| "unconfirmed"
	| "denied"
	| "internal";

/** Device -> node: the outcome of one `capability_invoke`. */
export type RhpCapabilityResult =
	| {
			ok: true;
			request_id: string;
			result: z.core.util.JSONType;
			type: "capability_result";
	  }
	| {
			error: { code: RhpCapabilityErrorCode; message: string };
			ok: false;
			request_id: string;
			type: "capability_result";
	  };

/** Discriminated union of every client->server control message. */
export type RhpClientMsg =
	| RhpHello
	| RhpModeMsg
	| RhpListen
	| RhpText
	| RhpAbort
	| RhpCameraMeta
	| RhpTelemetry
	| RhpPing
	| RhpCapabilitiesRegister
	| RhpCapabilityResult;

/** All client->server `type` discriminator values. */
export type RhpClientMsgType = RhpClientMsg["type"];

// ---------------------------------------------------------------------------
// Server -> Client control messages (§3.2)
// ---------------------------------------------------------------------------

/** Capability limits a secure `hello_ack` advertises (§6.1). */
export interface RhpCapLimits {
	max_caps: number;
	max_inflight: number;
	max_result_bytes: number;
}

/**
 * Acknowledges `hello`; carries session ids and the TTS downlink format. A
 * secure (v1.1) session adds `proto` and `cap_limits`; the legacy ack is
 * byte-identical to v1 and omits both.
 */
export interface RhpHelloAck {
	/** Present (long-running meeting id) only if the device is ambient-capable. */
	ambient_session_id?: string;
	cap_limits?: RhpCapLimits;
	proto?: "1.1";
	session_id: string;
	tts: RhpAudioFormat;
	type: "hello_ack";
}

/** Live transcript of the user's speech (display it). */
export interface RhpStt {
	final: boolean;
	text: string;
	type: "stt";
}

/** One streamed assistant-token chunk. */
export interface RhpChatDelta {
	text: string;
	type: "chat_delta";
}

/** End of the streamed assistant turn. */
export interface RhpChatEnd {
	conversation_id: string;
	type: "chat_end";
}

/** Face state change. */
export interface RhpEmotionMsg {
	type: "emotion";
	value: RhpEmotion;
}

/** TTS audio is about to stream as BINARY Opus frames. */
export interface RhpTtsStart {
	type: "tts_start";
}

/** End of the TTS audio stream. */
export interface RhpTtsEnd {
	type: "tts_end";
}

/** An ambient chunk was transcribed and indexed. */
export interface RhpAmbientAck {
	segment_id: string;
	type: "ambient_ack";
}

/** An ambient chunk was skipped (e.g. silence). */
export interface RhpAmbientSkip {
	reason: string;
	type: "ambient_skip";
}

/** Desk ambient/e-ink display update. `payload` is widget-specific JSON. */
export interface RhpDisplay {
	payload: Record<string, z.core.util.JSONType>;
	surface: RhpSurface;
	type: "display";
	widget: string;
}

/** Protocol or processing error. */
export interface RhpError {
	code: string;
	message: string;
	type: "error";
}

/** Liveness response. */
export interface RhpPong {
	type: "pong";
}

/** Why one registered capability was refused. */
export type RhpCapabilityRejectCode =
	| "invalid_name"
	| "invalid_schema"
	| "duplicate"
	| "limit"
	| "reserved";

/** Node -> device: the outcome of a `capabilities_register`. */
export interface RhpCapabilitiesAck {
	accepted: string[];
	generation: number;
	rejected: { code: RhpCapabilityRejectCode; name: string }[];
	type: "capabilities_ack";
}

/** Node -> device: run one registered capability. */
export interface RhpCapabilityInvoke {
	args: Record<string, z.core.util.JSONType>;
	deadline_ms: number;
	generation: number;
	name: string;
	/** `inv_<conn_generation>_<counter>`. */
	request_id: string;
	type: "capability_invoke";
}

/** Node -> device (authenticated, secure only): wipe credentials and re-pair. */
export interface RhpUnpaired {
	type: "unpaired";
}

/** Discriminated union of every server->client control message. */
export type RhpServerMsg =
	| RhpHelloAck
	| RhpStt
	| RhpChatDelta
	| RhpChatEnd
	| RhpEmotionMsg
	| RhpTtsStart
	| RhpTtsEnd
	| RhpAmbientAck
	| RhpAmbientSkip
	| RhpDisplay
	| RhpError
	| RhpPong
	| RhpCapabilitiesAck
	| RhpCapabilityInvoke
	| RhpUnpaired;

/** All server->client `type` discriminator values. */
export type RhpServerMsgType = RhpServerMsg["type"];

/** Either direction — convenient for a relay that pipes both ways. */
export type RhpMessage = RhpClientMsg | RhpServerMsg;

// ---------------------------------------------------------------------------
// Pairing & device-registry REST (§6)
// ---------------------------------------------------------------------------

/** POST /api/hardware/pair request body. */
export interface RhpPairRequest {
	device_id: string;
	device_type: RhpDeviceType;
	pairing_nonce: string;
}

/** POST /api/hardware/pair response body. */
export interface RhpPairResponse {
	/** Per-device Bearer token, used on the WS upgrade. Store in NVS. */
	device_token: string;
	/** The node's reachable URL the device should connect to. */
	node_url: string;
}

/** How the device's static key reached the app at pairing (§5.4). */
export type RhpKeySource = "qr" | "ble";

/**
 * Whether the user compared the 6-digit code: `sas` when the codes matched,
 * `unverified` when the user chose "I can't verify" (a persistent badge).
 */
export type RhpKeyVerification = "sas" | "unverified";

/** One live capability summary in the device list (§7). */
export interface RhpDeviceCapabilitySummary {
	/** An RhpCapabilityConfirm; kept open so a newer node never breaks the list. */
	confirm: string;
	description: string;
	/** Effective agent exposure: prefs override, otherwise `!sensitive`. */
	enabled: boolean;
	name: string;
	sensitive: boolean;
}

/** One entry in GET /api/hardware/devices. */
export interface RhpDevice {
	/** Latest reported battery percent, or null if unknown. */
	battery_pct: number | null;
	/** Live capabilities; empty while the device is offline. */
	capabilities?: RhpDeviceCapabilitySummary[];
	device_id: string;
	/** `xxxx-xxxx-xxxx-xxxx` fingerprint of the pinned device key (level 2). */
	key_fingerprint?: string | null;
	/** An RhpKeySource; open so a newer node never breaks the list. */
	key_source?: string | null;
	/** An RhpKeyVerification; `unverified` shows a persistent badge. */
	key_verification?: string | null;
	/** Epoch milliseconds of last activity, or null if never seen. */
	last_seen: number | null;
	name: string;
	/** The node identity was reset: remove and pair the device again. */
	needs_repair?: boolean;
	online: boolean;
	/** Device prefs (whole-object PATCH); see RhpDevicePrefs. */
	prefs?: RhpDevicePrefs;
	/** 1 = legacy plaintext v1, 2 = end-to-end secure session (a ratchet). */
	protocol_level?: number;
	/** True when the current live session is end-to-end encrypted. */
	secure?: boolean;
	type: RhpDeviceType;
}

/** Device prefs keys the node understands (§6.5). Unknown keys are preserved. */
export interface RhpDevicePrefs {
	ambient?: boolean;
	/** Per-capability override of the default (`!sensitive`). */
	capabilities?: Record<string, boolean>;
	/** false hides every agent tool of this device. Default true. */
	capabilities_enabled?: boolean;
	/** false stops the cleartext emotion mirror to the relay phone. Default true. */
	relay_mirror?: boolean;
	[key: string]: z.core.util.JSONType | undefined;
}

/** Node identity status in the device list envelope (§7). */
export interface RhpNodeIdentityStatus {
	fingerprint?: string | null;
	/** `ok`, `unavailable` or `uninitialized`; open for forward compatibility. */
	status: string;
}

/** GET /api/hardware/devices response body. */
export type RhpDeviceList = RhpDevice[];

/** PATCH /api/hardware/devices/:id request body (all fields optional). */
export interface RhpDeviceUpdate {
	name?: string;
	prefs?: Record<string, z.core.util.JSONType>;
}

/** Pairing v2 policy: the user compares a code and presses the device button. */
export type RhpPairingPolicy = "sas_press";

/** POST /api/hardware/pair/begin request body (§5.4 step 4). */
export interface RhpPairBeginRequest {
	/** b64u SHA-256 commitment from `pairing_info.c`. */
	device_commit: string;
	device_id: string;
	/** b64u X25519 public key (32 bytes). */
	device_pub: string;
	device_type: RhpDeviceType;
	key_source: RhpKeySource;
	pairing_nonce: string;
	policy: RhpPairingPolicy;
}

/** POST /api/hardware/pair/begin response body. */
export interface RhpPairBeginResponse {
	/** Seconds until the pending pairing expires (180). */
	expires_in: number;
	node_fingerprint: string;
	/** b64u X25519 node public key, written to the device in the `offer` op. */
	node_pub: string;
	/** b64u, 16 bytes, single-use. */
	pairing_id: string;
}

/** POST /api/hardware/pair/reveal request body (§5.4 step 6). */
export interface RhpPairRevealRequest {
	/** b64u from the device's `confirm_required` notify. */
	device_rand: string;
	pairing_id: string;
}

/** POST /api/hardware/pair/reveal response body. */
export interface RhpPairRevealResponse {
	device_fingerprint: string;
	/** Six decimal digits; shown as `123 456`. */
	sas: string;
	transcript_hash: string;
}

/** Wi-Fi credentials the node seals to the device; never stored by the node. */
export interface RhpPairWifi {
	psk: string;
	ssid: string;
}

/** POST /api/hardware/pair/confirm request body (§5.4 step 9). */
export interface RhpPairConfirmRequest {
	/** b64u from the device's `confirmed` notify. */
	confirm_tag: string;
	key_verification: RhpKeyVerification;
	pairing_id: string;
	wifi?: RhpPairWifi;
}

/** POST /api/hardware/pair/confirm response body. */
export interface RhpPairConfirmResponse {
	device: RhpDevice;
	/** WS-only relay Bearer (`rhr_…`) this phone keeps; never the device token. */
	relay_token: string;
	/** b64u AES-GCM sealed credentials, written to the device in `provision`. */
	sealed_credentials: string;
}

/** Why the app cancelled a pending pairing. `mismatch` logs a security warning. */
export type RhpPairCancelReason =
	| "mismatch"
	| "user_cancelled"
	| "timeout"
	| "interference"
	| "device_error";

/** POST /api/hardware/pair/cancel request body (idempotent). */
export interface RhpPairCancelRequest {
	pairing_id: string;
	reason: RhpPairCancelReason;
}

/** POST /api/hardware/identity/reset response body. */
export interface RhpIdentityResetResponse {
	devices_needing_repair: number | string[];
	node_fingerprint: string;
}

/**
 * The `ryu-pair://` QR payload a device shows when unprovisioned (§5.2).
 * v1: `ryu-pair://<device_id>?n=<nonce>&t=<device_type>`.
 * v2: the same plus `&v=2&k=<b64u device static public key>`.
 */
export type RhpPairingPayload =
	| {
			device_id: string;
			device_type: RhpDeviceType;
			nonce: string;
			version: 1;
	  }
	| {
			/** b64u X25519 public key; decodes to exactly 32 bytes. */
			device_pub: string;
			device_id: string;
			device_type: RhpDeviceType;
			nonce: string;
			version: 2;
	  };

/** The `pairing_info` characteristic read (§5.2). v1 firmware omits v/k/c/policy. */
export interface RhpPairingInfo {
	/** b64u commitment to the attempt's device_rand. */
	c?: string;
	device_id: string;
	/** b64u device static public key. */
	k?: string;
	nonce: string;
	policy?: RhpPairingPolicy;
	type: RhpDeviceType;
	v?: number;
}

/** Device error codes on the provisioning status characteristic. */
export type RhpPairingErrorCode =
	| "bad_state"
	| "bad_offer"
	| "bad_key"
	| "timeout"
	| "bad_seal"
	| "too_large"
	| "v2_required"
	| "busy";

/** Device -> app status notifies during pairing v2 (§5.2). */
export type RhpPairingStatus =
	| { r: string; st: "confirm_required" }
	| { st: "confirmed"; tag: string }
	| { st: "provisioned" }
	| { st: "aborted" }
	| { code: RhpPairingErrorCode; st: "error" };

/** App -> device ops written to the provision characteristic (§5.2). */
export type RhpPairingOp =
	| { node_pub: string; op: "offer"; pairing_id: string }
	| { op: "provision"; pairing_id: string; sealed: string }
	| { op: "abort"; pairing_id: string }
	| { op: "replay"; pairing_id: string };

// ---------------------------------------------------------------------------
// Dashboard display surface (TRMNL model — apps/hardware/DASHBOARD.md)
// ---------------------------------------------------------------------------

/**
 * Final byte encoding a device's panel expects. Mirrors the Rust `Palette` enum
 * (apps/core/src/dashboard/render.rs):
 * - `mono`   : 1-bit black/white, packed MSB-first row-major (e-ink desk panel).
 * - `rgba`   : full-colour PNG (watch LCD default).
 * - `rgb565` : 16-bit little-endian RGB565 framebuffer blit.
 */
export type RhpPalette = "mono" | "rgba" | "rgb565";

/**
 * A device's physical screen description, echoed in the display manifest so the
 * firmware `dash_client` blits the right geometry. Mirrors the Rust
 * `DeviceProfile` `{ w, h, bit_depth, palette, rotation }`.
 */
export interface RhpScreen {
	/** Bits per pixel of the encoding: 1 (mono e-ink), 16 (RGB565), 24/32 (PNG). */
	bit_depth: number;
	/** Panel height in pixels. */
	h: number;
	/** Final byte encoding for this panel. */
	palette: RhpPalette;
	/** Clockwise rotation (degrees) the device applies on blit. */
	rotation: number;
	/** Panel width in pixels. */
	w: number;
}

/**
 * GET /api/hardware/display/:device_id — the display manifest the device polls.
 * The device skips re-downloading the image when `rev` is unchanged. The bytes at
 * `image_url` are: packed 1-bit (mono), RGB565, or PNG — per `screen.palette`.
 *
 * MONO byte format (NORMATIVE — agreed with `dash_client.h`): row-major, top row
 * first; each row is `ceil(w / 8)` bytes (byte-aligned, low bits padded); MSB is
 * the leftmost pixel. POLARITY: a SET bit (1) is WHITE, a clear bit (0) is BLACK
 * (Waveshare EPD convention — a 0xFF byte is a white row). Total length
 * `ceil(w/8) * h` bytes. RGB565 (LCD) is big-endian per pixel, `w*h*2` bytes.
 */
export interface RhpDisplayManifest {
	/** Relative URL of the rendered image (carries the `rev` query). */
	image_url: string;
	/** Seconds until the next poll. */
	refresh_rate: number;
	/** Content hash; re-poll skips the image fetch when this is unchanged. */
	rev: string;
	/** Panel geometry + encoding. */
	screen: RhpScreen;
}

/**
 * GET/PUT /api/hardware/devices/:id/dashboard — the per-device dashboard config.
 * The `widgets` array is the same widget shape the desktop dashboard builder uses
 * (kind + source + layout); a PUT with `widgets` replaces the device's selection.
 */
export interface RhpDeviceDashboard {
	dashboard_id: string;
	device_id: string;
	refresh_rate: number;
	screen: RhpScreen;
	widgets: z.core.util.JSONType[];
}

/** PUT /api/hardware/devices/:id/dashboard request body (all fields optional). */
export interface RhpDeviceDashboardUpdate {
	refresh_rate?: number;
	widgets?: z.core.util.JSONType[];
}

// ---------------------------------------------------------------------------
// Narrowing guards (pure; the relay uses these to validate piped frames)
// ---------------------------------------------------------------------------

const CLIENT_TYPES = [
	"hello",
	"mode",
	"listen",
	"text",
	"abort",
	"camera_meta",
	"telemetry",
	"ping",
	"capabilities_register",
	"capability_result",
] as const;

const SERVER_TYPES = [
	"hello_ack",
	"stt",
	"chat_delta",
	"chat_end",
	"emotion",
	"tts_start",
	"tts_end",
	"ambient_ack",
	"ambient_skip",
	"display",
	"error",
	"pong",
	"capabilities_ack",
	"capability_invoke",
	"unpaired",
] as const;

const objectContainerSchema = z.custom<object>((value) => {
	const wrapped = new Object(value);
	return wrapped === value && !z.function().safeParse(value).success;
});
function controlEnvelope<T extends string>(types: readonly [T, ...T[]]) {
	return z.preprocess(
		(value, context) => {
			const result = objectContainerSchema.safeParse(value);
			if (!result.success) {
				context.addIssue({
					code: "custom",
					message: "Expected a control envelope",
				});
				return z.NEVER;
			}
			// A native prototype view preserves the discriminator on legacy arrays and inherited envelopes.
			return Object.create(result.data);
		},
		z.looseObject({ type: z.enum(types) })
	);
}
const clientEnvelopeSchema = controlEnvelope(CLIENT_TYPES);
const serverEnvelopeSchema = controlEnvelope(SERVER_TYPES);
/** Relays recognize the discriminator while leaving the opaque payload untouched. */
export type RhpClientEnvelope = z.output<typeof clientEnvelopeSchema>;
export type RhpServerEnvelope = z.output<typeof serverEnvelopeSchema>;
export function isRhpClientMsg(
	value: Parameters<typeof clientEnvelopeSchema.safeParse>[0]
): value is RhpClientEnvelope {
	return clientEnvelopeSchema.safeParse(value).success;
}
export function isRhpServerMsg(
	value: Parameters<typeof serverEnvelopeSchema.safeParse>[0]
): value is RhpServerEnvelope {
	return serverEnvelopeSchema.safeParse(value).success;
}
const admittedEnvelopeSchema = z.custom<RhpClientEnvelope | RhpServerEnvelope>(
	(value) => isRhpClientMsg(value) || isRhpServerMsg(value)
);
/** Parse a control frame, retaining its exact native JSON payload and recognized discriminator. */
export function parseRhpMessage(raw: string) {
	try {
		const result = admittedEnvelopeSchema.safeParse(JSON.parse(raw));
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// base64url (RFC 4648 §5, no padding) — strict, pure
// ---------------------------------------------------------------------------

const B64URL_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Decode unpadded base64url. Returns null on padding, characters outside the URL
 * alphabet, an impossible length, or non-zero trailing bits (§5.2 "b64u").
 */
export function decodeBase64Url(text: string): Uint8Array | null {
	if (text.length % 4 === 1) {
		return null;
	}
	const out = new Uint8Array(Math.floor((text.length * 3) / 4));
	let buffer = 0;
	let bits = 0;
	let written = 0;
	for (const char of text) {
		const value = B64URL_ALPHABET.indexOf(char);
		if (value < 0) {
			return null;
		}
		buffer = ((buffer << 6) | value) & 0xff_ff_ff;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[written] = (buffer >> bits) & 0xff;
			written += 1;
		}
	}
	// Leftover bits must be zero so every byte string has exactly one encoding.
	if ((buffer & ((1 << bits) - 1)) !== 0) {
		return null;
	}
	return out;
}

/** Encode bytes as unpadded base64url. */
export function encodeBase64Url(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = ((buffer << 8) | byte) & 0xff_ff;
		bits += 8;
		while (bits >= 6) {
			bits -= 6;
			out += B64URL_ALPHABET.charAt((buffer >> bits) & 0x3f);
		}
	}
	if (bits > 0) {
		out += B64URL_ALPHABET.charAt((buffer << (6 - bits)) & 0x3f);
	}
	return out;
}

/** True when `text` is strict b64u that decodes to exactly `length` bytes. */
export function isBase64UrlOfLength(text: string, length: number): boolean {
	return decodeBase64Url(text)?.length === length;
}

// ---------------------------------------------------------------------------
// ryu-pair:// QR codec (§5.2)
// ---------------------------------------------------------------------------

const PAIRING_URI_PREFIX = "ryu-pair://";
const X25519_KEY_BYTES = 32;

function isDeviceType(value: string): value is RhpDeviceType {
	return value === "watch" || value === "necklace" || value === "desk";
}

/** Build the `ryu-pair://` URL string from a pairing payload. */
export function buildPairingUri(payload: RhpPairingPayload): string {
	const params = new URLSearchParams({
		n: payload.nonce,
		t: payload.device_type,
	});
	if (payload.version === 2) {
		params.set("v", "2");
		params.set("k", payload.device_pub);
	}
	return `${PAIRING_URI_PREFIX}${payload.device_id}?${params.toString()}`;
}

/**
 * Parse a `ryu-pair://` URL string; returns null if it is not a valid one.
 * No `v` means a v1 device. `v=2` needs a `k` that is strict b64u decoding to
 * 32 bytes. Any other `v` is rejected so a future format is never misread.
 */
export function parsePairingUri(uri: string): RhpPairingPayload | null {
	if (!uri.startsWith(PAIRING_URI_PREFIX)) {
		return null;
	}
	const rest = uri.slice(PAIRING_URI_PREFIX.length);
	const queryIndex = rest.indexOf("?");
	if (queryIndex === -1) {
		return null;
	}
	const deviceId = rest.slice(0, queryIndex);
	const params = new URLSearchParams(rest.slice(queryIndex + 1));
	const nonce = params.get("n");
	const type = params.get("t");
	if (!(deviceId && nonce && type && isDeviceType(type))) {
		return null;
	}
	const version = params.get("v");
	if (version === null) {
		return { device_id: deviceId, device_type: type, nonce, version: 1 };
	}
	if (version !== "2") {
		return null;
	}
	const devicePub = params.get("k");
	if (!(devicePub && isBase64UrlOfLength(devicePub, X25519_KEY_BYTES))) {
		return null;
	}
	return {
		device_id: deviceId,
		device_pub: devicePub,
		device_type: type,
		nonce,
		version: 2,
	};
}

/** Format a six-digit SAS for display: `394867` -> `394 867`. */
export function formatSas(sas: string): string {
	return sas.length === 6 ? `${sas.slice(0, 3)} ${sas.slice(3)}` : sas;
}

// ---------------------------------------------------------------------------
// Mode A BLE link codec (§4.9) — pure, shared by the secure relay
// ---------------------------------------------------------------------------

/** byte0 of a legacy v1 JSON PDU (`{`). */
export const RHP_BLE_LEGACY_JSON = 0x7b;
/** byte0 of a segment PDU: `A1 flags seq [total_len:u16be on START] data`. */
export const RHP_BLE_SEGMENT = 0xa1;
/** byte0 of a link-control PDU: `A2 op`. */
export const RHP_BLE_LINK = 0xa2;
/** Largest reassembled message (one outer frame), in bytes. */
export const RHP_BLE_MAX_MESSAGE = 16_448;
/** Default ATT MTU before any exchange. */
export const RHP_BLE_DEFAULT_ATT_MTU = 23;

/** Link-control ops. Unknown ops are ignored. */
export const RhpBleLinkOp = {
	/** Phone -> device: the WS is open; start the handshake. */
	open: 1,
	/** Phone -> device: the WS closed. */
	closed: 2,
	/** Device -> phone: reopen the WS. */
	restart: 3,
} as const;
export type RhpBleLinkOp = (typeof RhpBleLinkOp)[keyof typeof RhpBleLinkOp];

const SEGMENT_FLAG_START = 0x01;
const SEGMENT_FLAG_END = 0x02;
const SEGMENT_FLAGS_RESERVED = 0xfc;
const SEGMENT_HEADER = 3;
const SEGMENT_START_HEADER = 5;
const ATT_HEADER = 3;

export type RhpBlePduKind = "legacy_json" | "segment" | "link_control" | "drop";

/** Classify a ctrl_up/ctrl_down PDU by byte0. */
export function classifyBlePdu(pdu: Uint8Array): RhpBlePduKind {
	switch (pdu[0]) {
		case RHP_BLE_LEGACY_JSON:
			return "legacy_json";
		case RHP_BLE_SEGMENT:
			return "segment";
		case RHP_BLE_LINK:
			return "link_control";
		default:
			return "drop";
	}
}

/** Build a two-byte link-control PDU. */
export function bleLinkPdu(op: RhpBleLinkOp): Uint8Array {
	return Uint8Array.of(RHP_BLE_LINK, op);
}

/** Read the op of a link-control PDU, or null when it is not one. */
export function parseBleLinkOp(pdu: Uint8Array): number | null {
	if (pdu.length < 2 || pdu[0] !== RHP_BLE_LINK) {
		return null;
	}
	return pdu[1] ?? null;
}

export interface RhpBleSegmentation {
	/** Sequence number for the first PDU of the next message. */
	nextSeq: number;
	pdus: Uint8Array[];
}

/**
 * Split one outer frame into A1 segment PDUs of at most `attMtu - 3` bytes,
 * numbering them from `firstSeq` (mod 256). Throws a RangeError for an empty or
 * oversized message, or an MTU too small to carry a START segment with data.
 */
export function segmentBleMessage(
	message: Uint8Array,
	attMtu: number,
	firstSeq: number
): RhpBleSegmentation {
	if (message.length === 0 || message.length > RHP_BLE_MAX_MESSAGE) {
		throw new RangeError(`BLE message length ${message.length} out of range`);
	}
	const maxPdu = Math.floor(attMtu) - ATT_HEADER;
	if (!Number.isFinite(maxPdu) || maxPdu <= SEGMENT_START_HEADER) {
		throw new RangeError(`ATT MTU ${attMtu} is too small for RHP segments`);
	}
	const pdus: Uint8Array[] = [];
	let seq = firstSeq & 0xff;
	let offset = 0;
	while (offset < message.length) {
		const isStart = offset === 0;
		const header = isStart ? SEGMENT_START_HEADER : SEGMENT_HEADER;
		const take = Math.min(maxPdu - header, message.length - offset);
		const isEnd = offset + take === message.length;
		const pdu = new Uint8Array(header + take);
		pdu[0] = RHP_BLE_SEGMENT;
		pdu[1] =
			(isStart ? SEGMENT_FLAG_START : 0) | (isEnd ? SEGMENT_FLAG_END : 0);
		pdu[2] = seq;
		if (isStart) {
			pdu[3] = (message.length >> 8) & 0xff;
			pdu[4] = message.length & 0xff;
		}
		pdu.set(message.subarray(offset, offset + take), header);
		pdus.push(pdu);
		offset += take;
		seq = (seq + 1) & 0xff;
	}
	return { nextSeq: seq, pdus };
}

/** Why reassembly failed. Every reason is fatal for the session (§4.9). */
export type RhpBleAssemblyError =
	| "malformed"
	| "flags"
	| "seq"
	| "start_open"
	| "orphan"
	| "length"
	| "overflow"
	| "short";

export type RhpBleAssemblyResult =
	| { bytes: Uint8Array; kind: "message" }
	| { kind: "pending" }
	| { kind: "error"; reason: RhpBleAssemblyError };

/**
 * Reassembles A1 segment PDUs from one direction into whole outer frames. The
 * sequence counter starts at 0 and must be reset when LINK_OPEN is sent or
 * received. After an error the caller tears the session down and calls reset().
 */
export class RhpBleAssembler {
	#expectedSeq = 0;
	#buffer: Uint8Array | null = null;
	#filled = 0;

	/** Forget any partial message and restart the sequence at 0. */
	reset(): void {
		this.#expectedSeq = 0;
		this.#buffer = null;
		this.#filled = 0;
	}

	/** Feed one segment PDU (byte0 0xA1). */
	push(pdu: Uint8Array): RhpBleAssemblyResult {
		const outcome = this.#accept(pdu);
		if (outcome.kind === "error") {
			this.#buffer = null;
			this.#filled = 0;
		}
		return outcome;
	}

	#accept(pdu: Uint8Array): RhpBleAssemblyResult {
		if (pdu.length < SEGMENT_HEADER || pdu[0] !== RHP_BLE_SEGMENT) {
			return { kind: "error", reason: "malformed" };
		}
		const flags = pdu[1] ?? 0;
		const seq = pdu[2] ?? 0;
		if ((flags & SEGMENT_FLAGS_RESERVED) !== 0) {
			return { kind: "error", reason: "flags" };
		}
		if (seq !== this.#expectedSeq) {
			return { kind: "error", reason: "seq" };
		}
		this.#expectedSeq = (seq + 1) & 0xff;
		let data: Uint8Array;
		if ((flags & SEGMENT_FLAG_START) === 0) {
			if (!this.#buffer) {
				return { kind: "error", reason: "orphan" };
			}
			data = pdu.subarray(SEGMENT_HEADER);
		} else {
			if (this.#buffer) {
				return { kind: "error", reason: "start_open" };
			}
			if (pdu.length < SEGMENT_START_HEADER) {
				return { kind: "error", reason: "malformed" };
			}
			const total = ((pdu[3] ?? 0) << 8) | (pdu[4] ?? 0);
			if (total === 0 || total > RHP_BLE_MAX_MESSAGE) {
				return { kind: "error", reason: "length" };
			}
			this.#buffer = new Uint8Array(total);
			this.#filled = 0;
			data = pdu.subarray(SEGMENT_START_HEADER);
		}
		const buffer = this.#buffer;
		if (this.#filled + data.length > buffer.length) {
			return { kind: "error", reason: "overflow" };
		}
		buffer.set(data, this.#filled);
		this.#filled += data.length;
		if ((flags & SEGMENT_FLAG_END) === 0) {
			return { kind: "pending" };
		}
		if (this.#filled !== buffer.length) {
			return { kind: "error", reason: "short" };
		}
		this.#buffer = null;
		this.#filled = 0;
		return { bytes: buffer, kind: "message" };
	}
}
