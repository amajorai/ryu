// apps/desktop/src/store/useOperationsStore.ts
//
// Client mirror of Core's operations service (long work that runs off its
// request, an import today). `useOperationsStream` fills it: one list per node
// connect, then the operations stream while something is queued or running.
// Surfaces do not keep results in component state. They hold a surface key
// here, which names the operations they started, so closing and reopening a
// dialog shows the same progress and the same results.

import { create } from "zustand";
import {
	isActiveOperation,
	isOwnOperation,
	type Operation,
	type OperationViewer,
} from "@/src/lib/api/operations.ts";

interface OperationsState {
	/** Replace the mirror with what the node sent (list or stream snapshot).
	 *  An operation a surface is watching stays even when the snapshot was
	 *  taken before it started. */
	applySnapshot: (operations: Operation[]) => void;
	/** Upsert one operation (a stream change, or the answer of a start). */
	applyUpdate: (operation: Operation) => void;
	/** Full records by id (with checkpoint and result), from a single read. */
	details: Record<string, Operation>;
	/** Operations by id, as lists and the stream carry them. */
	operations: Record<string, Operation>;
	/** Drop one operation (expired or removed on the node). */
	removeOperation: (id: string) => void;
	/** Clear the mirror (node switch). */
	reset: () => void;
	/** Keep the full record of one operation. */
	setDetail: (operation: Operation) => void;
	/** Surface key to the ids of the operations that surface shows, in the
	 *  order they were started. */
	surfaces: Record<string, string[]>;
	/** Stop showing operations on a surface. The operations are kept. */
	unwatch: (surface: string) => void;
	/** Show `operations` on `surface` and put them into the mirror. */
	watch: (surface: string, operations: Operation[]) => void;
}

type OperationsData = Pick<
	OperationsState,
	"details" | "operations" | "surfaces"
>;

/** The newer of two copies of one operation, by its last change. */
function newer(a: Operation | undefined, b: Operation): Operation {
	return a && a.updatedAt > b.updatedAt ? a : b;
}

export const useOperationsStore = create<OperationsState>((set) => ({
	details: {},
	operations: {},
	surfaces: {},
	applySnapshot: (operations) =>
		set((s) => {
			const next = Object.fromEntries(operations.map((o) => [o.id, o]));
			for (const id of Object.values(s.surfaces).flat()) {
				const kept = s.operations[id];
				if (kept && !Object.hasOwn(next, id)) {
					next[id] = kept;
				}
			}
			const details = Object.fromEntries(
				Object.entries(s.details).filter(([id]) => Object.hasOwn(next, id))
			);
			return { details, operations: next };
		}),
	applyUpdate: (operation) =>
		set((s) => ({
			operations: {
				...s.operations,
				[operation.id]: newer(s.operations[operation.id], operation),
			},
		})),
	removeOperation: (id) =>
		set((s) => {
			const operations = { ...s.operations };
			const details = { ...s.details };
			delete operations[id];
			delete details[id];
			const surfaces: Record<string, string[]> = {};
			for (const [surface, ids] of Object.entries(s.surfaces)) {
				const left = ids.filter((watched) => watched !== id);
				if (left.length > 0) {
					surfaces[surface] = left;
				}
			}
			return { details, operations, surfaces };
		}),
	reset: () => set(() => ({ details: {}, operations: {}, surfaces: {} })),
	setDetail: (operation) =>
		set((s) => ({
			details: { ...s.details, [operation.id]: operation },
			operations: {
				...s.operations,
				[operation.id]: newer(s.operations[operation.id], operation),
			},
		})),
	unwatch: (surface) =>
		set((s) => {
			if (!Object.hasOwn(s.surfaces, surface)) {
				return s;
			}
			const surfaces = { ...s.surfaces };
			delete surfaces[surface];
			return { surfaces };
		}),
	watch: (surface, operations) =>
		set((s) => {
			const next = { ...s.operations };
			for (const operation of operations) {
				next[operation.id] = newer(next[operation.id], operation);
			}
			return {
				operations: next,
				surfaces: { ...s.surfaces, [surface]: operations.map((o) => o.id) },
			};
		}),
}));

/** Operations as a list, newest first. */
export function selectOrderedOperations(
	s: Pick<OperationsData, "operations">
): Operation[] {
	return Object.values(s.operations).sort((a, b) =>
		b.createdAt.localeCompare(a.createdAt)
	);
}

/** Whether anything is queued or running. The stream is open only then. */
export function selectHasActiveOperation(
	s: Pick<OperationsData, "operations">
): boolean {
	return Object.values(s.operations).some(isActiveOperation);
}

const NO_IDS: string[] = [];

/**
 * The ids of the operations a surface shows: the ones it is watching (it
 * started them), else the newest queued or running operation of `kind` that is
 * the signed-in user's own. The second case is what a surface finds after the
 * app was reloaded while its operation ran.
 *
 * `adopter` is who the client is to the active node, the node this mirror
 * follows. Pass `null` when the surface talks to another node: it then adopts
 * nothing, because its reads would go to a node that does not have the
 * operation. Only an operation `isOwnOperation` accepts is adopted: never one
 * with another owner, an ownerless one only when the client sends no identity
 * to the node, and nothing at all while the client sends an identity it cannot
 * name. So a surface never shows, stops, retries or registers folders from an
 * operation it did not start and cannot tell to be the user's. Read it through
 * `useShallow`, the list is built on every call.
 */
export function selectSurfaceOperationIds(
	s: Pick<OperationsData, "operations" | "surfaces">,
	surface: string,
	kind: string,
	adopter: OperationViewer | null
): string[] {
	const watched = (s.surfaces[surface] ?? NO_IDS).filter((id) =>
		Object.hasOwn(s.operations, id)
	);
	if (watched.length > 0) {
		return watched;
	}
	if (adopter === null) {
		return NO_IDS;
	}
	const active = selectOrderedOperations(s).find(
		(o) => o.kind === kind && isActiveOperation(o) && isOwnOperation(o, adopter)
	);
	return active ? [active.id] : NO_IDS;
}

/**
 * One operation with the freshest status and progress the mirror has, plus
 * the checkpoint and result of its last full read. The stream never carries
 * those two, so a newer summary keeps the ones already read. Builds a new
 * object when it merges: call it from `useMemo`, not from a store selector.
 */
export function mergeOperation(
	summary: Operation | undefined,
	detail: Operation | undefined
): Operation | null {
	if (!summary) {
		return null;
	}
	if (!detail) {
		return summary;
	}
	if (detail.updatedAt >= summary.updatedAt) {
		return detail;
	}
	return { ...summary, cursor: detail.cursor, result: detail.result };
}
