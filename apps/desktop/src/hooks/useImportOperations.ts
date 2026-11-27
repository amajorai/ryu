// apps/desktop/src/hooks/useImportOperations.ts
//
// What an import surface (the "Import agent setup" dialog, the onboarding
// migration step) uses instead of component state. The surface starts its
// imports as operations on the node and keeps only a surface key in the
// operations store. Progress and per-item results are read from the node, so
// a dialog that was closed and opened again, or an app that was reloaded,
// shows the same import.
//
// The surface reads its own operations from its own node (`target`) while it
// is mounted and they are not finished. It does not depend on the app-wide
// stream: onboarding talks to the node it is setting up, which need not be
// the active node the stream follows.
//
// Stop, Retry and the registration of imported folders act only on the
// surface's operations: the ones it started, or after a reload the signed-in
// user's own running import on the active node (`selectSurfaceOperationIds`,
// `isOwnOperation`). An import with another owner, which an admin can see in
// the node's list, is never adopted. An import without an owner is adopted
// only when this client sends no identity to the node. While the client sends
// any identity it cannot name (a placeholder account, an unverified bearer),
// nothing ownerless and nothing owned is adopted.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	IMPORT_OPERATION_KIND,
	type ImportOutcome,
	type ImportSelection,
	importOutcomesOf,
	newImportKey,
	startImport,
} from "@/src/lib/api/import.ts";
import {
	cancelOperation,
	getOperation,
	isActiveOperation,
	isOperationGone,
	isRetryableOperation,
	type Operation,
	retryOperation,
	sessionOperationViewer,
} from "@/src/lib/api/operations.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	mergeOperation,
	selectSurfaceOperationIds,
	useOperationsStore,
} from "@/src/store/useOperationsStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

/** How often a mounted surface reads an operation that is not finished. */
const READ_INTERVAL_MS = 1500;

/** One folder and the items to import from it. */
export interface ImportBatch {
	items: ImportSelection[];
	path: string;
}

export interface ImportOperationsView {
	/** Something is still queued or running. */
	active: boolean;
	/** Stop showing these imports on the surface. They are kept on the node. */
	clear: () => void;
	/** The surface's operations in the order they were started. */
	operations: Operation[];
	/** The outcome of every item finished so far, as far as it was read. */
	outcomes: ImportOutcome[];
	/** Start every failed, stopped or interrupted import again. */
	retry: () => Promise<void>;
	/** There are operations, all ended, and the final record of each is read. */
	settled: boolean;
	/**
	 * Start one import per batch. A node with the operations service answers
	 * at once and the imports show up in `operations`. An older node runs the
	 * batch inside the request; its outcomes are the return value.
	 */
	start: (batches: ImportBatch[]) => Promise<ImportOutcome[]>;
	/** Ask every running import to stop. Imported items are kept. */
	stop: () => Promise<void>;
}

/** Register the folders an import brought in as workspace projects, so they
 *  group in the sidebar. Safe to repeat: a known folder is left alone. */
export function registerImportedFolders(
	outcomes: readonly ImportOutcome[]
): number {
	const folders = new Set<string>();
	for (const outcome of outcomes) {
		if (outcome.folderPath) {
			folders.add(outcome.folderPath);
		}
	}
	const { addProjectFolder } = useWorkspaceStore.getState();
	for (const folder of folders) {
		addProjectFolder(folder);
	}
	return folders.size;
}

/** Whether `target` is `node`, with the same address and the same
 *  credentials, so a read through `target` sees what the mirror of `node`
 *  holds. */
function isSameNode(
	target: ApiTarget,
	node: Pick<ApiTarget, "token" | "url" | "userJwt">
): boolean {
	return (
		target.url === node.url &&
		(target.token ?? null) === (node.token ?? null) &&
		(target.userJwt ?? null) === (node.userJwt ?? null)
	);
}

/** Whether the full record of `id` still has to be read (again). */
function needsRead(id: string): boolean {
	const { details, operations } = useOperationsStore.getState();
	const summary = operations[id];
	const detail = details[id];
	if (!summary) {
		return false;
	}
	if (!detail) {
		return true;
	}
	return isActiveOperation(detail) || summary.updatedAt > detail.updatedAt;
}

export function useImportOperations(
	target: ApiTarget,
	surface: string
): ImportOperationsView {
	// Callers may build a new target object on every render.
	const targetRef = useRef(target);
	targetRef.current = target;

	// The mirror follows the active node. The surface adopts an import it did
	// not start (after a reload) only when it talks to that node, and only one
	// the signed-in user started. The session is read on every render.
	const activeNode = useNodeStore((s) => s.getActiveNode());
	const adopter = isSameNode(target, activeNode)
		? sessionOperationViewer(target)
		: null;
	const ids = useOperationsStore(
		useShallow((s) =>
			selectSurfaceOperationIds(s, surface, IMPORT_OPERATION_KIND, adopter)
		)
	);
	const summaries = useOperationsStore(
		useShallow((s) => ids.map((id) => s.operations[id]))
	);
	const details = useOperationsStore(
		useShallow((s) => ids.map((id) => s.details[id]))
	);

	const operations = useMemo(() => {
		const merged: Operation[] = [];
		for (const [index, summary] of summaries.entries()) {
			const operation = mergeOperation(summary, details[index]);
			if (operation) {
				merged.push(operation);
			}
		}
		return merged;
	}, [summaries, details]);

	const outcomes = useMemo(
		() => operations.flatMap((o) => importOutcomesOf(o) ?? []),
		[operations]
	);
	const active = operations.some(isActiveOperation);
	const settled =
		operations.length > 0 &&
		!active &&
		details.every(
			(detail) => detail !== undefined && !isActiveOperation(detail)
		);

	// Read the full records while the surface is mounted, until each operation
	// has ended and its final record is in the store. The key changes when an
	// operation changes status, so a retry starts the reading again.
	const readKey = summaries
		.map((o) => (o ? `${o.id}:${o.status}` : ""))
		.join("|");
	useEffect(() => {
		if (readKey === "" || ids.length === 0) {
			return;
		}
		const watched = ids;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const read = async () => {
			await Promise.all(
				watched.filter(needsRead).map(async (id) => {
					try {
						const full = await getOperation(targetRef.current, id);
						if (stopped) {
							return;
						}
						useOperationsStore.getState().setDetail(full);
						if (!isActiveOperation(full)) {
							registerImportedFolders(importOutcomesOf(full) ?? []);
						}
					} catch (error) {
						if (!stopped && isOperationGone(error)) {
							useOperationsStore.getState().removeOperation(id);
						}
					}
				})
			);
			if (!stopped && watched.some(needsRead)) {
				timer = setTimeout(() => void read(), READ_INTERVAL_MS);
			}
		};
		read().catch(() => undefined);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [ids, readKey]);

	const start = useCallback(
		async (batches: ImportBatch[]) => {
			const started: Operation[] = [];
			const plain: ImportOutcome[] = [];
			try {
				for (const batch of batches) {
					const answer = await startImport(
						targetRef.current,
						batch.path,
						batch.items,
						newImportKey()
					);
					if (answer.kind === "operation") {
						started.push(answer.operation);
					} else {
						plain.push(...answer.result.results);
					}
				}
			} finally {
				// Imports that did start are shown even when a later start failed.
				if (started.length > 0) {
					useOperationsStore.getState().watch(surface, started);
				}
			}
			registerImportedFolders(plain);
			return plain;
		},
		[surface]
	);

	const stop = useCallback(async () => {
		const { applyUpdate } = useOperationsStore.getState();
		for (const operation of operations.filter(isActiveOperation)) {
			applyUpdate(await cancelOperation(targetRef.current, operation.id));
		}
	}, [operations]);

	const retry = useCallback(async () => {
		const { applyUpdate } = useOperationsStore.getState();
		for (const operation of operations.filter(isRetryableOperation)) {
			applyUpdate(await retryOperation(targetRef.current, operation.id));
		}
	}, [operations]);

	const clear = useCallback(() => {
		useOperationsStore.getState().unwatch(surface);
	}, [surface]);

	return { active, clear, operations, outcomes, retry, settled, start, stop };
}
