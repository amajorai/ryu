// apps/desktop/src/lib/api/operations.ts
//
// Typed client for Core's operations service: long work (an import today) that
// runs off its request, reports progress and is settled again after a node
// restart.
//   - GET  /api/operations             : running and recent operations (summaries)
//   - GET  /api/operations/:id         : one full record (input, cursor, result)
//   - POST /api/operations/:id/cancel  : stop between items, keep what was done
//   - POST /api/operations/:id/retry   : start a failed, cancelled or interrupted one again
//   - GET  /api/operations/stream      : SSE, a snapshot on connect, then changes
//
// The stream is its own socket, not a channel of `/api/events/all`. The desktop
// keeps one socket per node open at all times (see eventStream.ts), so the hook
// that owns this stream opens it only while an operation is active.

import { SseFrameDecoder } from "@ryuhq/protocol/sse";
import { z } from "zod";
import { getActiveToken } from "@/lib/auth-client.ts";
import { getVerifiedActiveUserId } from "@/lib/session-owner.ts";
import {
	type ApiTarget,
	authenticatedFetch,
	managedDelegationFor,
	mayAttachAccountJwt,
} from "./client.ts";

export const OPERATION_STATUSES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
	"interrupted",
] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

const operationProgressSchema = z.object({
	done: z.number().optional(),
	label: z.string().optional(),
	total: z.number().optional(),
});

const operationSchema = z.object({
	attempt: z.number().optional(),
	cancelRequested: z.boolean().optional(),
	completedAt: z.string().optional(),
	createdAt: z.string(),
	cursor: z.unknown().optional(),
	error: z.string().optional(),
	id: z.string(),
	kind: z.string(),
	ownerUserId: z.string().nullish(),
	progress: operationProgressSchema.optional(),
	result: z.unknown().optional(),
	resumable: z.boolean().optional(),
	resumed: z.boolean().optional(),
	status: z.enum(OPERATION_STATUSES),
	title: z.string(),
	updatedAt: z.string(),
});

/** One operation as the desktop holds it. Lists and the stream carry it
 *  without `cursor` and `result`; `getOperation` fills them. */
export interface Operation {
	/** How many times the runner was started for the current run. */
	attempt: number;
	/** A stop was requested and the runner has not stopped yet. */
	cancelRequested: boolean;
	completedAt?: string;
	createdAt: string;
	/** The runner's checkpoint. Only on a full read. */
	cursor?: unknown;
	error?: string;
	id: string;
	/** The runner that owns the operation, for example `import.setup`. */
	kind: string;
	/** The user who started it. Core leaves it out when the start carried no
	 *  verified user identity. */
	ownerUserId?: string;
	progress: { done: number; label?: string; total: number };
	/** What the runner returned. Only on a full read. */
	result?: unknown;
	/** The current run continued after a node restart. */
	resumed: boolean;
	status: OperationStatus;
	/** A short label from the feature, for an import the folder name. */
	title: string;
	updatedAt: string;
}

function toOperation(wire: z.output<typeof operationSchema>): Operation {
	return {
		attempt: wire.attempt ?? 0,
		cancelRequested: wire.cancelRequested ?? false,
		completedAt: wire.completedAt,
		createdAt: wire.createdAt,
		cursor: wire.cursor,
		error: wire.error,
		id: wire.id,
		kind: wire.kind,
		ownerUserId: wire.ownerUserId ?? undefined,
		progress: {
			done: wire.progress?.done ?? 0,
			label: wire.progress?.label,
			total: wire.progress?.total ?? 0,
		},
		result: wire.result,
		resumed: wire.resumed ?? false,
		status: wire.status,
		title: wire.title,
		updatedAt: wire.updatedAt,
	};
}

/** Parse one operation from an unknown value, or `null` when it is not one. */
export function parseOperation(value: unknown): Operation | null {
	const parsed = operationSchema.safeParse(value);
	return parsed.success ? toOperation(parsed.data) : null;
}

/** Whether the operation still has work to do. */
export function isActiveOperation(operation: Pick<Operation, "status">) {
	return operation.status === "queued" || operation.status === "running";
}

/** Whether Retry may start the operation again. */
export function isRetryableOperation(operation: Pick<Operation, "status">) {
	return (
		operation.status === "failed" ||
		operation.status === "cancelled" ||
		operation.status === "interrupted"
	);
}

/**
 * Who this client is to one node when it asks about operations: the user it
 * can name, and whether it sends any identity to the node.
 */
export interface OperationViewer {
	/** The client sends an identity to the node: the node's managed delegation,
	 *  or the account JWT of a live session. It can be true while `userId` is
	 *  `null`; the client then sends an identity it cannot name. */
	presentsIdentity: boolean;
	/** The verified id of the signed-in user. It is `null` when signed out,
	 *  during an account switch, and for an unverified bearer or a placeholder
	 *  account. */
	userId: string | null;
}

/**
 * The viewer for `target`. Core takes the owner of an operation from the
 * verified user JWT of the request that started it, on any node. The client
 * sends one where `authenticatedFetch` does: the node's own managed delegation
 * as it is, with no look at the session, or the account JWT where
 * `mayAttachAccountJwt` allows it, minted from the session bearer.
 *
 * `presentsIdentity` follows what is sent, not `userId`. A placeholder account
 * (the offline sign-in fallback) and an unverified bearer have no verified
 * user id, and the client still sends the delegation or mints the JWT.
 *
 * `hasSessionBearer` says whether a session bearer is live (`getActiveToken()`
 * is not `null`), which is what the JWT exchange reads.
 */
export function operationViewer(
	target: ApiTarget,
	userId: string | null,
	hasSessionBearer: boolean
): OperationViewer {
	return {
		presentsIdentity:
			managedDelegationFor(target) !== null ||
			(hasSessionBearer && mayAttachAccountJwt(target)),
		userId,
	};
}

/**
 * The viewer for `target` in the live session: the verified user id and the
 * session bearer as they are at this call. Nothing subscribes to the session,
 * so call it where the answer is used (a render, a reconcile), not once.
 */
export function sessionOperationViewer(target: ApiTarget): OperationViewer {
	return operationViewer(
		target,
		getVerifiedActiveUserId(),
		getActiveToken() !== null
	);
}

/**
 * Whether a surface may take `operation` as one the signed-in user started,
 * and so show it, stop it, retry it and register its folders.
 *
 * - An operation with an owner is the user's only when the owner is the
 *   verified signed-in user.
 * - An operation without an owner was started without a verified identity.
 *   Core lists it only to a caller who manages the node. It is the user's only
 *   when this client sends no identity to the node either (signed out with no
 *   delegation, or the JWT is withheld), because then its own starts are
 *   ownerless too. That is the one operator of a node that is not bound to an
 *   organization. A client that sends an identity starts owned operations, so
 *   an ownerless one was started by someone else.
 *
 * While the client sends any identity it cannot name, nothing ownerless and
 * nothing owned is the user's. Fail closed.
 */
export function isOwnOperation(
	operation: Pick<Operation, "ownerUserId">,
	viewer: OperationViewer
): boolean {
	if (operation.ownerUserId !== undefined) {
		return operation.ownerUserId === viewer.userId;
	}
	return !viewer.presentsIdentity;
}

export type OperationEvent =
	| { operations: Operation[]; type: "snapshot" }
	| { operation: Operation; type: "update" }
	| { id: string; type: "removed" };

const operationEventSchema = z.discriminatedUnion("type", [
	z.object({
		operations: z.array(operationSchema),
		type: z.literal("snapshot"),
	}),
	z.object({ operation: operationSchema, type: z.literal("update") }),
	z.object({ id: z.string(), type: z.literal("removed") }),
]);

/** Parse the JSON of one stream frame, or `null` for anything else. */
export function parseOperationEvent(value: unknown): OperationEvent | null {
	const parsed = operationEventSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	const event = parsed.data;
	if (event.type === "snapshot") {
		return { operations: event.operations.map(toOperation), type: "snapshot" };
	}
	if (event.type === "update") {
		return { operation: toOperation(event.operation), type: "update" };
	}
	return event;
}

/** Running and recent operations, newest first, without cursor and result. */
export async function listOperations(target: ApiTarget): Promise<Operation[]> {
	const resp = await authenticatedFetch(target, "/api/operations", {
		method: "GET",
	});
	if (!resp.ok) {
		throw new Error(`Failed to list operations: ${resp.status}`);
	}
	const body = z
		.object({ operations: z.array(operationSchema).optional() })
		.parse(await resp.json());
	return (body.operations ?? []).map(toOperation);
}

/** A request about one operation that the node refused. `status` is the HTTP
 *  status: 404 means the operation does not exist for this caller. */
export class OperationRequestError extends Error {
	readonly status: number;

	/** `message` is one whole sentence, so the catalog can translate it. */
	constructor(message: string, status: number) {
		super(message);
		this.name = "OperationRequestError";
		this.status = status;
	}
}

/** Whether `error` says the operation does not exist (any more). */
export function isOperationGone(error: unknown): boolean {
	return error instanceof OperationRequestError && error.status === 404;
}

async function readOperation(
	resp: Response,
	refused: (status: number) => OperationRequestError
): Promise<Operation> {
	if (!resp.ok) {
		throw refused(resp.status);
	}
	return toOperation(operationSchema.parse(await resp.json()));
}

/** The full record, with the checkpoint and the result. */
export async function getOperation(
	target: ApiTarget,
	id: string
): Promise<Operation> {
	const resp = await authenticatedFetch(
		target,
		`/api/operations/${encodeURIComponent(id)}`,
		{ method: "GET" }
	);
	return readOperation(
		resp,
		(status) =>
			new OperationRequestError(
				`Failed to read the operation: ${status}`,
				status
			)
	);
}

/** Ask the operation to stop. It stops between items and keeps what it did. */
export async function cancelOperation(
	target: ApiTarget,
	id: string
): Promise<Operation> {
	const resp = await authenticatedFetch(
		target,
		`/api/operations/${encodeURIComponent(id)}/cancel`,
		{ method: "POST" }
	);
	return readOperation(
		resp,
		(status) =>
			new OperationRequestError(
				`Failed to stop the operation: ${status}`,
				status
			)
	);
}

/** Start a failed, cancelled or interrupted operation again. */
export async function retryOperation(
	target: ApiTarget,
	id: string
): Promise<Operation> {
	const resp = await authenticatedFetch(
		target,
		`/api/operations/${encodeURIComponent(id)}/retry`,
		{ method: "POST" }
	);
	return readOperation(
		resp,
		(status) =>
			new OperationRequestError(
				`Failed to retry the operation: ${status}`,
				status
			)
	);
}

const DATA_PREFIX = "data:";

/** The JSON payload of one SSE frame; `null` for a keep-alive or bad frame. */
export function operationEventFromFrame(frame: string): OperationEvent | null {
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith(DATA_PREFIX)) {
			dataLines.push(line.slice(DATA_PREFIX.length).trim());
		}
	}
	if (dataLines.length === 0) {
		return null;
	}
	try {
		return parseOperationEvent(JSON.parse(dataLines.join("\n")));
	} catch {
		return null;
	}
}

/** 3x Core's 15s SSE keep-alive: no bytes for this long means a dead socket. */
const IDLE_TIMEOUT_MS = 45_000;

/**
 * Read the operations stream once: resolves when the node ends it, rejects
 * when it cannot be opened or breaks. The caller owns reconnecting. The first
 * frame is a snapshot of every operation the caller may see. A socket that
 * stays silent past the keep-alive window is aborted, so a half-open
 * connection (sleep and wake, network loss) is handed back to the caller.
 */
export async function streamOperations(
	target: ApiTarget,
	onEvent: (event: OperationEvent) => void,
	signal: AbortSignal,
	idleTimeoutMs: number = IDLE_TIMEOUT_MS
): Promise<void> {
	if (signal.aborted) {
		return;
	}
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal.addEventListener("abort", abort, { once: true });
	let idle = setTimeout(abort, idleTimeoutMs);
	try {
		const resp = await authenticatedFetch(target, "/api/operations/stream", {
			method: "GET",
			headers: { Accept: "text/event-stream" },
			signal: controller.signal,
		});
		if (!(resp.ok && resp.body)) {
			throw new Error(`operations stream failed: ${resp.status}`);
		}
		const reader = resp.body.getReader();
		const decoder = new SseFrameDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				clearTimeout(idle);
				if (done) {
					break;
				}
				idle = setTimeout(abort, idleTimeoutMs);
				for (const frame of decoder.push(value)) {
					const event = operationEventFromFrame(frame);
					if (event) {
						onEvent(event);
					}
				}
			}
		} finally {
			decoder.finish();
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	} finally {
		clearTimeout(idle);
		controller.abort();
		signal.removeEventListener("abort", abort);
	}
}
