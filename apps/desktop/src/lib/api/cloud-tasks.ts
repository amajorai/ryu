// apps/desktop/src/lib/api/cloud-tasks.ts
//
// Typed client for a conversation's cloud task (`/api/cloud-tasks/{id}`). A cloud
// task is the Core-owned workspace a locked cloud chat runs in. For a "Fresh
// cloud box" environment Core prepares a disposable Box, runs the managed agent
// there, and exposes status, diff review, branch push and stop through these
// routes. The desktop is a projection only: it never talks to the Box service
// and never holds Box or GitHub credentials — Core does.
//
// Soft dependency: an older Core without the status route answers 404 or throws,
// which the caller maps to a hidden panel. A 404 from a current Core means "no
// task for this owner" and is returned as `null`.

import { ApiError, type ApiTarget, request } from "./client.ts";
import {
	type CloudTaskBackendId,
	type CloudTaskNotice,
	parseBackendId,
	parseNotices,
	parseSubscriptionRun,
	type SubscriptionRun,
} from "./cloud-task-backends.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import {
	parseSessionBoxCaps,
	parseSessionBoxView,
	type SessionBoxCaps,
	type SessionBoxView,
} from "./session-box.ts";

export type CloudTaskBackend = "docker" | "opensandbox" | "vpn" | "box";
export type CloudTaskExecutorName =
	| "ryu"
	| "claude-code"
	| "codex"
	| "opencode"
	| "cursor";
export type CloudTaskState =
	| "preparing"
	| "ready"
	| "running"
	| "finishing"
	| "failed"
	| "stopped"
	| "expired"
	| "interrupted";
export type CloudTaskPushError =
	| "auth"
	| "non_fast_forward"
	| "network"
	| "unknown";

/** The managed agent run in progress, with a redacted output tail. */
export interface CloudTaskActiveRun {
	id: string;
	/** Redacted live output, at most 16384 characters. */
	outputTail: string;
	startedAt: string;
	status: "queued" | "running";
}

/** The most recent managed agent run that reached a terminal state. */
export interface CloudTaskLastRun {
	completedAt: string | null;
	exitCode: number | null;
	id: string;
	reason: string | null;
	status: "completed" | "failed";
	summary: string | null;
}

/** Why opening a pull request after a successful push failed. */
export type CloudTaskPullRequestError =
	| "auth"
	| "already_exists"
	| "validation"
	| "network"
	| "unknown";

/** A GitHub pull request Core opened after pushing the task branch. */
export interface CloudTaskPullRequest {
	number: number;
	/** Always a `https://github.com/` URL. */
	url: string;
}

/** The result of the last finish (commit, push, pull request, teardown). */
export interface CloudTaskFinish {
	branch: string | null;
	compareUrl: string | null;
	deletions: number;
	files: number;
	headSha: string | null;
	insertions: number;
	pullRequest: CloudTaskPullRequest | null;
	pullRequestError: CloudTaskPullRequestError | null;
	pushError: CloudTaskPushError | null;
	pushed: boolean;
	teardown: "destroyed" | "kept";
}

export interface CloudTaskStatus {
	activeRun: CloudTaskActiveRun | null;
	backend: CloudTaskBackend;
	baseBranch: string | null;
	baseSha: string | null;
	/** The task's Box: state, screen, cost and warning. Null from an older Core. */
	box: SessionBoxView | null;
	/** The owner's running Boxes against the plan cap. Null from an older Core. */
	caps: SessionBoxCaps | null;
	conversationId: string;
	environmentId: string;
	executor: CloudTaskExecutorName;
	expiresAt: string | null;
	finish: CloudTaskFinish | null;
	lastRun: CloudTaskLastRun | null;
	state: CloudTaskState;
}

export interface CloudTaskDiffFile {
	deletions: number | null;
	insertions: number | null;
	path: string;
}

export interface CloudTaskDiff {
	baseSha: string;
	files: CloudTaskDiffFile[];
	patch: string;
	truncated: boolean;
}

export interface CloudTaskPromptInput {
	/** A linked account to run this session on, as `<provider>:<id>`. */
	account?: string;
	/** The Ryu agent, for its per-agent backend order. */
	agentId?: string;
	/** Run this session on one backend; omitted uses the agent's or the default order. */
	backend?: CloudTaskBackendId;
	environmentId: string;
	/** With `backend`: false makes the choice strict (no fallback). */
	fallback?: boolean;
	text: string;
}

export interface CloudTaskPromptRun {
	/** Where the task runs; older Core runs everything on the Box. */
	backend: CloudTaskBackendId;
	id: string;
	/** Why a preferred plan was skipped (e.g. it hit its usage limit). */
	notices: CloudTaskNotice[];
	/** `submitted` (or the provider's status) for a run on the owner's plan. */
	status: string;
	/** The run on the owner's plan, when it runs there. */
	subscription: SubscriptionRun | null;
}

export interface CloudTaskFinishInput {
	branch?: string;
	commitMessage?: string;
	/** Open the pull request as a draft. Only sent with `openPullRequest`. */
	draft?: boolean;
	/** Open a GitHub pull request after a successful push. Requires `push`. */
	openPullRequest?: boolean;
	/** At most 65536 characters. Only sent with `openPullRequest`. */
	pullRequestBody?: string;
	/** 1-256 characters. Only sent with `openPullRequest`. */
	pullRequestTitle?: string;
	push: boolean;
	teardown: "destroy" | "keep";
}

const BACKENDS: readonly CloudTaskBackend[] = [
	"docker",
	"opensandbox",
	"vpn",
	"box",
];
const EXECUTORS: readonly CloudTaskExecutorName[] = [
	"ryu",
	"claude-code",
	"codex",
	"opencode",
	"cursor",
];
const STATES: readonly CloudTaskState[] = [
	"preparing",
	"ready",
	"running",
	"finishing",
	"failed",
	"stopped",
	"expired",
	"interrupted",
];
const PULL_REQUEST_ERRORS: readonly CloudTaskPullRequestError[] = [
	"auth",
	"already_exists",
	"validation",
	"network",
	"unknown",
];
const GITHUB_PULL_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;
const PUSH_ERRORS: readonly CloudTaskPushError[] = [
	"auth",
	"non_fast_forward",
	"network",
	"unknown",
];

function invalid(): never {
	throw new Error("Invalid cloud task response");
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		invalid();
	}
	// SAFETY: a non-null, non-array object; every field is read as unknown and checked below.
	return value as Record<string, unknown>;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : invalid();
}

function optStr(value: unknown): string | null {
	return value === null || value === undefined ? null : str(value);
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: invalid();
}

function optNum(value: unknown): number | null {
	return value === null || value === undefined ? null : num(value);
}

function bool(value: unknown): boolean {
	return typeof value === "boolean" ? value : invalid();
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
	const found = allowed.find((candidate) => candidate === value);
	return found ?? invalid();
}

function parseActiveRun(value: unknown): CloudTaskActiveRun | null {
	if (value === null || value === undefined) {
		return null;
	}
	const raw = record(value);
	return {
		id: str(raw.id),
		status: oneOf(raw.status, ["queued", "running"] as const),
		startedAt: str(raw.startedAt),
		outputTail: str(raw.outputTail),
	};
}

function parseLastRun(value: unknown): CloudTaskLastRun | null {
	if (value === null || value === undefined) {
		return null;
	}
	const raw = record(value);
	return {
		id: str(raw.id),
		status: oneOf(raw.status, ["completed", "failed"] as const),
		exitCode: optNum(raw.exitCode),
		summary: optStr(raw.summary),
		reason: optStr(raw.reason),
		completedAt: optStr(raw.completedAt),
	};
}

function parsePullRequest(value: unknown): CloudTaskPullRequest | null {
	if (value === null || value === undefined) {
		return null;
	}
	const raw = record(value);
	const url = str(raw.url);
	const number = num(raw.number);
	if (!(GITHUB_PULL_URL.test(url) && Number.isInteger(number) && number > 0)) {
		invalid();
	}
	return { url, number };
}

function parseFinishRecord(value: unknown): CloudTaskFinish | null {
	if (value === null || value === undefined) {
		return null;
	}
	const raw = record(value);
	return {
		branch: optStr(raw.branch),
		headSha: optStr(raw.headSha),
		pushed: bool(raw.pushed),
		pushError:
			raw.pushError === null || raw.pushError === undefined
				? null
				: oneOf(raw.pushError, PUSH_ERRORS),
		compareUrl: optStr(raw.compareUrl),
		pullRequest: parsePullRequest(raw.pullRequest),
		pullRequestError:
			raw.pullRequestError === null || raw.pullRequestError === undefined
				? null
				: oneOf(raw.pullRequestError, PULL_REQUEST_ERRORS),
		teardown: oneOf(raw.teardown, ["destroyed", "kept"] as const),
		files: num(raw.files),
		insertions: num(raw.insertions),
		deletions: num(raw.deletions),
	};
}

/** Validate a `GET /api/cloud-tasks/{id}` body. Throws on any malformed field. */
export function parseCloudTaskStatus(value: unknown): CloudTaskStatus {
	const raw = record(value);
	return {
		conversationId: str(raw.conversationId),
		environmentId: str(raw.environmentId),
		backend: oneOf(raw.backend, BACKENDS),
		executor: oneOf(raw.executor, EXECUTORS),
		state: oneOf(raw.state, STATES),
		expiresAt: optStr(raw.expiresAt),
		baseSha: optStr(raw.baseSha),
		baseBranch: optStr(raw.baseBranch),
		activeRun: parseActiveRun(raw.activeRun),
		lastRun: parseLastRun(raw.lastRun),
		finish: parseFinishRecord(raw.finish),
		box: parseSessionBoxView(raw.box),
		caps: parseSessionBoxCaps(raw.caps),
	};
}

/** Validate a `GET /api/cloud-tasks/{id}/diff` body. */
export function parseCloudTaskDiff(value: unknown): CloudTaskDiff {
	const raw = record(value);
	if (!Array.isArray(raw.files)) {
		invalid();
	}
	return {
		baseSha: str(raw.baseSha),
		files: raw.files.map((file) => {
			const entry = record(file);
			return {
				path: str(entry.path),
				insertions: optNum(entry.insertions),
				deletions: optNum(entry.deletions),
			};
		}),
		patch: str(raw.patch),
		truncated: bool(raw.truncated),
	};
}

/** Validate a `POST /api/cloud-tasks/{id}/finish` body. */
export function parseCloudTaskFinish(value: unknown): CloudTaskFinish {
	return parseFinishRecord(record(value).finish) ?? invalid();
}

export function parsePromptRun(value: unknown): CloudTaskPromptRun {
	const raw = record(value);
	const run = record(raw.run);
	const backend =
		raw.backend === undefined ? "ryu-box" : parseBackendId(raw.backend);
	return {
		backend,
		id: str(run.id),
		notices: parseNotices(raw.notices),
		status:
			backend === "ryu-box"
				? oneOf(run.status, ["queued", "running"] as const)
				: str(run.status),
		subscription:
			raw.subscription === undefined || raw.subscription === null
				? null
				: parseSubscriptionRun(raw.subscription),
	};
}

function taskPath(conversationId: string, suffix = ""): string {
	return `/api/cloud-tasks/${encodeURIComponent(conversationId)}${suffix}`;
}

/** Fetch a conversation's cloud task. Returns null when Core has no task for this owner. */
export async function fetchCloudTask(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<CloudTaskStatus | null> {
	try {
		const raw = await request<unknown>(
			target,
			taskPath(conversationId),
			{ signal },
			gatewayJsonValueSchema
		);
		return parseCloudTaskStatus(raw);
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			return null;
		}
		throw error;
	}
}

/** Send a prompt to the environment's managed agent (`POST .../prompt`). */
export async function startCloudTaskPrompt(
	target: ApiTarget,
	conversationId: string,
	input: CloudTaskPromptInput,
	signal?: AbortSignal
): Promise<CloudTaskPromptRun> {
	const raw = await request<unknown>(
		target,
		taskPath(conversationId, "/prompt"),
		{
			method: "POST",
			body: {
				environmentId: input.environmentId,
				text: input.text,
				...(input.backend ? { backend: input.backend } : {}),
				...(input.backend && input.fallback === false
					? { fallback: false }
					: {}),
				...(input.agentId ? { agentId: input.agentId } : {}),
				...(input.account ? { account: input.account } : {}),
			},
			signal,
		},
		gatewayJsonValueSchema
	);
	return parsePromptRun(raw);
}

/** Review the box's changes against the base commit (`GET .../diff`). */
export async function fetchCloudTaskDiff(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<CloudTaskDiff> {
	const raw = await request<unknown>(
		target,
		taskPath(conversationId, "/diff"),
		{
			signal,
		},
		gatewayJsonValueSchema
	);
	return parseCloudTaskDiff(raw);
}

/** Commit, optionally push, and tear down or keep the box (`POST .../finish`). */
export async function finishCloudTask(
	target: ApiTarget,
	conversationId: string,
	body: CloudTaskFinishInput
): Promise<CloudTaskFinish> {
	const payload: CloudTaskFinishInput = {
		push: body.push,
		teardown: body.teardown,
	};
	if (body.branch !== undefined) {
		payload.branch = body.branch;
	}
	if (body.commitMessage !== undefined) {
		payload.commitMessage = body.commitMessage;
	}
	if (body.push && body.openPullRequest === true) {
		payload.openPullRequest = true;
		if (body.pullRequestTitle !== undefined) {
			payload.pullRequestTitle = body.pullRequestTitle;
		}
		if (body.pullRequestBody !== undefined) {
			payload.pullRequestBody = body.pullRequestBody;
		}
		if (body.draft !== undefined) {
			payload.draft = body.draft;
		}
	}
	const raw = await request<unknown>(
		target,
		taskPath(conversationId, "/finish"),
		{ method: "POST", body: payload },
		gatewayJsonValueSchema
	);
	return parseCloudTaskFinish(raw);
}

/** Stop the cloud task (`POST .../stop`). */
export async function stopCloudTask(
	target: ApiTarget,
	conversationId: string
): Promise<void> {
	await request<undefined>(
		target,
		taskPath(conversationId, "/stop"),
		{ method: "POST" },
		gatewayJsonValueSchema.optional().transform(() => undefined)
	);
}
