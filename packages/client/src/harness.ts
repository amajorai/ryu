// packages/client/src/harness.ts
//
// Typed projection of Core's versioned durable agent-harness API. The API
// returns JSON for control operations and a cursorable SSE stream for events;
// the same run can therefore be driven by a UI, CLI, channel, or SDK client.

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
	output?: unknown;
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
	input: unknown;
	resumeRunId?: string;
}

export interface StartRunResponse {
	created: boolean;
	eventsUrl: string;
	protocolVersion: string;
	run: HarnessRun;
}

export type HarnessRunEvent =
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
	| { output?: unknown; type: "run_completed" }
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

interface SessionResponse {
	protocolVersion: string;
	session: HarnessSession;
}

interface RunsResponse {
	protocolVersion: string;
	runs: HarnessRun[];
}

function encode(id: string): string {
	return encodeURIComponent(id);
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
				const match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
				const separatorLength = match?.[0].length ?? 2;
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + separatorLength);
				const payload = parseSsePayload(frame);
				if (payload && payload !== "[DONE]") {
					try {
						const event = JSON.parse(payload) as HarnessRunEventEnvelope;
						yield event;
						if (isTerminal(event)) {
							return;
						}
					} catch {
						// Ignore malformed frames; a later cursor page can replay the
						// durable event without terminating the whole subscription.
					}
				}
				boundary = buffer.search(/\r?\n\r?\n/);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export class HarnessAPI {
	private readonly options: RyuClientOptions;

	constructor(options: RyuClientOptions) {
		this.options = options;
	}

	async createSession(input: {
		agentId?: string;
		executionProfile?: ExecutionProfile;
		parentSessionId?: string;
		runnableId: string;
		runnableKind: string;
		title?: string;
	}): Promise<HarnessSession> {
		const data = await request<SessionResponse>(
			this.options,
			"/api/harness/sessions",
			{
				body: JSON.stringify({
					runnableId: input.runnableId,
					runnableKind: input.runnableKind,
					...(input.agentId ? { agentId: input.agentId } : {}),
					...(input.title ? { title: input.title } : {}),
					...(input.parentSessionId
						? { parentSessionId: input.parentSessionId }
						: {}),
					executionProfile: normalizeProfile(input.executionProfile),
				}),
				method: "POST",
			}
		);
		return data.session;
	}

	async getSession(sessionId: string): Promise<HarnessSession> {
		const data = await request<SessionResponse>(
			this.options,
			`/api/harness/sessions/${encode(sessionId)}`
		);
		return data.session;
	}

	async listChildren(sessionId: string): Promise<HarnessSession[]> {
		const data = await request<{ sessions?: HarnessSession[] }>(
			this.options,
			`/api/harness/sessions/${encode(sessionId)}/children`
		);
		return data.sessions ?? [];
	}

	async bindNativeSession(
		sessionId: string,
		nativeSessionId: string
	): Promise<HarnessSession> {
		const data = await request<SessionResponse>(
			this.options,
			`/api/harness/sessions/${encode(sessionId)}/native`,
			{
				body: JSON.stringify({ nativeSessionId }),
				method: "PUT",
			}
		);
		return data.session;
	}

	async listRuns(sessionId: string): Promise<HarnessRun[]> {
		const data = await request<RunsResponse>(
			this.options,
			`/api/harness/sessions/${encode(sessionId)}/runs`
		);
		return data.runs;
	}

	async startRun(
		sessionId: string,
		input: unknown,
		options: Omit<StartRunInput, "input"> = {}
	): Promise<StartRunResponse> {
		return request<StartRunResponse>(
			this.options,
			`/api/harness/sessions/${encode(sessionId)}/runs`,
			{
				body: JSON.stringify({
					input,
					...(options.idempotencyKey
						? { idempotencyKey: options.idempotencyKey }
						: {}),
					...(options.resumeRunId ? { resumeRunId: options.resumeRunId } : {}),
					...(options.executionProfile
						? { executionProfile: normalizeProfile(options.executionProfile) }
						: {}),
				}),
				method: "POST",
			}
		);
	}

	async getRun(runId: string): Promise<HarnessRun> {
		const data = await request<{ protocolVersion: string; run: HarnessRun }>(
			this.options,
			`/api/harness/runs/${encode(runId)}`
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
		input: unknown,
		options: Omit<StartRunInput, "input"> = {},
		signal?: AbortSignal
	): AsyncGenerator<HarnessRunEventEnvelope> {
		const started = await this.startRun(sessionId, input, options);
		yield* this.events(started.run.id, 0, signal);
	}

	async cancel(runId: string): Promise<boolean> {
		const data = await request<{ cancelled?: boolean }>(
			this.options,
			`/api/harness/runs/${encode(runId)}/cancel`,
			{ method: "POST" }
		);
		return data.cancelled === true;
	}

	/** Resolve the active ACP permission request surfaced by a harness event. */
	async resolvePermission(
		requestId: string,
		optionId?: string
	): Promise<boolean> {
		const data = await request<{ resolved?: boolean }>(
			this.options,
			"/api/chat/permission",
			{
				body: JSON.stringify({
					request_id: requestId,
					...(optionId ? { option_id: optionId } : {}),
				}),
				method: "POST",
			}
		);
		return data.resolved === true;
	}
}
