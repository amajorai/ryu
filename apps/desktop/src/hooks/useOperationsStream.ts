// apps/desktop/src/hooks/useOperationsStream.ts
//
// Keeps the operations store in step with the active node. Mount it once near
// the app shell, next to `useDownloadsStream`.
//
// Unlike downloads, operations are not a channel of the node's shared event
// socket, and the browser allows only a few sockets per host. So this hook
// does two things:
//   1. On every node connect it reads the list once. That finds an import that
//      is still running after the app was reloaded, or one the node resumed
//      after a restart.
//   2. Only while the store holds a queued or running operation does it keep
//      the operations stream open. The stream starts with a snapshot, so a
//      reconnect after a node restart needs no extra read. When the last
//      operation finishes the socket is closed again.

import { useEffect } from "react";
import { abortableDelay } from "@/src/lib/abortable-delay.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	listOperations,
	type OperationEvent,
	streamOperations,
} from "@/src/lib/api/operations.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	selectHasActiveOperation,
	useOperationsStore,
} from "@/src/store/useOperationsStore.ts";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

function applyEvent(event: OperationEvent): void {
	const store = useOperationsStore.getState();
	if (event.type === "snapshot") {
		store.applySnapshot(event.operations);
	} else if (event.type === "update") {
		store.applyUpdate(event.operation);
	} else {
		store.removeOperation(event.id);
	}
}

export function useOperationsStream(): void {
	// Follows the active node, like the downloads stream. A managed node may
	// authenticate with the user's delegation JWT instead of a node token.
	const node = useNodeStore((s) => s.getActiveNode());
	const url = node.url;
	const token = node.token;
	const userJwt = node.userJwt;
	const hasActive = useOperationsStore(selectHasActiveOperation);

	// 1. One list per node connect.
	useEffect(() => {
		const controller = new AbortController();
		const target = toTarget({ url, token, userJwt });
		// Operations belong to the node they run on.
		useOperationsStore.getState().reset();
		listOperations(target)
			.then((operations) => {
				if (!controller.signal.aborted) {
					useOperationsStore.getState().applySnapshot(operations);
				}
			})
			// A node without the operations service answers 404. Nothing to show.
			.catch(() => undefined);
		return () => {
			controller.abort();
		};
	}, [url, token, userJwt]);

	// 2. The stream, only while something is queued or running.
	useEffect(() => {
		if (!hasActive) {
			return;
		}
		const controller = new AbortController();
		const target = toTarget({ url, token, userJwt });
		const run = async () => {
			let backoff = INITIAL_BACKOFF_MS;
			while (!controller.signal.aborted) {
				try {
					await streamOperations(
						target,
						(event) => {
							backoff = INITIAL_BACKOFF_MS;
							applyEvent(event);
						},
						controller.signal
					);
				} catch {
					// The node went away or restarted. Try again below.
				}
				if (controller.signal.aborted) {
					return;
				}
				await abortableDelay(backoff, controller.signal);
				backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
			}
		};
		run().catch(() => undefined);
		return () => {
			controller.abort();
		};
	}, [hasActive, url, token, userJwt]);
}
