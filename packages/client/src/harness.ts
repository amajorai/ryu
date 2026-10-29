import { SseFrameDecoder } from "@ryuhq/protocol/sse";
import { z } from "zod";
import { wireJsonSchema, wireNumberSchema } from "./wire-json.ts";
// packages/client/src/harness.ts
//
// Typed projection of Core's versioned durable agent-harness API. The API
// returns JSON for control operations and a cursorable SSE stream for events;
// the same run can therefore be driven by a UI, CLI, channel, or SDK client.

import { encodePathId } from "./path-id.ts";
import { buildHeaders, buildUrl, request } from "./request.ts";
import type { RyuClientOptions } from "./types.ts";

export type HarnessRunStatus =
	| "pending"
	| "running"
	| "awaiting_approval"
	| "completed"
	| "failed"
	| "canceled"
	| "interrupted";

/**
 * What a session does when a run is started while another run is active
 * ("double-texting"). `reject` (the default) answers 409; `enqueue` waits in
 * the session's durable queue; `interrupt` stops the active run (keeping its
 * partial transcript) and starts ahead of the queue; `rollback` does the same
 * and removes the stopped run's turns from the transcript first.
 */
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
	output?: z.core.util.JSONType;
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

export interface StartRunInput {
	executionProfile?: ExecutionProfile;
	idempotencyKey?: string;
	input: z.core.util.JSONType | undefined;
	/** Behavior while the session already has an active run (default `reject`). */
	multitaskStrategy?: MultitaskStrategy;
	resumeRunId?: string;
}

export interface StartRunResponse {
	created: boolean;
	/** The active run an `interrupt`/`rollback` start is stopping. */
	displacedRunId?: string | null;
	eventsUrl: string;
	protocolVersion: string;
	/** True when the run waits in the session queue (status `pending`). */
	queued?: boolean;
	run: HarnessRun;
}

export type HarnessRunEvent =
	| {
			activeRunId?: string;
			position: number;
			strategy: MultitaskStrategy;
			type: "run_queued";
	  }
	| {
			executionProfile: ExecutionProfile;
			type: "run_started";
	  }
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
	| { output?: z.core.util.JSONType; type: "run_completed" }
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

const executionProfileSchema = z.object({
	approval: z.enum(["inherit", "on_risk", "always", "never"]),
	cwd: z.string().optional(),
	kind: z.enum(["local", "worktree", "remote", "cloud"]),
	network: z.enum(["inherit", "denied", "gateway_only", "allow"]),
	sandbox: z.enum(["inherit", "workspace", "strict"]),
	worktreeBranch: z.string().optional(),
	worktreeIsolation: z.boolean(),
});
const multitaskStrategySchema = z.enum([
	"reject",
	"enqueue",
	"interrupt",
	"rollback",
]);
const harnessStatusSchema = z.enum([
	"pending",
	"running",
	"awaiting_approval",
	"completed",
	"failed",
	"canceled",
	"interrupted",
]);
const sessionValidation = z.object({
	conversationId: z.string(),
	createdAt: z.string(),
	executionProfile: executionProfileSchema,
	id: z.string(),
	nativeSessionId: z.string().optional(),
	parentSessionId: z.string().optional(),
	protocolVersion: z.string(),
	runnableId: z.string(),
	runnableKind: z.string(),
	status: harnessStatusSchema,
	updatedAt: z.string(),
});
const sessionSchema = z.custom<HarnessSession>(
	(value) => sessionValidation.safeParse(value).success
);
const runValidation = z.object({
	attempt: wireNumberSchema,
	createdAt: z.string(),
	error: z.string().optional(),
	eventCursor: wireNumberSchema,
	executionProfile: executionProfileSchema,
	finishedAt: z.string().optional(),
	id: z.string(),
	idempotencyKey: z.string().optional(),
	multitaskStrategy: multitaskStrategySchema.optional(),
	output: wireJsonSchema.optional(),
	parentRunId: z.string().optional(),
	protocolVersion: z.string(),
	sessionId: z.string(),
	startedAt: z.string().optional(),
	status: harnessStatusSchema,
});
const runSchema = z.custom<HarnessRun>(
	(value) => runValidation.safeParse(value).success
);
const sessionResponseSchema = z.object({
	protocolVersion: z.string(),
	session: sessionSchema,
});
const runsResponseSchema = z.object({
	protocolVersion: z.string(),
	runs: z.array(runSchema),
});
const childrenResponseSchema = z.object({
	sessions: z.array(sessionSchema).nullish(),
});
const startResponseValidation = z.object({
	created: z.boolean(),
	displacedRunId: z.string().nullish(),
	queued: z.boolean().optional(),
	eventsUrl: z.string(),
	protocolVersion: z.string(),
	run: runSchema,
});
const startResponseSchema = z.custom<StartRunResponse>(
	(value) => startResponseValidation.safeParse(value).success
);
const runResponseSchema = z.object({
	protocolVersion: z.string(),
	run: runSchema,
});
const cancellationSchema = z.object({
	cancelled: z.boolean().optional().catch(undefined),
});
const permissionSchema = z.object({
	resolved: z.boolean().optional().catch(undefined),
});
const approvalOptionSchema = z.object({
	kind: z.string(),
	name: z.string(),
	optionId: z.string(),
});
const eventValidation = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("run_queued"),
		activeRunId: z.string().optional(),
		position: wireNumberSchema,
		strategy: multitaskStrategySchema,
	}),
	z.object({
		type: z.literal("run_started"),
		executionProfile: executionProfileSchema,
	}),
	z.object({
		type: z.literal("input_accepted"),
		inputHash: z.string(),
		messageCount: wireNumberSchema,
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
		durationMs: wireNumberSchema.optional(),
		name: z.string(),
		ok: z.boolean(),
		resultHash: z.string().optional(),
		toolCallId: z.string(),
	}),
	z.object({
		type: z.literal("approval_requested"),
		approvalId: z.string(),
		options: z.array(approvalOptionSchema).optional(),
		summary: z.string(),
	}),
	z.object({ type: z.literal("checkpoint"), messageId: z.string().optional() }),
	z.object({
		type: z.literal("run_completed"),
		output: wireJsonSchema.optional(),
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
const envelopeValidation = z.object({
	createdAt: z.string(),
	id: z.string(),
	protocolVersion: z.string(),
	runId: z.string(),
	seq: wireNumberSchema,
	sessionId: z.string(),
});
const eventSchema = z.custom<HarnessRunEventEnvelope>(
	(value) =>
		envelopeValidation.safeParse(value).success &&
		eventValidation.safeParse(value).success
);
interface CreateSessionInput {
	agentId?: string;
	executionProfile?: ExecutionProfile;
	parentSessionId?: string;
	runnableId: string;
	runnableKind: string;
	title?: string;
}
interface StartRunRequest extends StartRunInput {}
interface PermissionRequest {
	option_id?: string;
	request_id: string;
}

/** One path id; `""`, `"."` and `".."` would resolve onto another Core route. */
function encode(id: string): string {
	return encodePathId("Harness", id);
}

function defaultProfile(): ExecutionProfile {
	return {
		approval: "inherit",
		kind: "local",
		network: "inherit",
		sandbox: "inherit",
		worktreeIsolation: false,
	};
}

function normalizeProfile(profile?: ExecutionProfile): ExecutionProfile {
	return { ...defaultProfile(), ...profile };
}

function isTerminal(event: HarnessRunEventEnvelope): boolean {
	return (
		event.type === "run_completed" ||
		event.type === "run_failed" ||
		event.type === "run_canceled" ||
		event.type === "run_interrupted"
	);
}

function parseSsePayload(frame: string): string | null {
	const data = frame
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n");
	return data || null;
}

async function* readEvents(
	options: RyuClientOptions,
	path: string,
	signal?: AbortSignal
): AsyncGenerator<HarnessRunEventEnvelope> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const response = await fetchImpl(buildUrl(options, path), {
		headers: buildHeaders(options, { Accept: "text/event-stream" }),
		signal,
	});
	if (!(response.ok && response.body)) {
		const text = await response.text().catch(() => response.statusText);
		throw new Error(`RyuClient: ${path} failed (${response.status}): ${text}`);
	}

	// Bounded incremental framing: an event that never ends is refused at the
	// frame limit instead of growing this process's memory.
	const reader = response.body.getReader();
	const decoder = new SseFrameDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				decoder.finish();
				break;
			}
			for (const frame of decoder.push(value)) {
				const payload = parseSsePayload(frame);
				if (payload && payload !== "[DONE]") {
					try {
						const event = eventSchema.parse(JSON.parse(payload));
						yield event;
						if (isTerminal(event)) {
							return;
						}
					} catch {
						// Ignore malformed frames; a later cursor page can replay the
						// durable event without terminating the whole subscription.
					}
				}
			}
		}
	} finally {
		decoder.finish();
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export class HarnessAPI {
	private readonly options: RyuClientOptions;

	constructor(options: RyuClientOptions) {
		this.options = options;
	}

	async createSession(input: CreateSessionInput): Promise<HarnessSession> {
		const body: CreateSessionInput = {
			runnableId: input.runnableId,
			runnableKind: input.runnableKind,
		};
		if (input.agentId) {
			body.agentId = input.agentId;
		}
		if (input.title) {
			body.title = input.title;
		}
		if (input.parentSessionId) {
			body.parentSessionId = input.parentSessionId;
		}
		body.executionProfile = normalizeProfile(input.executionProfile);

		const data = await request(
			this.options,
			"/api/harness/sessions",
			{
				body: JSON.stringify(body),
				method: "POST",
			},
			sessionResponseSchema.parse
		);
		return data.session;
	}

	async getSession(sessionId: string): Promise<HarnessSession> {
		const data = await request(
			this.options,
			`/api/harness/sessions/${encode(sessionId)}`,
			undefined,
			sessionResponseSchema.parse
		);
		return data.session;
	}

	async listChildren(sessionId: string): Promise<HarnessSession[]> {
		const data = await request(
			this.options,
			`/api/harness/sessions/${encode(sessionId)}/children`,
			undefined,
			childrenResponseSchema.parse
		);
		return data.sessions ?? [];
	}

	async bindNativeSession(
		sessionId: string,
		nativeSessionId: string
	): Promise<HarnessSession> {
		const data = await request(
			this.options,
			`/api/harness/sessions/${encode(sessionId)}/native`,
			{
				body: JSON.stringify({ nativeSessionId }),
				method: "PUT",
			},
			sessionResponseSchema.parse
		);
		return data.session;
	}

	async listRuns(sessionId: string): Promise<HarnessRun[]> {
		const data = await request(
			this.options,
			`/api/harness/sessions/${encode(sessionId)}/runs`,
			undefined,
			runsResponseSchema.parse
		);
		return data.runs;
	}

	async startRun(
		sessionId: string,
		input: StartRunInput["input"],
		options: Omit<StartRunInput, "input"> = {}
	): Promise<StartRunResponse> {
		const body: StartRunRequest = { input };
		if (options.idempotencyKey) {
			body.idempotencyKey = options.idempotencyKey;
		}
		if (options.resumeRunId) {
			body.resumeRunId = options.resumeRunId;
		}
		if (options.multitaskStrategy) {
			body.multitaskStrategy = options.multitaskStrategy;
		}
		if (options.executionProfile) {
			body.executionProfile = normalizeProfile(options.executionProfile);
		}
		return request(
			this.options,
			`/api/harness/sessions/${encode(sessionId)}/runs`,
			{
				body: JSON.stringify(body),
				method: "POST",
			},
			startResponseSchema.parse
		);
	}

	async getRun(runId: string): Promise<HarnessRun> {
		const data = await request(
			this.options,
			`/api/harness/runs/${encode(runId)}`,
			undefined,
			runResponseSchema.parse
		);
		return data.run;
	}

	/** Stream from an exclusive sequence cursor; reconnect by passing the last seq. */
	events(
		runId: string,
		after = 0,
		signal?: AbortSignal
	): AsyncGenerator<HarnessRunEventEnvelope> {
		return readEvents(
			this.options,
			`/api/harness/runs/${encode(runId)}/events?after=${after}`,
			signal
		);
	}

	/** Start a run and stream its durable typed events. */
	async *run(
		sessionId: string,
		input: StartRunInput["input"],
		options: Omit<StartRunInput, "input"> = {},
		signal?: AbortSignal
	): AsyncGenerator<HarnessRunEventEnvelope> {
		const started = await this.startRun(sessionId, input, options);
		yield* this.events(started.run.id, 0, signal);
	}

	async cancel(runId: string): Promise<boolean> {
		const data = await request(
			this.options,
			`/api/harness/runs/${encode(runId)}/cancel`,
			{ method: "POST" },
			cancellationSchema.parse
		);
		return data.cancelled === true;
	}

	/** Resolve the active ACP permission request surfaced by a harness event. */
	async resolvePermission(
		requestId: string,
		optionId?: string
	): Promise<boolean> {
		const body: PermissionRequest = { request_id: requestId };
		if (optionId) {
			body.option_id = optionId;
		}
		const data = await request(
			this.options,
			"/api/chat/permission",
			{
				body: JSON.stringify(body),
				method: "POST",
			},
			permissionSchema.parse
		);
		return data.resolved === true;
	}
}
