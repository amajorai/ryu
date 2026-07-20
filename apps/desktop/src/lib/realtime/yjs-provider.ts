// apps/desktop/src/lib/realtime/yjs-provider.ts
//
// A `@platejs/yjs` `UnifiedProvider` backed by the shared `RealtimeConnection`
// (packages/core-client). It bridges a Yjs document to Core's authoritative
// per-room CRDT (apps/core/src/collab) over the realtime ws, so the Plate notes
// editor (and any other Yjs surface) syncs through the same gateway as chat and
// presence — no Hocuspocus/WebRTC server required.
//
// Wire protocol (1-byte DocSync tag, byte-identical to Core):
//   - SyncStep1  (0x00): peer's state vector. We answer with SyncStep2 (the diff
//     they're missing) AND send our own SyncStep1 so we receive their diff.
//   - SyncStep2  (0x01): a diff answering our SyncStep1 -> applyUpdate.
//   - Update     (0x02): an incremental update -> applyUpdate.
//   - Awareness  (0x03): an opaque y-protocols awareness update -> applied to
//     our Awareness; relayed by Core but never persisted.
//
// On join Core sends us a SyncStep1, so `connect()` does not send one proactively
// — it only responds. Remote updates are applied with `this` as the Yjs origin so
// our own `doc.on('update')` handler can skip re-broadcasting them (the classic
// echo-loop trap).

import type { UnifiedProvider } from "@platejs/yjs";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	DOC_SYNC_AWARENESS,
	DOC_SYNC_STEP1,
	DOC_SYNC_STEP2,
	DOC_SYNC_UPDATE,
	type DocSyncMessage,
	type JoinAck,
	RealtimeConnection,
} from "@ryuhq/core-client/realtime";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector } from "yjs";

/** Optional lifecycle callbacks (mirrors `@platejs/yjs`'s ProviderEventHandlers). */
export interface RyuYjsProviderHandlers {
	onConnect?: () => void;
	onDisconnect?: () => void;
	onError?: (error: Error) => void;
	/** The resolved access for this connection (`read` => the server drops this
	 * member's mutations; surfaces so a caller can render a read-only UI). */
	onJoinAck?: (ack: JoinAck) => void;
	onSyncChange?: (isSynced: boolean) => void;
}

export interface RyuYjsProviderOptions {
	/** Existing awareness to share with the editor; one is created if omitted. */
	awareness?: Awareness;
	/** Existing Doc to bind; a fresh one is created if omitted. */
	doc?: Doc;
	handlers?: RyuYjsProviderHandlers;
	/** The user-identity JWT (or null for an anonymous, read-only join). */
	jwt?: string | null;
	/** The document room id (the Core document id). */
	roomId: string;
	/** The active node target (base url + node token). */
	target: ApiTarget;
}

/**
 * A Core-backed Yjs provider. Construct it, pass the instance to
 * `YjsPlugin.configure({ options: { providers: [provider] } })`, and the plugin
 * shares this provider's `document` + `awareness`. `connect()`/`destroy()` are
 * driven by `editor.getApi(YjsPlugin).yjs.init`/`destroy`.
 */
export class RyuYjsProvider implements UnifiedProvider {
	readonly awareness: Awareness;
	readonly document: Doc;
	readonly type = "ryu";
	isConnected = false;
	isSynced = false;

	private connection: RealtimeConnection | null = null;
	private readonly options: RyuYjsProviderOptions;
	private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
	private readonly onAwarenessUpdate: (
		changes: { added: number[]; removed: number[]; updated: number[] },
		origin: unknown
	) => void;

	/** The document room id this provider syncs (the Core document id). */
	get roomId(): string {
		return this.options.roomId;
	}

	constructor(options: RyuYjsProviderOptions) {
		this.options = options;
		this.document = options.doc ?? new Doc();
		this.awareness = options.awareness ?? new Awareness(this.document);

		// Local doc edits -> broadcast as a DocSync Update. Updates we applied from
		// the network carry `this` as their origin and must NOT be re-sent.
		this.onDocUpdate = (update: Uint8Array, origin: unknown) => {
			if (origin === this) {
				return;
			}
			this.send({ tag: DOC_SYNC_UPDATE, payload: update });
		};

		// Local awareness changes -> broadcast. Skip awareness we applied from the
		// network (origin === this) to avoid an echo loop.
		this.onAwarenessUpdate = (
			changes: { added: number[]; removed: number[]; updated: number[] },
			origin: unknown
		) => {
			if (origin === this) {
				return;
			}
			const changed = [
				...changes.added,
				...changes.updated,
				...changes.removed,
			];
			this.send({
				tag: DOC_SYNC_AWARENESS,
				payload: encodeAwarenessUpdate(this.awareness, changed),
			});
		};
	}

	/** Open the realtime connection (document room) and start syncing. Idempotent. */
	connect(): void {
		if (this.connection) {
			return;
		}
		const connection = new RealtimeConnection(this.options.target, {
			roomId: this.options.roomId,
			kind: "document",
			jwt: this.options.jwt,
			handlers: {
				onOpen: () => this.handleOpen(),
				onClose: () => this.handleClose(),
				onError: () =>
					this.options.handlers?.onError?.(new Error("realtime ws error")),
				onJoinAck: (ack) => this.options.handlers?.onJoinAck?.(ack),
				onDocSync: (message) => this.handleDocSync(message),
			},
		});
		this.connection = connection;
		this.document.on("update", this.onDocUpdate);
		this.awareness.on("update", this.onAwarenessUpdate);
		connection.connect();
	}

	/** Close the connection and stop syncing, but keep the doc/awareness intact. */
	disconnect(): void {
		// Drop our awareness state FIRST, while the listener is still attached and
		// the socket is still open, so the resulting `update` is broadcast as a
		// DocSync Awareness frame and peers stop rendering our cursor immediately
		// (otherwise it lingers until y-protocols' outdated-timeout culls it).
		removeAwarenessStates(
			this.awareness,
			[this.document.clientID],
			"disconnect"
		);
		this.document.off("update", this.onDocUpdate);
		this.awareness.off("update", this.onAwarenessUpdate);
		this.connection?.close();
		this.connection = null;
		this.setSynced(false);
		this.isConnected = false;
		this.options.handlers?.onDisconnect?.();
	}

	/** Tear down everything (called on editor unmount). */
	destroy(): void {
		this.disconnect();
		this.awareness.destroy();
		// Only destroy a Doc we created; a caller-supplied doc is theirs to manage.
		if (!this.options.doc) {
			this.document.destroy();
		}
	}

	private handleOpen(): void {
		this.isConnected = true;
		this.options.handlers?.onConnect?.();
		// Announce our presence/cursor immediately so peers render us before the
		// first edit; Core relays this awareness frame to the room.
		const localState = this.awareness.getLocalState();
		if (localState) {
			this.send({
				tag: DOC_SYNC_AWARENESS,
				payload: encodeAwarenessUpdate(this.awareness, [
					this.document.clientID,
				]),
			});
		}
	}

	private handleClose(): void {
		this.isConnected = false;
		this.setSynced(false);
		this.options.handlers?.onDisconnect?.();
	}

	private handleDocSync(message: DocSyncMessage): void {
		switch (message.tag) {
			case DOC_SYNC_STEP1: {
				// Peer's state vector: answer with the diff they lack, then ask for ours.
				this.send({
					tag: DOC_SYNC_STEP2,
					payload: encodeStateAsUpdate(this.document, message.payload),
				});
				this.send({
					tag: DOC_SYNC_STEP1,
					payload: encodeStateVector(this.document),
				});
				break;
			}
			case DOC_SYNC_STEP2: {
				applyUpdate(this.document, message.payload, this);
				this.setSynced(true);
				break;
			}
			case DOC_SYNC_UPDATE: {
				applyUpdate(this.document, message.payload, this);
				break;
			}
			case DOC_SYNC_AWARENESS: {
				applyAwarenessUpdate(this.awareness, message.payload, this);
				break;
			}
			default:
				break;
		}
	}

	private setSynced(value: boolean): void {
		if (this.isSynced === value) {
			return;
		}
		this.isSynced = value;
		this.options.handlers?.onSyncChange?.(value);
	}

	private send(message: DocSyncMessage): void {
		this.connection?.sendDocSync(message);
	}
}
