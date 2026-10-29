// packages/core-client/src/harness.ts
//
// Shared platform client for Core's durable agent-harness projection. The
// desktop, native, and other first-party surfaces use this module; external
// embedders can use the lighter @ryuhq/client wrapper.

import { z } from "zod";
import { type AppJsonValue, appJsonValueSchema } from "./app-request-json.ts";
import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
	request,
} from "./client.ts";

export type HarnessRunStatus =
	| "pending"
	| "running"
	| "awaiting_approval"
	| "completed"
	| "failed"
	| "canceled"
	| "interrupted";

/** Behavior when a run starts while the session already has an active run. */
export type MultitaskStrategy = "reject" | "enqueue" | "interrupt" | "rollback";

export type ExecutionProfileKind = "local" | "worktree" | "remote" | "cloud";
export type NetworkMode = "inherit" | "denied" | "gateway_only" | "allow";
export type SandboxMode = "inherit" | "workspace" | "strict";
export type ApprovalMode = "inherit" | "on_risk" | "always" | "never";

export interface ExecutionProfile {
	approval: ApprovalMode;
	cwd?: string;
	kind: ExecutionProfileKind;
	network: NetworkMode;
	sandbox: SandboxMode;
	worktreeBranch?: string;
	worktreeIsolation: boolean;
}

export interface HarnessSession {
	conversationId: string;
	createdAt: string;
	executionProfile: ExecutionProfile;
	id: string;
	nativeSessionId?: string;
	parentSessionId?: string;
	protocolVersion: string;
	runnableId: string;
	runnableKind: string;
	status: HarnessRunStatus;
	updatedAt: string;
}

export interface HarnessRun {
	attempt: number;
	createdAt: string;
	error?: string;
	eventCursor: number;
	executionProfile: ExecutionProfile;
	finishedAt?: string;
	id: string;
	idempotencyKey?: string;
	multitaskStrategy?: MultitaskStrategy;
	output?: AppJsonValue;
	parentRunId?: string;
	protocolVersion: string;
	sessionId: string;
	startedAt?: string;
	status: HarnessRunStatus;
}

export interface HarnessApprovalOption {
	kind: string;
	name: string;
	optionId: string;
}

export type HarnessRunEvent =
	| {
			activeRunId?: string;
			position: number;
			strategy: MultitaskStrategy;
			type: "run_queued";
	  }
	| { executionProfile: ExecutionProfile; type: "run_started" }
	| { inputHash: string; messageCount: number; type: "input_accepted" }
	| { delta: string; type: "text_delta" }
	| {
			inputHash?: string;
			name: string;
			toolCallId: string;
			type: "tool_call_started";
	  }
	| {
			durationMs?: number;
			name: string;
			ok: boolean;
			resultHash?: string;
			toolCallId: string;
			type: "tool_call_completed";
	  }
	| {
			approvalId: string;
			options?: HarnessApprovalOption[];
			summary: string;
			type: "approval_requested";
	  }
	| { messageId?: string; type: "checkpoint" }
	| { output?: AppJsonValue; type: "run_completed" }
	| { code: string; message: string; type: "run_failed" }
	| { type: "run_canceled" }
	| { type: "run_interrupted" }
	| { frame: string; type: "ui_frame" };

export type HarnessRunEventEnvelope = HarnessRunEvent & {
	createdAt: string;
	id: string;
	protocolVersion: string;
	runId: string;
	seq: number;
	sessionId: string;
};

function nativeHarnessEventValue<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appJsonValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const harnessEventProfile = nativeHarnessEventValue(
	z.object({
		approval: z.enum(["inherit", "on_risk", "always", "never"]),
		cwd: z.string().optional(),
		kind: z.enum(["local", "worktree", "remote", "cloud"]),
		network: z.enum(["inherit", "denied", "gateway_only", "allow"]),
		sandbox: z.enum(["inherit", "workspace", "strict"]),
		worktreeBranch: z.string().optional(),
		worktreeIsolation: z.boolean(),
	})
);
const harnessEventFields = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("run_queued"),
		activeRunId: z.string().optional(),
		position: z.number(),
		strategy: z.enum(["reject", "enqueue", "interrupt", "rollback"]),
	}),
	z.object({
		type: z.literal("run_started"),
		executionProfile: harnessEventProfile,
	}),
	z.object({
		type: z.literal("input_accepted"),
		inputHash: z.string(),
		messageCount: z.number(),
	}),
	z.object({ type: z.literal("text_delta"), delta: z.string() }),
	z.object({
		type: z.literal("tool_call_started"),
		inputHash: z.string().optional(),
		name: z.string(),
		toolCallId: z.string(),
	}),
	z.object({
		type: z.literal("tool_call_completed"),
		durationMs: z.number().optional(),
		name: z.string(),
		ok: z.boolean(),
		resultHash: z.string().optional(),
		toolCallId: z.string(),
	}),
	z.object({
		type: z.literal("approval_requested"),
		approvalId: z.string(),
		options: nativeHarnessEventValue(
			z.array(
				nativeHarnessEventValue(
					z.object({ kind: z.string(), name: z.string(), optionId: z.string() })
				)
			)
		).optional(),
		summary: z.string(),
	}),
	z.object({ type: z.literal("checkpoint"), messageId: z.string().optional() }),
	z.object({
		type: z.literal("run_completed"),
		output: appJsonValueSchema.optional(),
	}),
	z.object({
		type: z.literal("run_failed"),
		code: z.string(),
		message: z.string(),
	}),
	z.object({ type: z.literal("run_canceled") }),
	z.object({ type: z.literal("run_interrupted") }),
	z.object({ type: z.literal("ui_frame"), frame: z.string() }),
]);
const harnessEventEnvelope = nativeHarnessEventValue(
	z.intersection(
		harnessEventFields,
		z.object({
			createdAt: z.string(),
			id: z.string(),
			protocolVersion: z.string(),
			runId: z.string(),
			seq: z.number(),
			sessionId: z.string(),
		})
	)
);

// Complete native agent-contracts HTTP projections; keep decoded future fields.
const harnessResponseStatus = z.enum([
	"pending",
	"running",
	"awaiting_approval",
	"completed",
	"failed",
	"canceled",
	"interrupted",
]);
const harnessSessionResponse = nativeHarnessEventValue(
	z.object({
		conversationId: z.string(),
		createdAt: z.string(),
		executionProfile: harnessEventProfile,
		id: z.string(),
		nativeSessionId: z.string().optional(),
		parentSessionId: z.string().optional(),
		protocolVersion: z.string(),
		runnableId: z.string(),
		runnableKind: z.string(),
		status: harnessResponseStatus,
		updatedAt: z.string(),
	}) satisfies z.ZodType<HarnessSession>
);
const harnessRunResponse = nativeHarnessEventValue(
	z.object({
		attempt: z.number(),
		createdAt: z.string(),
		error: z.string().optional(),
		eventCursor: z.number(),
		executionProfile: harnessEventProfile,
		finishedAt: z.string().optional(),
		id: z.string(),
		idempotencyKey: z.string().optional(),
		multitaskStrategy: z
			.enum(["reject", "enqueue", "interrupt", "rollback"])
			.optional(),
		output: appJsonValueSchema.optional(),
		parentRunId: z.string().optional(),
		protocolVersion: z.string(),
		sessionId: z.string(),
		startedAt: z.string().optional(),
		status: harnessResponseStatus,
	}) satisfies z.ZodType<HarnessRun>
);
const harnessSessionReply = nativeHarnessEventValue(
	z.object({
		protocolVersion: z.string().optional(),
		session: harnessSessionResponse,
	})
);
const harnessChildrenReply = nativeHarnessEventValue(
	z.object({
		protocolVersion: z.string().optional(),
		sessions: z.array(harnessSessionResponse).nullish(),
	})
);
const harnessRunsReply = nativeHarnessEventValue(
	z.object({
		protocolVersion: z.string().optional(),
		runs: z.array(harnessRunResponse).nullish(),
	})
);
const harnessStartReply = nativeHarnessEventValue(
	z.object({
		protocolVersion: z.string().optional(),
		created: z.boolean(),
		eventsUrl: z.string(),
		run: harnessRunResponse,
	})
);
const harnessRunReply = nativeHarnessEventValue(
	z.object({ protocolVersion: z.string().optional(), run: harnessRunResponse })
);
const harnessCancelReply = nativeHarnessEventValue(
	z.object({ cancelled: z.boolean().optional(), runId: z.string().optional() })
);
const harnessPermissionReply = nativeHarnessEventValue(
	z.object({ resolved: z.boolean().optional() })
);

const defaultProfile: ExecutionProfile = {
	approval: "inherit",
	kind: "local",
	network: "inherit",
	sandbox: "inherit",
	worktreeIsolation: false,
};

function profile(value?: ExecutionProfile): ExecutionProfile {
	return { ...defaultProfile, ...value };
}

function encode(id: string): string {
	return encodeURIComponent(id);
}

function terminal(event: HarnessRunEventEnvelope): boolean {
	return (
		event.type === "run_completed" ||
		event.type === "run_failed" ||
		event.type === "run_canceled" ||
		event.type === "run_interrupted"
	);
}

interface HarnessSessionBody {
	agentId?: Parameters<typeof createHarnessSession>[1]["agentId"];
	executionProfile: ExecutionProfile;
	parentSessionId?: Parameters<
		typeof createHarnessSession
	>[1]["parentSessionId"];
	runnableId: Parameters<typeof createHarnessSession>[1]["runnableId"];
	runnableKind: Parameters<typeof createHarnessSession>[1]["runnableKind"];
	title?: Parameters<typeof createHarnessSession>[1]["title"];
}
function harnessSessionBody(input: Parameters<typeof createHarnessSession>[1]) {
	const body: HarnessSessionBody = {
		runnableId: input.runnableId,
		runnableKind: input.runnableKind,
		executionProfile: profile(input.executionProfile),
	};
	if (input.agentId) {
		body.agentId = input.agentId;
	}
	if (input.parentSessionId) {
		body.parentSessionId = input.parentSessionId;
	}
	if (input.title) {
		body.title = input.title;
	}
	return body;
}
type HarnessRunInput = Parameters<typeof JSON.stringify>[0];
interface HarnessRunBody {
	executionProfile?: ExecutionProfile;
	idempotencyKey?: NonNullable<
		Parameters<typeof startHarnessRun>[3]
	>["idempotencyKey"];
	input: Parameters<typeof startHarnessRun>[2];
	multitaskStrategy?: MultitaskStrategy;
	resumeRunId?: NonNullable<
		Parameters<typeof startHarnessRun>[3]
	>["resumeRunId"];
}
function harnessRunBody(
	input: Parameters<typeof startHarnessRun>[2],
	options: NonNullable<Parameters<typeof startHarnessRun>[3]>
) {
	const body: HarnessRunBody = { input };
	if (options.executionProfile) {
		body.executionProfile = profile(options.executionProfile);
	}
	if (options.idempotencyKey) {
		body.idempotencyKey = options.idempotencyKey;
	}
	if (options.resumeRunId) {
		body.resumeRunId = options.resumeRunId;
	}
	if (options.multitaskStrategy) {
		body.multitaskStrategy = options.multitaskStrategy;
	}
	return body;
}
interface HarnessPermissionBody {
	option_id?: Parameters<typeof resolveHarnessPermission>[2];
	request_id: Parameters<typeof resolveHarnessPermission>[1];
}
function harnessPermissionBody(
	requestId: Parameters<typeof resolveHarnessPermission>[1],
	optionId: Parameters<typeof resolveHarnessPermission>[2]
) {
	const body: HarnessPermissionBody = { request_id: requestId };
	if (optionId) {
		body.option_id = optionId;
	}
	return body;
}

/** Create a durable session bound to a Core runnable. */
export async function createHarnessSession(
	target: ApiTarget,
	input: {
		agentId?: string;
		executionProfile?: ExecutionProfile;
		parentSessionId?: string;
		runnableId: string;
		runnableKind: string;
		title?: string;
	}
): Promise<HarnessSession> {
	const body = await request(
		target,
		"/api/harness/sessions",
		{
			method: "POST",
			body: harnessSessionBody(input),
		},
		harnessSessionReply
	);
	return body.session;
}

export async function getHarnessSession(
	target: ApiTarget,
	sessionId: string
): Promise<HarnessSession> {
	const body = await request(
		target,
		`/api/harness/sessions/${encode(sessionId)}`,
		{},
		harnessSessionReply
	);
	return body.session;
}

export async function listChildHarnessSessions(
	target: ApiTarget,
	sessionId: string
): Promise<HarnessSession[]> {
	const body = await request(
		target,
		`/api/harness/sessions/${encode(sessionId)}/children`,
		{},
		harnessChildrenReply
	);
	return body.sessions ?? [];
}

export async function bindNativeSession(
	target: ApiTarget,
	sessionId: string,
	nativeSessionId: string
): Promise<HarnessSession> {
	const body = await request(
		target,
		`/api/harness/sessions/${encode(sessionId)}/native`,
		{
			method: "PUT",
			body: { nativeSessionId },
		},
		harnessSessionReply
	);
	return body.session;
}

export async function listHarnessRuns(
	target: ApiTarget,
	sessionId: string
): Promise<HarnessRun[]> {
	const body = await request(
		target,
		`/api/harness/sessions/${encode(sessionId)}/runs`,
		{},
		harnessRunsReply
	);
	return body.runs ?? [];
}

export async function startHarnessRun(
	target: ApiTarget,
	sessionId: string,
	input: HarnessRunInput,
	options: {
		executionProfile?: ExecutionProfile;
		idempotencyKey?: string;
		/** Behavior while the session has an active run (default `reject`). */
		multitaskStrategy?: MultitaskStrategy;
		resumeRunId?: string;
	} = {}
): Promise<{ created: boolean; eventsUrl: string; run: HarnessRun }> {
	return request(
		target,
		`/api/harness/sessions/${encode(sessionId)}/runs`,
		{
			method: "POST",
			body: harnessRunBody(input, options),
		},
		harnessStartReply
	);
}

export async function getHarnessRun(
	target: ApiTarget,
	runId: string
): Promise<HarnessRun> {
	const body = await request(
		target,
		`/api/harness/runs/${encode(runId)}`,
		{},
		harnessRunReply
	);
	return body.run;
}

/** Stream events after an exclusive cursor until the run reaches a terminal state. */
export async function* streamHarnessRunEvents(
	target: ApiTarget,
	runId: string,
	after = 0,
	signal?: AbortSignal
): AsyncGenerator<HarnessRunEventEnvelope> {
	const response = await fetchForTarget(target)(
		apiUrl(target, `/api/harness/runs/${encode(runId)}/events?after=${after}`),
		{
			headers: {
				...makeHeaders(target.token, target.userJwt),
				Accept: "text/event-stream",
			},
			signal,
		}
	);
	if (!(response.ok && response.body)) {
		throw new Error(`Failed to stream harness run events: ${response.status}`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.search(/\r?\n\r?\n/);
			while (boundary >= 0) {
				const separator =
					buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + separator.length);
				const payload = frame
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (payload && payload !== "[DONE]") {
					try {
						const event = harnessEventEnvelope.parse(JSON.parse(payload));
						yield event;
						if (terminal(event)) {
							return;
						}
					} catch {
						// Ignore malformed frames; reconnecting with the cursor can
						// recover the durable event.
					}
				}
				boundary = buffer.search(/\r?\n\r?\n/);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export async function cancelHarnessRun(
	target: ApiTarget,
	runId: string
): Promise<boolean> {
	const body = await request(
		target,
		`/api/harness/runs/${encode(runId)}/cancel`,
		{ method: "POST" },
		harnessCancelReply
	);
	return body.cancelled === true;
}

export async function resolveHarnessPermission(
	target: ApiTarget,
	requestId: string,
	optionId?: string
): Promise<boolean> {
	const body = await request(
		target,
		"/api/chat/permission",
		{
			method: "POST",
			body: harnessPermissionBody(requestId, optionId),
		},
		harnessPermissionReply
	);
	return body.resolved === true;
}
