// packages/core-client/src/realtime.ts
//
// Shared client for Core's room-keyed realtime gateway (`GET /api/realtime/ws`,
// Phase 1/3 of the multi-user collaboration epic). One transport for every
// surface: desktop (Tauri webview), mobile (React Native), CLI — all reuse this
// verbatim. It speaks the gateway's wire protocol exactly:
//
//   Client -> server (the FIRST frame MUST be `join`):
//     - join:     text `{ type: "join", room_id, kind, app_id? }` (kind: conversation|document|application)
//     - presence: text `{ type: "presence", data }`   (the server stamps member_id)
//     - ping:     text `{ type: "ping" }`             (server replies `{type:"pong"}`)
//     - leave:    text `{ type: "leave" }`
//     - doc-sync: BINARY `<1-byte tag><payload>`       (CRDT, document rooms only)
//
//   Server -> client:
//     - join_ack: text `{ type: "join_ack", room_id, member_id, access, presence }`
//     - ping:     text `{ type: "ping" }` (client replies `{type:"pong"}`)
//     - events:   text `{ channel: "events",   data }` (e.g. a new chat message)
//     - presence: text `{ channel: "presence", data }` (awareness deltas / leaves)
//     - doc-sync: BINARY `<1-byte tag><payload>`
//
// Browsers cannot set headers on a WS upgrade, so clients exchange their normal
// HTTP credentials for a short-lived, one-use ticket. Only that opaque ticket
// rides the upgrade URL; node and user credentials never do. Uses the global
// `WebSocket` (a web standard present in browsers, React Native, and Bun/Node)
// so this stays platform-agnostic like the rest of `core-client`.

/** Write inputs retain the complete native JSON.stringify input ABI, including
 * SDK values, and are forwarded to that operation without a new admission gate. */
type RealtimeWriteInput = Parameters<typeof JSON.stringify>[0];

import { z } from "zod";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "./app-request-json.ts";

const realtimeString = z.string();
const realtimeNumber = z.union([
	z.number(),
	z.nan(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
const realtimeFunction = z.function();
const realtimeObjectFields = z.record(z.string(), appResponseValueSchema);
// This owner is used only after JSON.parse. Validate the complete native JSON
// tree first, retaining every key and reference, including numeric overflow.
const realtimeFrame = z.custom<z.output<typeof realtimeObjectFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		realtimeObjectFields.safeParse(value).success
);

import {
	type ApiTarget,
	apiUrl,
	appendWebSocketTicket,
	requestWebSocketTicket,
} from "./client.ts";
import { createResourceId } from "./ids.ts";

export { appendWebSocketTicket } from "./client.ts";

/** Which resource a room maps to. Mirrors the gateway's `RoomKind`. */
export type RealtimeKind = "conversation" | "document" | "application";

/** A named event published by an application room. */
export interface RealtimeNamedEvent {
	data: AppResponseValue;
	name: string;
}

/** Encode the application-room event control frame. */
export function encodeRealtimeEvent(event: {
	name: string;
	data: RealtimeWriteInput;
}): string {
	return JSON.stringify({ type: "event", event: event.name, data: event.data });
}

/** Decode an application-room event control frame, or `null` for another frame. */
export function decodeRealtimeEvent(raw: string): RealtimeNamedEvent | null {
	try {
		const parsed = realtimeFrame.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return null;
		}
		const frame = parsed.data;
		return frame.type === "event" &&
			realtimeString.safeParse(frame.event).success
			? { name: realtimeString.parse(frame.event), data: frame.data }
			: null;
	} catch {
		return null;
	}
}

// ── DocSync wire framing (1-byte tag, mirrors `collab::DocSyncMessage`) ──────

/** `SyncStep1`: "here is my state vector, send me the diff." */
export const DOC_SYNC_STEP1 = 0x00;
/** `SyncStep2`: the diff update answering a peer's `SyncStep1`. */
export const DOC_SYNC_STEP2 = 0x01;
/** `Update`: an incremental Yjs update. */
export const DOC_SYNC_UPDATE = 0x02;
/**
 * `Awareness`: an opaque Yjs awareness update (cursors/selections/presence for a
 * document). Relayed to the room's other members but never applied to the doc or
 * persisted by the gateway.
 */
export const DOC_SYNC_AWARENESS = 0x03;

/** The four DocSync message tags. */
export type DocSyncTag =
	| typeof DOC_SYNC_STEP1
	| typeof DOC_SYNC_STEP2
	| typeof DOC_SYNC_UPDATE
	| typeof DOC_SYNC_AWARENESS;

/** A decoded DocSync frame: a tag plus the opaque Yjs payload bytes. */
export interface DocSyncMessage {
	payload: Uint8Array;
	tag: DocSyncTag;
}

const DOC_SYNC_TAGS: readonly number[] = [
	DOC_SYNC_STEP1,
	DOC_SYNC_STEP2,
	DOC_SYNC_UPDATE,
	DOC_SYNC_AWARENESS,
];

/** Encode a DocSync message to its wire bytes (`<tag><payload>`). */
export function encodeDocSync(message: DocSyncMessage): Uint8Array {
	const out = new Uint8Array(message.payload.length + 1);
	out[0] = message.tag;
	out.set(message.payload, 1);
	return out;
}

/**
 * Decode DocSync wire bytes. Returns `null` for an empty buffer or an unknown
 * tag (fail-closed, mirroring the gateway's classifier) so the caller drops the
 * frame rather than misinterpreting it.
 */
export function decodeDocSync(bytes: Uint8Array): DocSyncMessage | null {
	if (bytes.length < 1) {
		return null;
	}
	const tag = bytes[0];
	if (tag === undefined || !DOC_SYNC_TAGS.includes(tag)) {
		return null;
	}
	// SAFETY: The preceding membership check accepts exactly the four private
	// DOC_SYNC_TAGS literals declared by DocSyncTag; the native byte payload is retained.
	return { tag: tag as DocSyncTag, payload: bytes.slice(1) };
}

// ── Connection ───────────────────────────────────────────────────────────────

/** The gateway's `join_ack`, normalized to camelCase. */
export interface JoinAck {
	/** Whether this connection may mutate the resource, or is a read-only viewer. */
	access: "read" | "write";
	/** Caller-generated correlation id echoed by Core. This is not an auth id. */
	clientId: string;
	/** Authoritative CRDT generation; zero for non-document rooms. */
	documentEpoch: number;
	/** Whether the server granted THIS connection the one-shot right to seed a
	 * brand-new empty room from its local `source`. Exactly one client per empty
	 * room wins this (server-arbitrated), so concurrent first-opens cannot both seed
	 * and duplicate the document body / columns. A read-only or late joiner is
	 * `false`. */
	maySeed: boolean;
	memberId: string;
	/** Current active-room presence roster, included for late joiners. */
	presence: AppResponseValue[];
	roomId: string;
}

export interface ResyncRequired {
	/** Number of bounded broadcast frames skipped, when Core can report it. */
	dropped?: number;
	reason: string;
}

/** Callbacks for the lifecycle + each inbound frame kind. All optional. */
export interface RealtimeHandlers {
	onClose?: (event: CloseEvent) => void;
	/** A binary DocSync frame (document rooms). Feed this to the CRDT provider. */
	onDocSync?: (message: DocSyncMessage) => void;
	/** The authoritative document was restored and its old CRDT epoch is fenced. */
	onDocumentReset?: (epoch: number) => void;
	onError?: (event: Event) => void;
	/** A `{ channel: "events" }` payload — e.g. a new chat message `data`. */
	onEvent?: (data: AppResponseValue) => void;
	/** The resolved access level for this connection, sent right after join. */
	onJoinAck?: (ack: JoinAck) => void;
	/** A named event from an application room. */
	onNamedEvent?: (event: RealtimeNamedEvent) => void;
	onOpen?: () => void;
	/** A `{ channel: "presence" }` payload — an awareness delta or leave. */
	onPresence?: (data: AppResponseValue) => void;
	/** The bounded room feed skipped state. Reload a snapshot or restart CRDT sync. */
	onResyncRequired?: (notice: ResyncRequired) => void;
}

export interface RealtimeOptions {
	/** Required when `kind` is `application`; never sent by the host bridge to the iframe. */
	appId?: string;
	/** Stable for this mounted client and shared with related HTTP mutations. */
	clientId?: string;
	handlers?: RealtimeHandlers;
	/** The user-identity JWT (Better Auth, EdDSA). Omit for an anonymous join. */
	jwt?: string | null;
	kind: RealtimeKind;
	roomId: string;
}

/** Build the credential-free `ws(s)://…/api/realtime/ws` URL from a node target. */
export function realtimeWsUrl(
	_target: ApiTarget,
	_options: RealtimeOptions
): string {
	const url = new URL(apiUrl(_target, "/api/realtime/ws"));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

/**
 * A single room connection. Construct, then call {@link connect}. The first frame
 * sent on open is always the `join` control frame; thereafter the caller pushes
 * presence / doc-sync and receives frames via the handlers.
 *
 * Reconnection is intentionally left to the caller (a surface knows when a node
 * is reachable and how to resync a CRDT doc), so this class stays a thin, honest
 * mapping over one socket.
 */
export class RealtimeConnection {
	private socket: WebSocket | null = null;
	private hasPresence = false;
	private lastPresence: RealtimeWriteInput;
	private keepalive: ReturnType<typeof setInterval> | null = null;
	private presenceHeartbeat: ReturnType<typeof setInterval> | null = null;
	private readonly target: ApiTarget;
	private readonly url: string;
	private readonly options: RealtimeOptions;
	private opening = false;
	private openAttempt = 0;
	readonly clientId: string;

	constructor(target: ApiTarget, options: RealtimeOptions) {
		this.target =
			options.jwt === undefined ? target : { ...target, userJwt: options.jwt };
		this.options = options;
		this.clientId = options.clientId ?? createRealtimeClientId();
		this.url = realtimeWsUrl(target, options);
	}

	/** Open the socket and send the `join` frame on connect. Idempotent-ish: a
	 * second call while already open is a no-op. */
	connect(): void {
		if (this.socket || this.opening) {
			return;
		}
		this.opening = true;
		const attempt = ++this.openAttempt;
		void this.openWithTicket(attempt);
	}

	private async openWithTicket(attempt: number): Promise<void> {
		const { handlers } = this.options;
		try {
			const ticket = await requestWebSocketTicket(this.target, {
				appId: this.options.appId,
				kind: this.options.kind,
				roomId: this.options.roomId,
				route: "realtime",
			});
			if (this.socket || attempt !== this.openAttempt) {
				return;
			}
			const socket = new WebSocket(appendWebSocketTicket(this.url, ticket));
			socket.binaryType = "arraybuffer";
			this.socket = socket;

			socket.onopen = () => {
				// The gateway REQUIRES the join frame first, and it must carry
				// `type: "join"` (the handshake in `realtime_ws.rs` gates on it, like
				// every other control frame). Anything else closes the socket (1003).
				this.sendText({
					type: "join",
					room_id: this.options.roomId,
					kind: this.options.kind,
					client_id: this.clientId,
					...(this.options.kind === "application" &&
						this.options.appId && { app_id: this.options.appId }),
				});
				this.startKeepalive();
				handlers?.onOpen?.();
			};
			socket.onmessage = (event) => this.dispatch(event);
			socket.onclose = (event) => {
				this.clearKeepalive();
				this.clearPresenceHeartbeat();
				if (this.socket === socket) {
					this.socket = null;
				}
				handlers?.onClose?.(event);
			};
			socket.onerror = (event) => handlers?.onError?.(event);
		} catch {
			if (realtimeFunction.safeParse(globalThis.Event).success) {
				handlers?.onError?.(new Event("error"));
			}
		} finally {
			if (attempt === this.openAttempt) {
				this.opening = false;
			}
		}
	}

	/** Publish this client's awareness payload (cursor/typing/name/etc.). The
	 * server stamps the member id before broadcasting. */
	publishPresence(data: RealtimeWriteInput): void {
		this.hasPresence = true;
		this.lastPresence = data;
		this.sendText({ type: "presence", data });
		if (this.presenceHeartbeat === null) {
			this.presenceHeartbeat = setInterval(() => {
				if (this.hasPresence) {
					this.sendText({ type: "presence", data: this.lastPresence });
				}
			}, 10_000);
		}
	}

	/** Send a DocSync frame (CRDT sync/update) for a document room. */
	sendDocSync(message: DocSyncMessage): void {
		this.sendBinary(encodeDocSync(message));
	}

	/** Publish a named event to an application room. */
	sendEvent(name: string, data: RealtimeWriteInput): void {
		// `sendText` stringifies once; pass the frame object (the same shape
		// `encodeRealtimeEvent` produces) so Core receives a JSON object, not a
		// JSON string literal it would silently ignore.
		this.sendText({ type: "event", event: name, data });
	}

	/** Liveness ping; the server replies with a `pong` (ignored by the dispatcher). */
	ping(): void {
		this.sendText({ type: "ping" });
	}

	/** Send an explicit `leave` (if still open) and close the socket. */
	close(): void {
		this.openAttempt += 1;
		this.opening = false;
		this.clearKeepalive();
		this.clearPresenceHeartbeat();
		if (this.socket?.readyState === WEBSOCKET_OPEN) {
			this.sendText({ type: "leave" });
		}
		this.socket?.close();
		this.socket = null;
	}

	private startKeepalive(): void {
		if (this.keepalive !== null) {
			return;
		}
		this.keepalive = setInterval(() => {
			this.ping();
		}, 10_000);
	}

	private clearKeepalive(): void {
		if (this.keepalive !== null) {
			clearInterval(this.keepalive);
			this.keepalive = null;
		}
	}

	private clearPresenceHeartbeat(): void {
		if (this.presenceHeartbeat !== null) {
			clearInterval(this.presenceHeartbeat);
			this.presenceHeartbeat = null;
		}
	}

	private dispatch(event: MessageEvent): void {
		const handlers = this.options.handlers;
		if (realtimeString.safeParse(event.data).success) {
			this.dispatchText(event.data, handlers);
			return;
		}
		if (event.data instanceof ArrayBuffer) {
			const message = decodeDocSync(new Uint8Array(event.data));
			if (message) {
				handlers?.onDocSync?.(message);
			}
		}
	}

	private dispatchText(
		raw: string,
		handlers: RealtimeHandlers | undefined
	): void {
		let parsed: ReturnType<typeof realtimeFrame.safeParse>;
		try {
			parsed = realtimeFrame.safeParse(JSON.parse(raw));
		} catch {
			// Malformed frame; the next one self-heals the feed.
			return;
		}
		if (!parsed.success) {
			return;
		}
		const frame = parsed.data;
		if (frame.type === "ping") {
			this.sendText({ type: "pong" });
			return;
		}
		if (frame.type === "join_ack") {
			handlers?.onJoinAck?.({
				access: frame.access === "write" ? "write" : "read",
				maySeed: frame.may_seed === true,
				clientId: String(frame.client_id ?? this.clientId),
				documentEpoch: realtimeNumber.safeParse(frame.document_epoch).success
					? realtimeNumber.parse(frame.document_epoch)
					: 0,
				memberId: String(frame.member_id ?? ""),
				presence: Array.isArray(frame.presence) ? frame.presence : [],
				roomId: String(frame.room_id ?? ""),
			});
			return;
		}
		if (frame.type === "resync_required") {
			handlers?.onResyncRequired?.({
				dropped:
					realtimeNumber.safeParse(frame.dropped).success &&
					Number.isSafeInteger(frame.dropped)
						? realtimeNumber.parse(frame.dropped)
						: undefined,
				reason: realtimeString.safeParse(frame.reason).success
					? realtimeString.parse(frame.reason)
					: "room-state-gap",
			});
			return;
		}
		if (frame.type === "document_reset") {
			if (
				realtimeNumber.safeParse(frame.epoch).success &&
				Number.isSafeInteger(frame.epoch)
			) {
				handlers?.onDocumentReset?.(realtimeNumber.parse(frame.epoch));
			}
			return;
		}
		if (frame.channel === "events") {
			handlers?.onEvent?.(frame.data);
			if (realtimeString.safeParse(frame.event).success) {
				handlers?.onNamedEvent?.({
					name: realtimeString.parse(frame.event),
					data: frame.data,
				});
			}
			return;
		}
		if (frame.channel === "presence") {
			handlers?.onPresence?.(frame.data);
		}
		// `pong` and any unknown control frame are ignored (forward-compatible).
	}

	private sendText(payload: RealtimeWriteInput): void {
		if (this.socket?.readyState === WEBSOCKET_OPEN) {
			this.socket.send(JSON.stringify(payload));
		}
	}

	private sendBinary(bytes: Uint8Array): void {
		if (this.socket?.readyState === WEBSOCKET_OPEN) {
			this.socket.send(bytes);
		}
	}
}

/** `WebSocket.OPEN` as a free constant so the class needs no instance to read it. */
const WEBSOCKET_OPEN = 1;

/** Create an opaque per-client correlation id without making it an auth input. */
export function createRealtimeClientId(): string {
	if (
		realtimeFunction.safeParse(globalThis.crypto?.getRandomValues).success ||
		realtimeFunction.safeParse(globalThis.crypto?.randomUUID).success
	) {
		try {
			return createResourceId();
		} catch {
			/* Preserve the legacy correlation-only fallback below. */
		}
	}
	const bytes = new Uint8Array(16);
	// This value is correlation metadata, never an auth input. A UUID-shaped
	// Math.random fallback keeps older React Native runtimes on the same echo-
	// suppression contract while the signed user JWT continues to own identity.
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Math.floor(Math.random() * 256);
	}
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
