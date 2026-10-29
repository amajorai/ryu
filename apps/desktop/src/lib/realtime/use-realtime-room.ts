// apps/desktop/src/lib/realtime/useRealtimeRoom.ts
//
// React hook over the shared `RealtimeConnection` (packages/core-client). Every
// collaborative desktop surface (chat fan-out, the Plate notes editor, the data
// grid) joins its room through this one hook, so the JWT exchange, active-node
// resolution, lifecycle, and reconnect-storm avoidance live in exactly one
// place.
//
// Lifecycle: on mount (and whenever the room or the active node changes) it
// fetches the user JWT, builds a `RealtimeConnection`, and `connect()`s; on
// unmount (or before re-running) it `close()`s. Reconnect-on-drop is
// deliberately NOT implemented here — core-client leaves reconnection to a
// caller that knows when a node is reachable, and adding it now would be scope
// creep.

import {
	type DocSyncMessage,
	type JoinAck,
	RealtimeConnection,
	type RealtimeHandlers,
	type RealtimeKind,
} from "@ryuhq/core-client/realtime.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { realtimeJwtForTarget } from "@/src/lib/api/client.ts";

/** What a surface gets back from {@link useRealtimeRoom}. */
export interface RealtimeRoom {
	/** Resolved access for this connection, or `null` until the join is acked. */
	access: "read" | "write" | null;
	/** Opaque correlation id shared with related HTTP mutations. */
	clientId: string | null;
	/** True between socket-open and socket-close. */
	connected: boolean;
	/** The live connection once constructed, else `null`. Surfaces that drive
	 * doc-sync directly (the Yjs provider) read this; most use the helpers below. */
	connection: RealtimeConnection | null;
	/** Server-issued id for this concrete room membership. */
	memberId: string | null;
	/** Publish this client's awareness/presence payload (the server stamps the
	 * member id). No-op until the connection is open. */
	publishPresence: RealtimeConnection["publishPresence"];
	/** Send a CRDT doc-sync frame (document rooms only). No-op until open. */
	sendDocSync: (message: DocSyncMessage) => void;
}

/**
 * Join `roomId` (a conversation or document) on the active node and stay
 * connected for the component's lifetime.
 *
 * `handlers` may be a fresh object every render — it is read through a ref so it
 * never triggers a reconnect. The connection is rebuilt only when `roomId`,
 * `kind`, or the active node's `url`/`token` change.
 */
export function useRealtimeRoom(
	roomId: string | null,
	kind: RealtimeKind,
	handlers?: RealtimeHandlers,
	clientId?: string
): RealtimeRoom {
	const node = useActiveNode();
	const { url } = node;
	const token = node.token ?? null;
	const userJwt = node.userJwt ?? null;

	const handlersRef = useRef<RealtimeHandlers | undefined>(handlers);
	handlersRef.current = handlers;

	const connectionRef = useRef<RealtimeConnection | null>(null);
	const [connection, setConnection] = useState<RealtimeConnection | null>(null);
	const [connected, setConnected] = useState(false);
	const [access, setAccess] = useState<"read" | "write" | null>(null);
	const [resolvedClientId, setResolvedClientId] = useState<string | null>(null);
	const [memberId, setMemberId] = useState<string | null>(null);

	useEffect(() => {
		if (!roomId) {
			return;
		}
		let cancelled = false;

		const composed: RealtimeHandlers = {
			onClose: (event) => {
				if (cancelled) {
					return;
				}
				setConnected(false);
				handlersRef.current?.onClose?.(event);
			},
			onDocSync: (message) => handlersRef.current?.onDocSync?.(message),
			onError: (event) => handlersRef.current?.onError?.(event),
			onEvent: (data) => handlersRef.current?.onEvent?.(data),
			onJoinAck: (ack: JoinAck) => {
				if (!cancelled) {
					setAccess(ack.access);
					setResolvedClientId(ack.clientId);
					setMemberId(ack.memberId);
				}
				handlersRef.current?.onJoinAck?.(ack);
			},
			onOpen: () => {
				if (!cancelled) {
					setConnected(true);
				}
				handlersRef.current?.onOpen?.();
			},
			onPresence: (data) => handlersRef.current?.onPresence?.(data),
			onResyncRequired: (notice) =>
				handlersRef.current?.onResyncRequired?.(notice),
		};

		const open = async () => {
			const jwt = await realtimeJwtForTarget({ url, token, userJwt });
			// An unmount (or a dep change) during the async exchange must not leave a
			// zombie socket behind.
			if (cancelled) {
				return;
			}
			const conn = new RealtimeConnection(
				{ url, token, userJwt },
				{ roomId, kind, jwt, handlers: composed, clientId }
			);
			connectionRef.current = conn;
			setConnection(conn);
			conn.connect();
		};
		open().catch(() => {
			// A failed JWT exchange already degrades to an anonymous join inside
			// `open`; there is nothing actionable to surface here.
		});

		return () => {
			cancelled = true;
			connectionRef.current?.close();
			connectionRef.current = null;
			setConnection(null);
			setConnected(false);
			setAccess(null);
			setResolvedClientId(null);
			setMemberId(null);
		};
	}, [roomId, kind, url, token, userJwt, clientId]);

	const publishPresence = useCallback(
		(data: Parameters<RealtimeConnection["publishPresence"]>[0]) => {
			connectionRef.current?.publishPresence(data);
		},
		[]
	);
	const sendDocSync = useCallback((message: DocSyncMessage) => {
		connectionRef.current?.sendDocSync(message);
	}, []);

	return {
		access,
		clientId: resolvedClientId,
		connected,
		connection,
		memberId,
		publishPresence,
		sendDocSync,
	};
}
