// apps/desktop/src/live/adapters/operations.ts
//
// Built-in live-activity adapter for OPERATIONS: long work the node runs off
// its request, an import today. Reads the operations store (fed by
// `useOperationsStream`, mounted app-wide) and publishes one card per queued
// or running operation of the signed-in user with its progress
// (`selectLiveOperations`): the import dialog's rule for "mine", plus what this
// app started in this window. A finished operation leaves the dock; the
// surface that started it shows the results.

import type { LiveActivity } from "@ryu/app-host/live-activity";
import type { LiteralMessage } from "@ryu/i18n";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useEffect } from "react";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import { IMPORT_OPERATION_KIND } from "@/src/lib/api/import.ts";
import {
	isActiveOperation,
	isOwnOperation,
	type Operation,
	type OperationViewer,
	sessionOperationViewer,
} from "@/src/lib/api/operations.ts";
import { useLiveActivityStore } from "@/src/store/useLiveActivityStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	selectOrderedOperations,
	useOperationsStore,
} from "@/src/store/useOperationsStore.ts";

function millis(iso: string): number {
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/** The progress line of an operation, shared by the card and the surfaces. */
export function operationProgressText(
	operation: Operation,
	tl: LiteralMessage
): string {
	if (operation.cancelRequested) {
		return tl("Stopping…");
	}
	if (operation.status === "queued") {
		return tl("Queued");
	}
	if (operation.progress.total <= 0) {
		return tl("Starting…");
	}
	return tl("{done} of {total, plural, one {# item} other {# items}}", {
		done: operation.progress.done,
		total: operation.progress.total,
	});
}

/** Progress as 0..1, or undefined while the total is not known. */
export function operationFraction(operation: Operation): number | undefined {
	const { done, total } = operation.progress;
	return total > 0 ? Math.min(1, done / total) : undefined;
}

export function operationToActivity(
	operation: Operation,
	tl: LiteralMessage
): LiveActivity {
	const title =
		operation.kind === IMPORT_OPERATION_KIND
			? tl("Importing {title}", { title: operation.title })
			: operation.title;
	const progressText = operationProgressText(operation, tl);
	return {
		id: `operation:${operation.id}`,
		appId: "shell",
		kind: "operation",
		title: title.slice(0, 64),
		detail: operation.resumed
			? `${tl("Resumed after restart")} · ${progressText}`
			: progressText,
		status: operation.status === "queued" ? "waiting" : "running",
		progress: operationFraction(operation),
		icon: "arrow-down-03",
		startedAt: millis(operation.createdAt),
		updatedAt: millis(operation.updatedAt),
	};
}

/** The part of the operations store the Live section reads. */
interface OperationsMirror {
	operations: Record<string, Operation>;
	/** Surface key to the ids of the operations it started. */
	surfaces: Record<string, string[]>;
}

/**
 * The operations that get a card, newest first: the queued or running ones
 * the import dialog would call the user's own (`isOwnOperation`, with `viewer`
 * as who the client is to the node the mirror follows). An admin's Live
 * section is the admin's own work: a member's import, or one started without
 * an identity, that the node lists to the admin gets no card. While the client
 * sends an identity it cannot name, no operation is the user's.
 *
 * One addition to the dialog's rule: an operation a surface of this app
 * started in this window keeps its card whatever its owner says. The client
 * started it, and its owner is the real user also while the session cannot
 * name that user.
 */
export function selectLiveOperations(
	s: OperationsMirror,
	viewer: OperationViewer
): Operation[] {
	const startedHere = new Set(Object.values(s.surfaces).flat());
	return selectOrderedOperations(s).filter(
		(operation) =>
			isActiveOperation(operation) &&
			(startedHere.has(operation.id) || isOwnOperation(operation, viewer))
	);
}

/**
 * Each operation of `selectLiveOperations` is a card; the rest is removed.
 * `node` is the active node, the one the mirror follows. The session is read
 * at every call.
 */
export function reconcileOperationActivities(
	s: OperationsMirror,
	node: ApiTarget,
	tl: LiteralMessage
): void {
	const desired = selectLiveOperations(s, sessionOperationViewer(node)).map(
		(operation) => operationToActivity(operation, tl)
	);
	useLiveActivityStore
		.getState()
		.applySourceSnapshot("shell", "operation", desired);
}

/** Mount ONE app-wide reconciliation of operations to live activities. */
export function useOperationLiveActivities(): void {
	const operations = useOperationsStore((s) => s.operations);
	const surfaces = useOperationsStore((s) => s.surfaces);
	// The same node `useOperationsStream` fills the mirror from.
	const node = useNodeStore((s) => s.getActiveNode());
	const url = node.url;
	const token = node.token;
	const userJwt = node.userJwt;
	const tl = useLiteralMessages();

	useEffect(() => {
		reconcileOperationActivities(
			{ operations, surfaces },
			toTarget({ url, token, userJwt }),
			tl
		);
	}, [operations, surfaces, url, token, userJwt, tl]);
}
