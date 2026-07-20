// apps/desktop/src/lib/realtime/use-database-collab.ts
//
// React hook that opens a collaborative CRDT room for a Spaces "database"
// document and keeps a Yjs doc synced through the shared RyuYjsProvider (one
// `kind:"document"` realtime room per database id). It owns the provider
// lifecycle, the first-sync seed decision, and the observe -> snapshot bridge;
// the page supplies the seed (its loaded JSON) and a sink that adopts each
// snapshot into render state.
//
// Persistence note: Core stores the CRDT (collab.db) and rebroadcasts, but its
// Y.Doc -> source materialize is still dormant (see apps/core/src/collab). So the
// authoritative grid state lives in the CRDT; the page disables its per-edit
// full-JSON PUT while collaborative.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Doc } from "yjs";
import { getRealtimeJwt } from "./jwt.ts";
import {
	type DatabaseDoc,
	type DbColumn,
	type DbRow,
	type DbView,
	isDatabaseEmpty,
	observeDatabase,
	seedDatabase,
	snapshotDatabase,
} from "./yjs-database.ts";
import { RyuYjsProvider } from "./yjs-provider.ts";

/** A render snapshot derived from the authoritative Yjs doc. */
export interface DatabaseSnapshot {
	columns: DbColumn[];
	rows: DbRow[];
	views: DbView[];
}

export interface UseDatabaseCollabOptions {
	/** Produce the seed for a first-into-an-empty-room client (the loaded JSON). */
	getSeed: () => DatabaseDoc;
	/** Adopt a snapshot into render state (fires on first sync and every change). */
	onSnapshot: (snapshot: DatabaseSnapshot) => void;
	/** Gate: don't connect until the page has loaded its initial JSON (we need it
	 * to seed an empty room). */
	ready: boolean;
	/** The database document id (the realtime room id). */
	roomId: string;
	/** Active node token (or null). */
	token: string | null;
	/** Active node base url. */
	url: string;
}

export interface DatabaseCollab {
	/** Resolved access for this connection (`read` => the server drops our
	 * mutations, so the grid must be read-only); `null` until the join is acked. */
	access: "read" | "write" | null;
	/** True once the room has synced and edits should route to the CRDT. */
	collaborative: boolean;
	/** The live Yjs doc while collaborative, else `null` (stable identity). */
	getCollabDoc: () => Doc | null;
}

/**
 * On first sync, seed an empty room from the loaded JSON — but ONLY when the
 * server granted this client the seed claim (`maySeed`). Two clients opening the
 * same brand-new room concurrently would otherwise both pass the emptiness check
 * and both seed, duplicating columns (same `col_name` id) and rows. The server
 * arbitrates exactly one seeder; the local emptiness check stays as defense in
 * depth. Either way the resulting snapshot is adopted into render state.
 */
function syncFirstTime(
	doc: Doc,
	maySeed: boolean,
	getSeed: () => DatabaseDoc,
	onSnapshot: (snapshot: DatabaseSnapshot) => void
): void {
	if (maySeed && isDatabaseEmpty(doc)) {
		seedDatabase(doc, getSeed());
	}
	onSnapshot(snapshotDatabase(doc));
}

/**
 * Join the database's realtime room and stay synced for the component's lifetime.
 * Returns whether collaboration is live plus a stable getter for the Yjs doc that
 * the page's grid callbacks consult (truthy => route the edit to the CRDT).
 */
export function useDatabaseCollab(
	options: UseDatabaseCollabOptions
): DatabaseCollab {
	const { roomId, ready, url, token } = options;
	const [collaborative, setCollaborative] = useState(false);
	const [access, setAccess] = useState<"read" | "write" | null>(null);
	const docRef = useRef<Doc | null>(null);
	const collaborativeRef = useRef(false);

	// Read seed/sink through refs so they may be fresh each render without
	// re-arming the connection effect.
	const getSeedRef = useRef(options.getSeed);
	getSeedRef.current = options.getSeed;
	const onSnapshotRef = useRef(options.onSnapshot);
	onSnapshotRef.current = options.onSnapshot;

	useEffect(() => {
		if (!ready) {
			return;
		}
		let cancelled = false;
		let provider: RyuYjsProvider | null = null;
		let unobserve: (() => void) | null = null;
		let syncedOnce = false;
		// Captured from join_ack (which always precedes the first sync): whether the
		// server granted THIS client the one-shot seed claim for an empty room.
		let maySeed = false;

		const setup = async () => {
			const jwt = await getRealtimeJwt();
			if (cancelled) {
				return;
			}
			const created = new RyuYjsProvider({
				roomId,
				target: { url, token },
				jwt,
				handlers: {
					onJoinAck: (ack) => {
						maySeed = ack.maySeed;
						if (!cancelled) {
							setAccess(ack.access);
						}
					},
					onSyncChange: (synced) => {
						if (!synced || syncedOnce || cancelled) {
							return;
						}
						syncedOnce = true;
						syncFirstTime(
							created.document,
							maySeed,
							getSeedRef.current,
							onSnapshotRef.current
						);
						collaborativeRef.current = true;
						setCollaborative(true);
					},
				},
			});
			provider = created;
			docRef.current = created.document;
			unobserve = observeDatabase(created.document, () => {
				onSnapshotRef.current(snapshotDatabase(created.document));
			});
			created.connect();
		};

		setup().catch(() => {
			// A failed JWT exchange degrades to a non-collaborative (local) grid;
			// there is nothing actionable to surface here.
		});

		return () => {
			cancelled = true;
			unobserve?.();
			provider?.destroy();
			docRef.current = null;
			collaborativeRef.current = false;
			setCollaborative(false);
			setAccess(null);
		};
	}, [ready, roomId, url, token]);

	const getCollabDoc = useCallback(
		() => (collaborativeRef.current ? docRef.current : null),
		[]
	);

	return { access, collaborative, getCollabDoc };
}
