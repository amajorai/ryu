// Phase 1c (spec §3.2, "Live failover verdict (1c)"): a mounted chat tab
// publishes what only it can see about its own thread into the interface
// detail store with source "live-tab": the open permission prompt (with its
// respond callback), the exact turn start, the live step (at most 4 Hz, only
// on change), the stream error, an agent-login lapse and the failover verdict.
// The mappers are pure; `useLiveTabPublish` is the one hook ChatPage calls.

import { readToolTiming } from "@ryu/blocks/desktop/agent-elements/tools/tool-timing.tsx";
import {
	type FailoverVerdict,
	getFailoverVerdict,
} from "@ryu/blocks/desktop/agent-elements/utils/live-message-flags.ts";
import {
	type InterfaceActivity,
	type InterfaceActivityKind,
	type InterfaceAsk,
	type InterfaceAskChoice,
	type InterfaceBlocker,
	stepKindForTool,
} from "@ryuhq/protocol/interfaces";
import { useCallback, useEffect, useId, useRef } from "react";
import type { AcpPermissionOption } from "@/src/lib/api/acp.ts";
import {
	activityLabel,
	QUESTION_WAIT_MS,
	toolActivityLabel,
	toolTarget,
} from "@/src/lib/interface-detail.ts";
import { toolNameOf } from "@/src/lib/mission-control/turn-groups.ts";
import {
	isPermissionAnswered,
	type LiveTabPatch,
	liveTabKey,
	useInterfaceDetailStore,
} from "@/src/store/useInterfaceDetailStore.ts";

/** Core's permission waiter gives up after 600 s, like the question waiter. */
export const PERMISSION_WAIT_MS = QUESTION_WAIT_MS;
/** Live steps publish at most 4 times a second. */
export const LIVE_STEP_INTERVAL_MS = 250;
const TITLE_MAX = 40;
const DETAIL_MAX = 160;
const RECENT_STEPS = 5;

const iso = (ms: number) => new Date(ms).toISOString();

function clamp(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A live failover verdict as a blocker. `wait` names the soonest-reopening
 * window across every readable agent, so its reset time is this agent's only
 * when the verdict names this agent. `held` and `no_candidate` failed the
 * turn with no reset time; `reroute` retries elsewhere and is no blocker.
 */
export function failoverBlocker(
	verdict: FailoverVerdict | null,
	threadAgentId: string | null
): InterfaceBlocker | null {
	if (!verdict || verdict.kind === "reroute") {
		return null;
	}
	const own =
		verdict.kind === "wait" &&
		Boolean(verdict.agentId && threadAgentId) &&
		verdict.agentId?.toLowerCase() === threadAgentId?.toLowerCase();
	const blocker: InterfaceBlocker = {
		at: null,
		detail: verdict.note ? clamp(verdict.note, DETAIL_MAX) : null,
		kind: "rate-limited",
		source: "live-tab",
		title: "Limit hit",
	};
	if (own && verdict.resetsAt) {
		blocker.clearsAt = verdict.resetsAt;
	}
	return blocker;
}

/** The ACP permission prompt shape ChatPage holds. */
export interface LivePermissionPrompt {
	options: AcpPermissionOption[];
	requestId: string;
	toolCall: unknown;
}

interface ToolCallObservation {
	fields?: ToolCallObservation;
	kind?: unknown;
	locations?: { path?: unknown }[];
	title?: unknown;
}

function basename(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** Button words per ACP option kind: short, and never hiding the scope of
 *  a destructive choice. Unknown kinds use the option's name cut to two words
 *  ("…" marks the cut), or a tone word when the name is blank. */
const PERMISSION_LABELS = new Map<string, string>([
	["allow_always", "Always allow"],
	["allow_once", "Allow once"],
	["reject_always", "Always deny"],
	["reject_once", "Deny"],
]);

const TONE_WORDS: Record<InterfaceAskChoice["tone"], string> = {
	allow: "Allow",
	deny: "Deny",
	neutral: "Choose",
};

function permissionLabel(
	option: AcpPermissionOption,
	tone: InterfaceAskChoice["tone"]
): string {
	const known = PERMISSION_LABELS.get(option.kind);
	if (known) {
		return known;
	}
	const words = option.name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return TONE_WORDS[tone];
	}
	return words.length > 2 ? `${words.slice(0, 2).join(" ")}…` : words.join(" ");
}

function optionTone(kind: string): InterfaceAskChoice["tone"] {
	if (kind.startsWith("allow")) {
		return "allow";
	}
	return kind.startsWith("reject") ? "deny" : "neutral";
}

/**
 * A live permission prompt as an ask. Its start is when this tab first saw
 * it, so `since` is approximate and the 600 s deadline is an upper bound.
 * Every allow-toned option is destructive; deny never is.
 */
export function permissionAsk(
	prompt: LivePermissionPrompt,
	firstSeenMs: number,
	owner: { agentId: string | null; threadId: string }
): InterfaceAsk {
	const call = (prompt.toolCall ?? {}) as ToolCallObservation;
	const named =
		typeof call.title === "string"
			? call.title
			: typeof call.fields?.title === "string"
				? call.fields.title
				: "";
	const kind =
		typeof call.kind === "string"
			? call.kind
			: typeof call.fields?.kind === "string"
				? call.fields.kind
				: null;
	const path = (call.locations ?? call.fields?.locations)?.[0]?.path;
	const choices = prompt.options.map((option) => {
		const tone = optionTone(option.kind);
		return {
			destructive: tone === "allow",
			id: option.optionId,
			label: permissionLabel(option, tone),
			tone,
		};
	});
	// Labels that collide would give two buttons one name: Open only.
	const distinct =
		new Set(choices.map((choice) => choice.label.toLowerCase())).size ===
		choices.length;
	const ask: InterfaceAsk = {
		agentId: owner.agentId,
		blocking: true,
		expiresApprox: true,
		expiresAt: iso(firstSeenMs + PERMISSION_WAIT_MS),
		holdsRun: true,
		id: `permission:${prompt.requestId}`,
		kind: "permission",
		reason: null,
		since: iso(firstSeenMs),
		sinceApprox: true,
		source: "live-tab",
		subject: kind,
		target: typeof path === "string" && path ? clamp(basename(path), 40) : null,
		text: named.trim()
			? clamp(`Allow ${named.trim()}?`, 80)
			: "Allow this tool to run?",
		threadId: owner.threadId,
	};
	if (distinct) {
		ask.choices = choices;
	}
	return ask;
}

interface LivePart {
	id?: unknown;
	input?: unknown;
	state?: unknown;
	toolName?: unknown;
	type?: unknown;
}

interface LiveMessage {
	id?: string;
	parts?: readonly unknown[];
	role: string;
}

function isToolPart(part: LivePart): boolean {
	return (
		typeof part.type === "string" &&
		(part.type.startsWith("tool-") || part.type === "dynamic-tool")
	);
}

/** The live step of the newest turn (`useChat` messages), or null between turns. */
export function liveActivity(
	messages: readonly LiveMessage[],
	nowMs: number
): InterfaceActivity | null {
	let start = messages.length;
	while (start > 0 && messages[start - 1]?.role !== "user") {
		start -= 1;
	}
	const parts = messages
		.slice(start)
		.filter((message) => message.role === "assistant")
		.flatMap((message) => (message.parts ?? []) as LivePart[])
		.filter((part) => typeof part === "object" && part !== null);
	const recent: InterfaceActivityKind[] = [];
	for (const part of parts) {
		if (isToolPart(part) && String(part.state).startsWith("output")) {
			recent.push(stepKindForTool(toolNameOf(part as never)));
		}
	}
	// The newest step: skip markers such as step-start or data-ryu-* parts.
	const last = [...parts]
		.reverse()
		.find(
			(part) =>
				isToolPart(part) || part.type === "reasoning" || part.type === "text"
		);
	if (!last) {
		return null;
	}
	let kind: InterfaceActivityKind;
	let tool: string | null = null;
	let target: string | null = null;
	let since: string | null = null;
	if (isToolPart(last) && String(last.state).startsWith("input")) {
		tool = toolNameOf(last as never);
		kind = last.id === "acp-plan" ? "plan" : stepKindForTool(tool);
		target = toolTarget(last.input);
		const timing = readToolTiming(last);
		since = timing ? iso(timing.startedAt) : null;
	} else if (last.type === "reasoning") {
		kind = "think";
	} else if (last.type === "text") {
		kind = "answer";
	} else {
		return null;
	}
	return {
		kind,
		label: tool
			? toolActivityLabel(last, kind, tool)
			: activityLabel(kind, tool, target),
		observedAt: iso(nowMs),
		recent: recent.slice(-RECENT_STEPS),
		since,
		source: "live-tab",
		target,
		tool,
	};
}

/** The newest failover verdict in the newest assistant message. */
export function latestFailoverVerdict(
	messages: readonly LiveMessage[]
): FailoverVerdict | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role === "user") {
			return null;
		}
		const parts = message?.parts ?? [];
		for (let j = parts.length - 1; j >= 0; j -= 1) {
			const verdict = getFailoverVerdict(parts[j] as never);
			if (verdict) {
				return verdict;
			}
		}
	}
	return null;
}

/** The stream's own error as a blocker, at the time this tab saw it. */
export function streamErrorBlocker(
	error: { message?: string } | null | undefined,
	atMs: number
): InterfaceBlocker | null {
	if (!error) {
		return null;
	}
	const message = error.message?.trim() || null;
	return {
		at: iso(atMs),
		atApprox: true,
		detail: message ? clamp(message, DETAIL_MAX) : null,
		kind: "error",
		source: "live-tab",
		title: message ? clamp(message, TITLE_MAX) : "Run failed",
	};
}

/** An agent-login lapse (data-ryu-acp-auth-required) as a blocker. */
export function authBlocker(
	auth: { message: string } | null | undefined,
	atMs: number
): InterfaceBlocker | null {
	if (!auth) {
		return null;
	}
	return {
		at: iso(atMs),
		atApprox: true,
		detail: auth.message ? clamp(auth.message, DETAIL_MAX) : null,
		kind: "auth",
		source: "live-tab",
		title: "Agent login expired",
	};
}

/** Identity of a step: publishing waits for this to change. */
export function stepKey(activity: InterfaceActivity | null): string {
	return activity
		? `${activity.kind}|${activity.tool ?? ""}|${activity.target ?? ""}|${activity.since ?? ""}|${activity.label}`
		: "";
}

/**
 * Publish live steps at most once per `intervalMs`, and only when the step
 * changed. The trailing change in a burst is delivered when the window ends.
 */
export function createStepThrottle(
	publish: (activity: InterfaceActivity | null) => void,
	intervalMs = LIVE_STEP_INTERVAL_MS,
	clock: () => number = Date.now,
	schedule: (fn: () => void, ms: number) => unknown = setTimeout,
	cancel: (handle: unknown) => void = (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>)
) {
	let lastKey: string | null = null;
	let lastAt = Number.NEGATIVE_INFINITY;
	let pending: InterfaceActivity | null = null;
	let pendingKey: string | null = null;
	let timer: unknown = null;
	const flush = () => {
		timer = null;
		if (pendingKey === null || pendingKey === lastKey) {
			return;
		}
		lastKey = pendingKey;
		lastAt = clock();
		publish(pending);
	};
	return {
		cancel: () => {
			if (timer !== null) {
				cancel(timer);
				timer = null;
			}
		},
		push: (activity: InterfaceActivity | null) => {
			const key = stepKey(activity);
			pending = activity;
			pendingKey = key;
			if (key === lastKey) {
				return;
			}
			const wait = lastAt + intervalMs - clock();
			if (wait <= 0) {
				flush();
			} else if (timer === null) {
				timer = schedule(flush, wait);
			}
		},
	};
}

/**
 * An agent-login lapse in the NEWEST turn only (data-ryu-acp-auth-required
 * after the last user message), so a lapse fixed by a later clean turn is not
 * published again. The chat's own toast keeps its whole-transcript scan.
 */
export function latestAuthLapse(
	messages: readonly LiveMessage[]
): { key: string; message: string } | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role === "user") {
			return null;
		}
		const parts = (message?.parts ?? []) as {
			data?: { agentId?: unknown; message?: unknown };
			type?: unknown;
		}[];
		for (let j = parts.length - 1; j >= 0; j -= 1) {
			const part = parts[j];
			if (
				part?.type === "data-ryu-acp-auth-required" &&
				typeof part.data?.agentId === "string"
			) {
				return {
					// Message ids survive older history being prepended; indices do not.
					key: `${message?.id ?? i}:${j}:${part.data.agentId}`,
					message:
						typeof part.data.message === "string" ? part.data.message : "",
				};
			}
		}
	}
	return null;
}

export interface LiveTabPublishInput {
	/** The prompt ChatPage shows (its `activePermission`). */
	activePermission: LivePermissionPrompt | null;
	/** The thread's own agent (null when unknown: no reset time is shown). */
	agentId: string | null;
	error: { message?: string } | null | undefined;
	messages: readonly LiveMessage[];
	/** The node this tab talks to: live entries are keyed by node and thread. */
	nodeUrl: string;
	/** ChatPage's own respondToPermission, so the card and the ask clear together. */
	respondToPermission: (requestId: string, optionId: string | null) => void;
	/** The turn is in flight (ChatPage's effective status, resumed turns too). */
	running: boolean;
	/** `data-ryu-turn-control` startedAtMs of the current turn. */
	startedAtMs: number | null;
	threadId: string | null;
}

/**
 * Keep this tab's live entry in the interface detail store, under this
 * tab's own publisher token (two tabs can show one thread) and its node.
 * Removes the permission when the prompt changes, the run stops, or its
 * deadline passes, and this tab's entry when it unmounts or changes thread
 * or node.
 */
export function useLiveTabPublish(input: LiveTabPublishInput): void {
	const latest = useRef(input);
	latest.current = input;
	const { agentId, nodeUrl, running, startedAtMs, threadId } = input;
	const publisher = useId();
	const firstSeen = useRef(new Map<string, number>());
	const publish = useCallback(
		(id: string, patch: LiveTabPatch) =>
			useInterfaceDetailStore
				.getState()
				.publishLive({ nodeUrl, threadId: id }, patch, publisher),
		[nodeUrl, publisher]
	);

	// This tab's entry goes with the tab (or when it moves to another thread
	// or node).
	useEffect(() => {
		if (!threadId) {
			return;
		}
		return () =>
			useInterfaceDetailStore
				.getState()
				.removeLive({ nodeUrl, threadId }, publisher);
	}, [nodeUrl, threadId, publisher]);

	// Permission: only while the run is live, until its upper-bound deadline.
	// A new request id replaces the old prompt.
	const requestId = input.activePermission?.requestId ?? null;
	useEffect(() => {
		const prompt = latest.current.activePermission;
		if (!threadId) {
			return;
		}
		const answered =
			requestId !== null &&
			isPermissionAnswered(
				useInterfaceDetailStore.getState().answeredPermissions,
				{ nodeUrl, requestId, threadId }
			);
		if (!(prompt && requestId && running) || answered) {
			publish(threadId, { permission: null });
			return;
		}
		const seen = firstSeen.current.get(requestId) ?? Date.now();
		firstSeen.current.set(requestId, seen);
		const ask = permissionAsk(prompt, seen, { agentId, threadId });
		publish(threadId, {
			permission: {
				ask,
				// ChatPage's respondToPermission POSTs once and marks the request
				// answered for every tab, which clears this ask everywhere.
				respond: (optionId) =>
					latest.current.respondToPermission(requestId, optionId),
			},
		});
		const scope = { nodeUrl, threadId };
		const timer = setTimeout(
			() =>
				useInterfaceDetailStore
					.getState()
					.clearLivePermission(scope, ask.id, publisher),
			Math.max(0, seen + PERMISSION_WAIT_MS - Date.now())
		);
		return () => {
			clearTimeout(timer);
			useInterfaceDetailStore
				.getState()
				.clearLivePermission(scope, ask.id, publisher);
		};
	}, [nodeUrl, threadId, requestId, running, agentId, publish, publisher]);

	// Whether this tab's turn runs, and its exact start.
	useEffect(() => {
		if (threadId) {
			publish(threadId, {
				running,
				startedAtMs: running ? startedAtMs : null,
			});
		}
	}, [threadId, running, startedAtMs, publish]);

	// Blockers: the failover verdict, the stream error, a login lapse in the
	// newest turn. The keys summarise the objects, so a re-render with equal
	// content publishes nothing, and each blocker keeps the time it was first
	// seen (approximate: the tab saw it, Core did not time it).
	const verdict = latestFailoverVerdict(input.messages);
	const verdictKey = verdict
		? `${verdict.kind}|${verdict.agentId ?? ""}|${verdict.resetsAt ?? ""}|${verdict.note ?? ""}`
		: "";
	const errorKey = input.error ? `error:${input.error.message ?? ""}` : "";
	const authKey = latestAuthLapse(input.messages)?.key ?? "";
	// First-seen times of the current blockers. Cleared when a run starts,
	// when nothing is published and on a thread change, so a later failure
	// with the same words gets its own time.
	const seenAt = useRef(new Map<string, number>());
	const seenThread = useRef<string | null>(null);
	useEffect(() => {
		if (!threadId) {
			return;
		}
		if (running || seenThread.current !== threadId) {
			seenAt.current = new Map();
			seenThread.current = threadId;
		}
		const firstSeenOf = (key: string) => {
			const at = seenAt.current.get(key) ?? Date.now();
			seenAt.current = new Map([[key, at]]);
			return at;
		};
		const { error, messages } = latest.current;
		let blocker: InterfaceBlocker | null = failoverBlocker(
			latestFailoverVerdict(messages),
			agentId
		);
		if (!(blocker || running) && errorKey) {
			blocker = streamErrorBlocker(error, firstSeenOf(errorKey));
		}
		if (!(blocker || running) && authKey) {
			blocker = authBlocker(latestAuthLapse(messages), firstSeenOf(authKey));
		}
		if (!blocker) {
			seenAt.current = new Map();
		}
		publish(threadId, { blocker });
	}, [threadId, agentId, running, verdictKey, errorKey, authKey, publish]);

	// Live steps, at most 4 Hz and only on change.
	const throttle = useRef<ReturnType<typeof createStepThrottle> | null>(null);
	useEffect(() => {
		if (!threadId) {
			return;
		}
		const handle = createStepThrottle((activity) => {
			publish(threadId, {
				activity,
				lastProgressAt: activity ? new Date().toISOString() : null,
			});
		});
		throttle.current = handle;
		return () => {
			handle.cancel();
			throttle.current = null;
		};
	}, [threadId, publish]);
	const messages = input.messages;
	useEffect(() => {
		throttle.current?.push(running ? liveActivity(messages, Date.now()) : null);
	}, [messages, running]);
}

/** One permission prompt where it sits: its message and request id. */
export function permissionPartKey(
	messageId: string,
	requestId: string
): string {
	return JSON.stringify([messageId, requestId]);
}

/**
 * The prompts in `messages` (by `permissionPartKey`) that were answered. A
 * tab records them when its turn ends, so it can forget the answered request
 * ids (a later turn may reuse them) and still never show those prompts again.
 */
export function answeredPermissionParts(
	messages: readonly LiveMessage[],
	isAnswered: (requestId: string) => boolean
): string[] {
	const keys: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !message.id) {
			continue;
		}
		for (const part of (message.parts ?? []) as {
			data?: { requestId?: unknown };
			type?: unknown;
		}[]) {
			const requestId = part?.data?.requestId;
			if (
				part?.type === "data-ryu-permission" &&
				typeof requestId === "string" &&
				requestId &&
				isAnswered(requestId)
			) {
				keys.push(permissionPartKey(message.id, requestId));
			}
		}
	}
	return keys;
}

/**
 * When this tab's turn ends, its permissions are spent, and a later turn (or
 * a restarted Core) can mint the same `perm-<seq>` again. Forget what was
 * answered on this node's conversation, so that prompt is not hidden; a tab
 * still streaming the thread keeps the shared answers until it ends too.
 * `onTurnEnd` runs first, so the tab can record the prompts it answered
 * (`answeredPermissionParts`) before it clears its own request ids. Call it
 * after `useLiveTabPublish`, so this tab's own entry already reads as stopped.
 */
export function useAnsweredPermissionPrune(input: {
	nodeUrl: string;
	onTurnEnd: () => void;
	running: boolean;
	threadId: string;
}): void {
	const { nodeUrl, running, threadId } = input;
	const onTurnEnd = useRef(input.onTurnEnd);
	onTurnEnd.current = input.onTurnEnd;
	const wasRunning = useRef(running);
	useEffect(() => {
		const ended = wasRunning.current && !running;
		wasRunning.current = running;
		if (!ended) {
			return;
		}
		onTurnEnd.current();
		const store = useInterfaceDetailStore.getState();
		const scope = { nodeUrl, threadId };
		const othersRunning = Object.values(
			store.publishers[liveTabKey(scope)] ?? {}
		).some((entry) => entry.running);
		if (!othersRunning) {
			store.pruneAnsweredPermissions(scope);
		}
	}, [nodeUrl, running, threadId]);
}
