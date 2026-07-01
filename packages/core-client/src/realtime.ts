// packages/core-client/src/realtime.ts
//
// Shared client for Core's room-keyed realtime gateway (`GET /api/realtime/ws`,
// Phase 1/3 of the multi-user collaboration epic). One transport for every
// surface: desktop (Tauri webview), mobile (React Native), CLI — all reuse this
// verbatim. It speaks the gateway's wire protocol exactly:
//
//   Client -> server (the FIRST frame MUST be `join`):
//     - join:     text `{ room_id, kind }`            (kind: conversation|document)
//     - presence: text `{ type: "presence", data }`   (the server stamps member_id)
//     - ping:     text `{ type: "ping" }`             (server replies `{type:"pong"}`)
//     - leave:    text `{ type: "leave" }`
//     - doc-sync: BINARY `<1-byte tag><payload>`       (CRDT, document rooms only)
//
//   Server -> client:
//     - join_ack: text `{ type: "join_ack", room_id, member_id, access }`
//     - events:   text `{ channel: "events",   data }` (e.g. a new chat message)
//     - presence: text `{ channel: "presence", data }` (awareness deltas / leaves)
//     - doc-sync: BINARY `<1-byte tag><payload>`
//
// Browsers cannot set headers on a WS upgrade, so the node-admittance token and
// the optional user-identity JWT ride query params (`?token=` / `?jwt=`), exactly
// as the gateway expects. Uses the global `WebSocket` (a web standard present in
// browsers, React Native, and Bun/Node) so this stays platform-agnostic like the
// rest of `core-client`.

import { type ApiTarget, apiUrl } from "./client.ts";

/** Which resource a room maps to. Mirrors the gateway's `RoomKind`. */
export type RealtimeKind = "conversation" | "document";

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
	if (!DOC_SYNC_TAGS.includes(tag)) {
		return null;
	}
	return { tag: tag as DocSyncTag, payload: bytes.slice(1) };
}

// ── Connection ───────────────────────────────────────────────────────────────

/** The gateway's `join_ack`, normalized to camelCase. */
export interface JoinAck {
	/** Whether this connection may mutate the resource, or is a read-only viewer. */
	access: "read" | "write";
	/** Whether the server granted THIS connection the one-shot right to seed a
	 * brand-new empty room from its local `source`. Exactly one client per empty
	 * room wins this (server-arbitrated), so concurrent first-opens cannot both seed
	 * and duplicate the document body / columns. A read-only or late joiner is
	 * `false`. */
	maySeed: boolean;
	memberId: string;
	roomId: string;
}

/** Callbacks for the lifecycle + each inbound frame kind. All optional. */
export interface RealtimeHandlers {
	onClose?: (event: CloseEvent) => void;
	/** A binary DocSync frame (document rooms). Feed this to the CRDT provider. */
	onDocSync?: (message: DocSyncMessage) => void;
	onError?: (event: Event) => void;
	/** A `{ channel: "events" }` payload — e.g. a new chat message `data`. */
	onEvent?: (data: unknown) => void;
	/** The resolved access level for this connection, sent right after join. */
	onJoinAck?: (ack: JoinAck) => void;
	onOpen?: () => void;
	/** A `{ channel: "presence" }` payload — an awareness delta or leave. */
	onPresence?: (data: unknown) => void;
}

export interface RealtimeOptions {
	handlers?: RealtimeHandlers;
	/** The user-identity JWT (Better Auth, EdDSA). Omit for an anonymous join. */
	jwt?: string | null;
	kind: RealtimeKind;
	roomId: string;
}

/** Build the `ws(s)://…/api/realtime/ws?token=&jwt=` URL from a node target. */
export function realtimeWsUrl(
	target: ApiTarget,
	options: RealtimeOptions
): string {
	const url = new URL(apiUrl(target, "/api/realtime/ws"));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	if (target.token) {
		url.searchParams.set("token", target.token);
	}
	if (options.jwt) {
		url.searchParams.set("jwt", options.jwt);
	}
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
	private readonly url: string;
	private readonly options: RealtimeOptions;

	constructor(target: ApiTarget, options: RealtimeOptions) {
		this.options = options;
		this.url = realtimeWsUrl(target, options);
	}

	/** Open the socket and send the `join` frame on connect. Idempotent-ish: a
	 * second call while already open is a no-op. */
	connect(): void {
		if (this.socket) {
			return;
		}
		const socket = new WebSocket(this.url);
		socket.binaryType = "arraybuffer";
		this.socket = socket;
		const { handlers } = this.options;

		socket.onopen = () => {
			// The gateway REQUIRES the join frame first; anything else closes the socket.
			this.sendText({ room_id: this.options.roomId, kind: this.options.kind });
			handlers?.onOpen?.();
		};
		socket.onmessage = (event) => this.dispatch(event);
		socket.onclose = (event) => handlers?.onClose?.(event);
		socket.onerror = (event) => handlers?.onError?.(event);
	}

	/** Publish this client's awareness payload (cursor/typing/name/etc.). The
	 * server stamps the member id before broadcasting. */
	publishPresence(data: unknown): void {
		this.sendText({ type: "presence", data });
	}

	/** Send a DocSync frame (CRDT sync/update) for a document room. */
	sendDocSync(message: DocSyncMessage): void {
		this.sendBinary(encodeDocSync(message));
	}

	/** Liveness ping; the server replies with a `pong` (ignored by the dispatcher). */
	ping(): void {
		this.sendText({ type: "ping" });
	}

	/** Send an explicit `leave` (if still open) and close the socket. */
	close(): void {
		if (this.socket?.readyState === WEBSOCKET_OPEN) {
			this.sendText({ type: "leave" });
		}
		this.socket?.close();
		this.socket = null;
	}

	private dispatch(event: MessageEvent): void {
		const handlers = this.options.handlers;
		if (typeof event.data === "string") {
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
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			// Malformed frame; the next one self-heals the feed.
			return;
		}
		if (typeof value !== "object" || value === null) {
			return;
		}
		const frame = value as Record<string, unknown>;
		if (frame.type === "join_ack") {
			handlers?.onJoinAck?.({
				access: frame.access === "write" ? "write" : "read",
				maySeed: frame.may_seed === true,
				memberId: String(frame.member_id ?? ""),
				roomId: String(frame.room_id ?? ""),
			});
			return;
		}
		if (frame.channel === "events") {
			handlers?.onEvent?.(frame.data);
			return;
		}
		if (frame.channel === "presence") {
			handlers?.onPresence?.(frame.data);
		}
		// `pong` and any unknown control frame are ignored (forward-compatible).
	}

	private sendText(payload: unknown): void {
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
