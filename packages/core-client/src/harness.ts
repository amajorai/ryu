// packages/core-client/src/harness.ts
//
// Shared platform client for Core's durable agent-harness projection. The
// desktop, native, and other first-party surfaces use this module; external
// embedders can use the lighter @ryuhq/client wrapper.

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

export type HarnessRunEvent =
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
	const body = await request<{ session: HarnessSession }>(
		target,
		"/api/harness/sessions",
		{
			method: "POST",
			body: {
				runnableId: input.runnableId,
				runnableKind: input.runnableKind,
				executionProfile: profile(input.executionProfile),
				...(input.agentId ? { agentId: input.agentId } : {}),
				...(input.parentSessionId
					? { parentSessionId: input.parentSessionId }
					: {}),
				...(input.title ? { title: input.title } : {}),
			},
		}
	);
	return body.session;
}

export async function getHarnessSession(
	target: ApiTarget,
	sessionId: string
): Promise<HarnessSession> {
	const body = await request<{ session: HarnessSession }>(
		target,
		`/api/harness/sessions/${encode(sessionId)}`
	);
	return body.session;
}

export async function listChildHarnessSessions(
	target: ApiTarget,
	sessionId: string
): Promise<HarnessSession[]> {
	const body = await request<{ sessions?: HarnessSession[] }>(
		target,
		`/api/harness/sessions/${encode(sessionId)}/children`
	);
	return body.sessions ?? [];
}

export async function bindNativeSession(
	target: ApiTarget,
	sessionId: string,
	nativeSessionId: string
): Promise<HarnessSession> {
	const body = await request<{ session: HarnessSession }>(
		target,
		`/api/harness/sessions/${encode(sessionId)}/native`,
		{
			method: "PUT",
			body: { nativeSessionId },
		}
	);
	return body.session;
}

export async function listHarnessRuns(
	target: ApiTarget,
	sessionId: string
): Promise<HarnessRun[]> {
	const body = await request<{ runs?: HarnessRun[] }>(
		target,
		`/api/harness/sessions/${encode(sessionId)}/runs`
	);
	return body.runs ?? [];
}

export async function startHarnessRun(
	target: ApiTarget,
	sessionId: string,
	input: unknown,
	options: {
		executionProfile?: ExecutionProfile;
		idempotencyKey?: string;
		resumeRunId?: string;
	} = {}
): Promise<{ created: boolean; eventsUrl: string; run: HarnessRun }> {
	return request(target, `/api/harness/sessions/${encode(sessionId)}/runs`, {
		method: "POST",
		body: {
			input,
			...(options.executionProfile
				? { executionProfile: profile(options.executionProfile) }
				: {}),
			...(options.idempotencyKey
				? { idempotencyKey: options.idempotencyKey }
				: {}),
			...(options.resumeRunId ? { resumeRunId: options.resumeRunId } : {}),
		},
	});
}

export async function getHarnessRun(
	target: ApiTarget,
	runId: string
): Promise<HarnessRun> {
	const body = await request<{ run: HarnessRun }>(
		target,
		`/api/harness/runs/${encode(runId)}`
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
						const event = JSON.parse(payload) as HarnessRunEventEnvelope;
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
	const body = await request<{ cancelled?: boolean }>(
		target,
		`/api/harness/runs/${encode(runId)}/cancel`,
		{ method: "POST" }
	);
	return body.cancelled === true;
}

export async function resolveHarnessPermission(
	target: ApiTarget,
	requestId: string,
	optionId?: string
): Promise<boolean> {
	const body = await request<{ resolved?: boolean }>(
		target,
		"/api/chat/permission",
		{
			method: "POST",
			body: {
				request_id: requestId,
				...(optionId ? { option_id: optionId } : {}),
			},
		}
	);
	return body.resolved === true;
}
