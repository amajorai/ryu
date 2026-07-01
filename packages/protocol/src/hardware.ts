// @ryuhq/protocol — Ryu Hardware Protocol (RHP) v1, TypeScript mirror.
//
// This is the TS implementation of the SAME wire contract defined in
// `apps/hardware/PROTOCOL.md`. It is consumed by the mobile relay (apps/native),
// which in Mode A is a transparent BLE<->WSS tunnel: it pipes these exact JSON
// control messages between the device's GATT characteristics and the node
// WebSocket. The relay validates/narrows on `type`, never reinterprets payloads.
//
// Keep this in lockstep with the two sibling implementations:
//   - C    (firmware): apps/hardware/firmware/shared/protocol/include/rhp_protocol.h
//   - Rust (node):     apps/core/src/hardware/protocol.rs
//
// Message `type` strings and field names are NORMATIVE. This module is pure
// types plus tiny narrowing guards — no runtime dependencies, no side effects.

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

/** Discriminated union of every client->server control message. */
export type RhpClientMsg =
	| RhpHello
	| RhpModeMsg
	| RhpListen
	| RhpText
	| RhpAbort
	| RhpCameraMeta
	| RhpTelemetry
	| RhpPing;

/** All client->server `type` discriminator values. */
export type RhpClientMsgType = RhpClientMsg["type"];

// ---------------------------------------------------------------------------
// Server -> Client control messages (§3.2)
// ---------------------------------------------------------------------------

/** Acknowledges `hello`; carries session ids and the TTS downlink format. */
export interface RhpHelloAck {
	/** Present (long-running meeting id) only if the device is ambient-capable. */
	ambient_session_id?: string;
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
	payload: Record<string, unknown>;
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
	| RhpPong;

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

/** One entry in GET /api/hardware/devices. */
export interface RhpDevice {
	/** Latest reported battery percent, or null if unknown. */
	battery_pct: number | null;
	device_id: string;
	/** Epoch milliseconds of last activity, or null if never seen. */
	last_seen: number | null;
	name: string;
	online: boolean;
	type: RhpDeviceType;
}

/** GET /api/hardware/devices response body. */
export type RhpDeviceList = RhpDevice[];

/** PATCH /api/hardware/devices/:id request body (all fields optional). */
export interface RhpDeviceUpdate {
	name?: string;
	prefs?: Record<string, unknown>;
}

/**
 * The `ryu-pair://` QR / BLE payload a device advertises when unprovisioned.
 * Format: `ryu-pair://<device_id>?n=<nonce>&t=<device_type>` (§5).
 */
export interface RhpPairingPayload {
	device_id: string;
	device_type: RhpDeviceType;
	nonce: string;
}

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
	widgets: unknown[];
}

/** PUT /api/hardware/devices/:id/dashboard request body (all fields optional). */
export interface RhpDeviceDashboardUpdate {
	refresh_rate?: number;
	widgets?: unknown[];
}

// ---------------------------------------------------------------------------
// Narrowing guards (pure; the relay uses these to validate piped frames)
// ---------------------------------------------------------------------------

const CLIENT_TYPES: ReadonlySet<string> = new Set<RhpClientMsgType>([
	"hello",
	"mode",
	"listen",
	"text",
	"abort",
	"camera_meta",
	"telemetry",
	"ping",
]);

const SERVER_TYPES: ReadonlySet<string> = new Set<RhpServerMsgType>([
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
]);

function hasType(value: unknown): value is { type: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

/** True if `value` is a structurally-valid client->server message envelope. */
export function isRhpClientMsg(value: unknown): value is RhpClientMsg {
	return hasType(value) && CLIENT_TYPES.has(value.type);
}

/** True if `value` is a structurally-valid server->client message envelope. */
export function isRhpServerMsg(value: unknown): value is RhpServerMsg {
	return hasType(value) && SERVER_TYPES.has(value.type);
}

/**
 * Parse a raw WS TEXT frame into a typed message. Returns null on invalid JSON
 * or an unrecognized `type` (so a relay can drop unknown frames defensively).
 */
export function parseRhpMessage(raw: string): RhpMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (isRhpClientMsg(parsed)) {
		return parsed;
	}
	if (isRhpServerMsg(parsed)) {
		return parsed;
	}
	return null;
}

/** Build the `ryu-pair://` URL string from a pairing payload. */
export function buildPairingUri(payload: RhpPairingPayload): string {
	const params = new URLSearchParams({
		n: payload.nonce,
		t: payload.device_type,
	});
	return `ryu-pair://${payload.device_id}?${params.toString()}`;
}

/** Parse a `ryu-pair://` URL string; returns null if it is not a valid one. */
export function parsePairingUri(uri: string): RhpPairingPayload | null {
	const PREFIX = "ryu-pair://";
	if (!uri.startsWith(PREFIX)) {
		return null;
	}
	const rest = uri.slice(PREFIX.length);
	const queryIndex = rest.indexOf("?");
	if (queryIndex === -1) {
		return null;
	}
	const deviceId = rest.slice(0, queryIndex);
	const params = new URLSearchParams(rest.slice(queryIndex + 1));
	const nonce = params.get("n");
	const type = params.get("t");
	if (!(deviceId && nonce && type)) {
		return null;
	}
	if (type !== "watch" && type !== "necklace" && type !== "desk") {
		return null;
	}
	return { device_id: deviceId, nonce, device_type: type };
}
