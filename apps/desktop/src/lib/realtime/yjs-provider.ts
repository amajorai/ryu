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
import type { ApiTarget } from "@ryuhq/core-client/client.ts";
import {
	DOC_SYNC_AWARENESS,
	DOC_SYNC_STEP1,
	DOC_SYNC_STEP2,
	DOC_SYNC_UPDATE,
	type DocSyncMessage,
	type JoinAck,
	RealtimeConnection,
} from "@ryuhq/core-client/realtime.ts";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import {
	applyUpdate,
	Doc,
	decodeStateVector,
	encodeStateAsUpdate,
	encodeStateVector,
} from "yjs";
import { ContentSealLockedError } from "../content-seal.ts";
import {
	clearYjsSnapshot,
	currentCollaborationAccount,
	loadYjsSnapshot,
	releaseAccountYjsSnapshots,
	storeYjsSnapshot,
} from "./yjs-persistence.ts";

/** Live providers, so a sign-out can flush their local edits first. */
const liveProviders = new Set<RyuYjsProvider>();

/** True when `current` holds a client clock that `known` has not seen. */
function stateVectorAhead(
	current: Map<number, number>,
	known: Map<number, number> | null
): boolean {
	for (const [client, clock] of current) {
		if (clock > (known?.get(client) ?? 0)) {
			return true;
		}
	}
	return false;
}

/**
 * Connection state of a provider, for surfaces that must not claim to be live
 * while the socket is down.
 *
 * Deliberately separate from `isSynced`: a surface can be synced-once and still
 * be offline, and telling the user "Live" in that state is what made a dead grid
 * look healthy.
 */
export type RyuYjsStatus = "connecting" | "open" | "reconnecting" | "denied";

/** Core's `CLOSE_POLICY` close code — an ACL denial, never worth retrying. */
const CLOSE_POLICY = 1008;
/** First reconnect delay; doubles per attempt up to {@link RECONNECT_MAX_MS}. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** Optional lifecycle callbacks (mirrors `@platejs/yjs`'s ProviderEventHandlers). */
export interface RyuYjsProviderHandlers {
	onConnect?: () => void;
	onDisconnect?: () => void;
	onError?: (error: Error) => void;
	/** The resolved access for this connection (`read` => the server drops this
	 * member's mutations; surfaces so a caller can render a read-only UI). */
	onJoinAck?: (ack: JoinAck) => void;
	/** The server restored the document and fenced the previous CRDT epoch. */
	onReset?: (epoch: number) => void;
	/** Connection state changes (see {@link RyuYjsStatus}). */
	onStatusChange?: (status: RyuYjsStatus) => void;
	onSyncChange?: (isSynced: boolean) => void;
}

export interface RyuYjsProviderOptions {
	/** The account the local snapshot belongs to (null: anonymous). Defaults to
	 * the signed-in account at construction ({@link currentCollaborationAccount}). */
	account?: string | null;
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
	private discarded = false;
	private opening = false;
	private hydrated = false;
	/** Hydration hit a locked key: never overwrite the snapshot we could not read. */
	private persistBlocked = false;
	/** State vector Core is known to hold (sent while synced); null = unknown. */
	private serverStateVector: Map<number, number> | null = null;
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	/** Pending reconnect timer, if a retry is scheduled. */
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** Consecutive failed opens, for the backoff curve. Reset on a clean open. */
	private reconnectAttempt = 0;
	/** True once the caller asked us to stop; suppresses any further retry. */
	private closedByCaller = false;
	private status: RyuYjsStatus = "connecting";
	private readonly options: RyuYjsProviderOptions;
	private readonly onDocUpdate: Parameters<
		typeof Doc.prototype.on<"update">
	>[1];
	private readonly onPersistUpdate: () => void;
	private readonly onAwarenessUpdate: (
		changes: { added: number[]; removed: number[]; updated: number[] },
		origin: Parameters<typeof applyAwarenessUpdate>[2]
	) => void;

	/** The document room id this provider syncs (the Core document id). */
	get roomId(): string {
		return this.options.roomId;
	}

	constructor(options: RyuYjsProviderOptions) {
		this.options = {
			...options,
			account:
				options.account === undefined
					? currentCollaborationAccount()
					: options.account,
		};
		this.document = options.doc ?? new Doc();
		this.awareness = options.awareness ?? new Awareness(this.document);

		// Local doc edits -> broadcast as a DocSync Update. Updates we applied from
		// the network carry `this` as their origin and must NOT be re-sent.
		this.onDocUpdate = (update, origin) => {
			if (origin === this) {
				return;
			}
			this.send({ tag: DOC_SYNC_UPDATE, payload: update });
			if (this.isConnected && this.isSynced) {
				this.serverStateVector = decodeStateVector(
					encodeStateVector(this.document)
				);
			}
		};
		this.onPersistUpdate = () => {
			if (this.persistTimer !== null) {
				clearTimeout(this.persistTimer);
			}
			this.persistTimer = setTimeout(() => {
				this.persistTimer = null;
				void this.persistSnapshot();
			}, 250);
		};

		// Local awareness changes -> broadcast. Skip awareness we applied from the
		// network (origin === this) to avoid an echo loop.
		this.onAwarenessUpdate = (changes, origin) => {
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
		this.document.on("update", this.onPersistUpdate);
		liveProviders.add(this);
	}

	/** The account this provider's local snapshot is stored under. */
	get account(): string | null {
		return this.options.account ?? null;
	}

	/** Whether the doc holds edits Core has not been sent while synced. */
	hasUnsyncedChanges(): boolean {
		return stateVectorAhead(
			decodeStateVector(encodeStateVector(this.document)),
			this.serverStateVector
		);
	}

	/** Open the realtime connection (document room) and start syncing. Idempotent. */
	connect(): void {
		this.closedByCaller = false;
		if (this.connection || this.opening) {
			return;
		}
		this.opening = true;
		this.setStatus(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
		void this.hydrateThenOpen();
	}

	private async hydrateThenOpen(): Promise<void> {
		try {
			if (!this.hydrated) {
				const stored = await loadYjsSnapshot(
					this.options.roomId,
					this.options.account
				);
				if (stored && stored.update.length > 0) {
					applyUpdate(this.document, stored.update, this);
					if (stored.synced) {
						this.serverStateVector = decodeStateVector(
							encodeStateVector(this.document)
						);
					}
				}
				this.hydrated = true;
				this.persistBlocked = false;
			}
		} catch (error) {
			// A locked key is not a failed decrypt: keep the stored snapshot
			// untouched (no persist) and try again on the next connect.
			this.persistBlocked = error instanceof ContentSealLockedError;
			this.hydrated = !this.persistBlocked;
			this.options.handlers?.onError?.(
				error instanceof Error
					? error
					: new Error("Yjs snapshot hydration failed")
			);
		} finally {
			this.opening = false;
		}
		if (this.closedByCaller || this.connection) {
			return;
		}
		const connection = new RealtimeConnection(this.options.target, {
			roomId: this.options.roomId,
			kind: "document",
			jwt: this.options.jwt,
			handlers: {
				onOpen: () => this.handleOpen(),
				onClose: (event) => this.handleClose(event),
				onError: () =>
					this.options.handlers?.onError?.(new Error("realtime ws error")),
				onJoinAck: (ack) => this.options.handlers?.onJoinAck?.(ack),
				onDocSync: (message) => this.handleDocSync(message),
				onDocumentReset: (epoch) => {
					this.closedByCaller = true;
					this.discarded = true;
					void clearYjsSnapshot(this.options.roomId, this.options.account);
					this.connection?.close();
					this.options.handlers?.onReset?.(epoch);
				},
				onResyncRequired: () => {
					this.send({
						tag: DOC_SYNC_STEP1,
						payload: encodeStateVector(this.document),
					});
				},
			},
		});
		this.connection = connection;
		this.document.on("update", this.onDocUpdate);
		this.awareness.on("update", this.onAwarenessUpdate);
		connection.connect();
	}

	/** Close the connection and stop syncing, but keep the doc/awareness intact. */
	disconnect(): void {
		// An explicit close is terminal: never let a scheduled retry resurrect it.
		this.closedByCaller = true;
		this.clearReconnectTimer();
		this.reconnectAttempt = 0;
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
		if (this.persistTimer !== null) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		if (!this.discarded) {
			void this.persistSnapshot();
		}
		this.disconnect();
		this.document.off("update", this.onPersistUpdate);
		liveProviders.delete(this);
		this.awareness.destroy();
		// Only destroy a Doc we created; a caller-supplied doc is theirs to manage.
		if (!this.options.doc) {
			this.document.destroy();
		}
	}

	private handleOpen(): void {
		this.isConnected = true;
		this.reconnectAttempt = 0;
		this.setStatus("open");
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

	/**
	 * The socket died. Reconnect unless the caller closed us or the server denied
	 * us.
	 *
	 * This used to leave `this.connection` set, which wedged the provider
	 * permanently: `connect()` early-returns while a connection object exists, so
	 * nothing could ever re-open it. Both CRDT surfaces (the notes editor and the
	 * database grid) construct a provider directly rather than going through
	 * `useRealtimeRoom`, so this — not the hook — is where their reconnect has to
	 * live.
	 *
	 * Reconnecting is also what recovers the edits made while offline: the Y.Doc is
	 * deliberately preserved across a close, so on re-join Core's SyncStep1 is
	 * answered with `encodeStateAsUpdate`, which carries everything accumulated in
	 * the meantime. That is why this is the fix for the silent-edit-loss bug rather
	 * than a JSON write-behind path — a JSON PUT writes `source`, which the CRDT
	 * overwrites on the next sync.
	 */
	private handleClose(event?: CloseEvent): void {
		this.isConnected = false;
		this.setSynced(false);
		this.options.handlers?.onDisconnect?.();

		// Detach and drop the dead connection so `connect()` can build a new one.
		// The listeners are re-attached by `connect()`; leaving them on would
		// double-send every local update after a reconnect.
		this.document.off("update", this.onDocUpdate);
		this.awareness.off("update", this.onAwarenessUpdate);
		this.connection = null;

		if (this.closedByCaller) {
			return;
		}

		// 1008 is Core's CLOSE_POLICY: an ACL denial (anonymous-on-scoped-resource,
		// forbidden, unknown-resource). Retrying a permission error turns it into a
		// self-inflicted DoS against the node, so this state is terminal.
		if (event?.code === CLOSE_POLICY) {
			this.setStatus("denied");
			return;
		}

		this.setStatus("reconnecting");
		this.scheduleReconnect();
	}

	/** Re-open after an exponential backoff with jitter (1s → 30s ceiling). */
	private scheduleReconnect(): void {
		this.clearReconnectTimer();
		const base = Math.min(
			RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
			RECONNECT_MAX_MS
		);
		// Jitter so every editor in a room does not stampede the node in lockstep
		// after a Core restart.
		const delay = base / 2 + Math.random() * (base / 2);
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (this.closedByCaller) {
				return;
			}
			this.connect();
		}, delay);
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private setStatus(value: RyuYjsStatus): void {
		if (this.status === value) {
			return;
		}
		this.status = value;
		this.options.handlers?.onStatusChange?.(value);
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
				// Our own SyncStep2 (everything Core lacked) went out before this
				// answer, on the same ordered socket.
				this.serverStateVector = decodeStateVector(
					encodeStateVector(this.document)
				);
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

	/** Write the sealed snapshot now (sign-out flush). */
	async flushSnapshot(): Promise<void> {
		if (this.persistTimer !== null) {
			clearTimeout(this.persistTimer);
			this.persistTimer = null;
		}
		await this.persistSnapshot();
	}

	private async persistSnapshot(): Promise<void> {
		if (this.discarded || this.persistBlocked) {
			return;
		}
		try {
			await storeYjsSnapshot(
				this.options.roomId,
				encodeStateAsUpdate(this.document),
				{
					account: this.options.account,
					synced: !this.hasUnsyncedChanges(),
				}
			);
		} catch (error) {
			this.options.handlers?.onError?.(
				error instanceof Error
					? error
					: new Error("Yjs snapshot persistence failed")
			);
		}
	}
}

/** How long a sign-out waits for a live document to finish syncing. */
const FLUSH_WAIT_MS = 3000;

function waitForSync(
	provider: RyuYjsProvider,
	timeoutMs: number
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const check = () => {
			if (!provider.hasUnsyncedChanges() || Date.now() >= deadline) {
				resolve();
				return;
			}
			setTimeout(check, 100);
		};
		check();
	});
}

/**
 * Sign-out or account switch for `account`: give live documents a moment to
 * send their local edits to Core, write their snapshots, then delete every
 * snapshot of that account whose edits all reached Core. Snapshots with edits
 * Core never received are kept (sealed, never loaded for another account) and
 * counted, so the caller can warn the user instead of losing them silently.
 */
export async function releaseCollaborationAccount(
	account: string | null,
	timeoutMs = FLUSH_WAIT_MS
): Promise<{ cleared: number; kept: number }> {
	const providers = [...liveProviders].filter(
		(provider) => provider.account === account
	);
	await Promise.all(
		providers.map(async (provider) => {
			if (provider.hasUnsyncedChanges() && provider.isConnected) {
				await waitForSync(provider, timeoutMs);
			}
			await provider.flushSnapshot();
		})
	);
	return releaseAccountYjsSnapshots(account);
}
