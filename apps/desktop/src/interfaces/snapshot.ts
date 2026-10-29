// The desktop's adapter from its live chat state to the Interface Protocol's
// one read model. Every interface renders this snapshot, so this is the only
// place that knows how desktop conversations, agents, and teams are shaped.

import {
	agentActs,
	compareAsks,
	estimateProgress,
	INTERFACE_PROTOCOL_VERSION,
	type InterfaceAccount,
	type InterfaceAgent,
	type InterfaceAgentLimit,
	type InterfaceAsk,
	type InterfaceAskKind,
	type InterfaceBlocker,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceHelpers,
	type InterfaceSnapshot,
	type InterfaceThread,
	redactSnapshot,
	shortLine,
	type ThreadRunState,
} from "@ryuhq/protocol/interfaces";
import { conversationParticipantIds } from "@/src/lib/agent-conversation-groups.ts";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import {
	ledgerReasonLabel,
	type WalletResponse,
} from "@/src/lib/api/credits.ts";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import type { UsageSnapshot } from "@/src/lib/api/usage.ts";
import {
	type CalendarEvent,
	cronFireTimes,
} from "@/src/lib/calendar/events.ts";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import {
	interfaceDetailRevision,
	resolveLastProgress,
	type ThreadDetail,
} from "@/src/lib/interface-detail.ts";
import {
	isHiddenSession,
	isProjectMainThread,
} from "@/src/lib/thread-hierarchy.ts";
import type { Conversation } from "@/types/chat.ts";
import type { InterfaceDetailInput } from "./use-interface-detail.ts";

/** The protocol's redactor; `buildInterfaceSnapshot` runs it last when privacy is "redacted". */
export { redactSnapshot };

/**
 * Reuse the previous snapshot's thread objects where nothing changed, so a
 * step change in one thread does not hand renderers 500 new threads (spec
 * §3.1, risk 4). Pure: equal content keeps the old reference.
 */
export function stabilizeSnapshot(
	previous: InterfaceSnapshot | null,
	next: InterfaceSnapshot
): InterfaceSnapshot {
	if (!previous) {
		return next;
	}
	const before = new Map(previous.threads.map((thread) => [thread.id, thread]));
	let changed = previous.threads.length !== next.threads.length;
	const threads = next.threads.map((thread, index) => {
		const old = before.get(thread.id);
		const same = old !== undefined && sameThread(old, thread);
		if (!same || previous.threads[index] !== old) {
			changed = true;
		}
		return same && old ? old : thread;
	});
	return {
		...next,
		threads: changed ? threads : previous.threads,
	};
}

/** Each thread object is serialized at most once (objects are immutable). */
const serialized = new WeakMap<InterfaceThread, string>();

function serialize(thread: InterfaceThread): string {
	let text = serialized.get(thread);
	if (text === undefined) {
		text = JSON.stringify(thread);
		serialized.set(thread, text);
	}
	return text;
}

/** A cheap key of what usually changes; only equal keys pay for a deep compare. */
function threadKey(thread: InterfaceThread): string {
	return [
		thread.updatedAt,
		thread.messageCount,
		thread.running,
		thread.runState,
		thread.unread,
		thread.detail,
		thread.activity?.label,
		thread.activity?.since,
		thread.progress?.done,
		thread.blocker?.kind,
		thread.lastProgressAt,
	].join("|");
}

function sameThread(a: InterfaceThread, b: InterfaceThread): boolean {
	if (a === b) {
		return true;
	}
	return threadKey(a) === threadKey(b) && serialize(a) === serialize(b);
}

/**
 * Attach the usage account to a built snapshot. The account is loaded after
 * the build (it links spend to the snapshot's threads), so a redacted
 * snapshot is redacted again with it: ledger labels are user content too.
 */
export function withInterfaceAccount(
	snapshot: InterfaceSnapshot,
	account: InterfaceAccount | undefined
): InterfaceSnapshot {
	if (!account) {
		return snapshot;
	}
	const merged = { ...snapshot, account };
	return snapshot.privacy === "redacted" ? redactSnapshot(merged) : merged;
}

/**
 * Most recent threads an interface receives. Older ones are left out of the
 * snapshot; the interface's top bar says how many (see
 * {@link omittedInterfaceThreads}) and they stay reachable from the Console
 * sidebar and search.
 */
export const MAX_INTERFACE_THREADS = 500;

const EPOCH_ISO = new Date(0).toISOString();

export interface SnapshotAgentInput {
	avatarUrl: string | null;
	description: string | null;
	id: string;
	/** The agent's configured model id, when known. */
	model?: string | null;
	name: string;
}

export interface SnapshotTeamInput {
	id: string;
	members: readonly string[];
	name: string;
}

export interface SnapshotProjectInput {
	id: string;
	name: string;
}

/** Most scheduled runs an interface receives (the calendar already collapses
 *  high-frequency schedules into one marker per day). */
export const MAX_INTERFACE_EVENTS = 1000;

/**
 * Scheduled runs as protocol events, oldest first. Core's internal maintenance
 * jobs stay out: they are not the user's routines. Over the cap, the runs
 * nearest `now` are kept, so a long history never crowds out what is next.
 */
export function toInterfaceEvents(
	events: readonly CalendarEvent[],
	now: number = Date.now()
): InterfaceEvent[] {
	const userEvents = events.filter((event) => !event.system);
	// Over the cap, keep the runs nearest `now`: recent history (which feeds
	// estimates and routine failures) and what is next both survive, and the
	// list is still delivered oldest first.
	const kept =
		userEvents.length > MAX_INTERFACE_EVENTS
			? [...userEvents]
					.sort(
						(a, b) =>
							Math.abs(a.start.getTime() - now) -
								Math.abs(b.start.getTime() - now) || a.id.localeCompare(b.id)
					)
					.slice(0, MAX_INTERFACE_EVENTS)
			: userEvents;
	return kept
		.map(
			(event): InterfaceEvent => ({
				agentId: event.agentId ?? null,
				count: event.aggregateCount ?? null,
				end: event.end ? toIso(event.end.getTime()) : null,
				error: event.error ?? null,
				id: event.id,
				jobId: event.jobId,
				kind: event.kind,
				label: event.scheduleLabel || null,
				outcome: event.outcome ?? null,
				requiresApproval: event.requireApproval === true,
				start: toIso(event.start.getTime()),
				// A persistent routine's chat for every run; a per-firing run's own
				// conversation only when it succeeded (Core records no run id for a
				// failure; linkOrphanRuns finds that one).
				threadId:
					event.conversationId ??
					(event.outcome === "success" ? (event.runId ?? null) : null),
				title: event.workflowName ?? event.jobName,
			})
		)
		.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/** Most recent transactions an interface receives. */
export const MAX_INTERFACE_TRANSACTIONS = 200;

/**
 * The credits wallet as the protocol's usage account. A ledger row's
 * reference becomes a thread id only when it names a thread in the snapshot,
 * so an interface never links spend to the wrong conversation. Gateway writes
 * the request ID into `refId` for ordinary `gateway_usage` charges, so those
 * rows never match a thread and carry `threadId: null`; only rows whose `refId`
 * is a thread ID (routine or agent runs) are linked.
 */
export function toInterfaceAccount(
	response: WalletResponse,
	threadIds: ReadonlySet<string>
): InterfaceAccount {
	const { ledger, wallet } = response;
	const transactions = [...ledger]
		.sort(
			(a, b) =>
				b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
		)
		.slice(0, MAX_INTERFACE_TRANSACTIONS)
		.map((entry) => ({
			amount: entry.delta,
			at: toIso(Date.parse(entry.createdAt)),
			balanceAfter: Number.isFinite(entry.balanceAfter)
				? entry.balanceAfter
				: null,
			id: entry.id,
			inputTokens: entry.inputTokens,
			kind: entry.delta < 0 ? ("debit" as const) : ("credit" as const),
			label: entry.taskLabel || ledgerReasonLabel(entry.reason) || entry.reason,
			model: entry.model,
			outputTokens: entry.outputTokens,
			provider: entry.upstreamProvider ?? entry.provider,
			threadId: entry.refId && threadIds.has(entry.refId) ? entry.refId : null,
		}));
	const breakdownKnown =
		wallet.subscriptionBalanceMicroUsd !== null ||
		wallet.topupBalanceMicroUsd !== null ||
		(wallet.giftBalanceMicroUsd ?? null) !== null;
	return {
		balance: Number.isFinite(wallet.balanceMicroUsd)
			? wallet.balanceMicroUsd
			: null,
		breakdown: breakdownKnown
			? {
					gift: wallet.giftBalanceMicroUsd ?? null,
					plan: wallet.subscriptionBalanceMicroUsd,
					topup: wallet.topupBalanceMicroUsd,
				}
			: null,
		currency: wallet.currency.toLowerCase(),
		transactions,
	};
}

/** A run-stream row's status and its write time (epoch ms, as Core sends it). */
export interface RunFrameStatus {
	run_status: string | null;
	/** Epoch ms from the same `conversations.updated_at` column as
	 *  `Conversation.updatedAt`; never rescale either. */
	updated_at: number;
}

/** How this session saw a run end: exact only from a completed / failed delta. */
export interface TerminalSeen {
	approx: boolean;
	atMs: number;
	/** The terminal status and row write time it was recorded from; a later
	 *  frame that changes either belongs to another run and drops the entry. */
	status?: string;
	updatedAt?: number;
}

/** The push and list inputs `use-interface-live` collects for the snapshot. */
export interface InterfaceLiveInput {
	/** Pending approvals (Core-filtered), or undefined when not loaded. */
	approvals?: readonly ApprovalRequest[];
	/** Receipt time of the frame that first showed an id `awaiting_input`. */
	awaitingSince?: ReadonlyMap<string, number>;
	/** Receipt time of the first `running` frame of the CURRENT run per id. */
	firstSeenRunning: ReadonlyMap<string, number>;
	/** Polled subscription windows per agent: absent = never polled,
	 *  null = usage unknown. */
	limits?: ReadonlyMap<string, InterfaceAgentLimit | null>;
	privacy: "full" | "redacted";
	/** Latest run-stream row per conversation id. */
	runs: ReadonlyMap<string, RunFrameStatus>;
	terminalSeen: ReadonlyMap<string, TerminalSeen>;
	/** Unread message count per conversation id. */
	unread: ReadonlyMap<string, number>;
}

export interface BuildInterfaceSnapshotInput {
	/** The usage account, when the active interface shows it. */
	account?: InterfaceAccount;
	agents: readonly SnapshotAgentInput[];
	conversations: readonly Conversation[];
	/** Message-derived detail (1b) and live-tab entries (1c), when hydrated. */
	detail?: InterfaceDetailInput;
	/** Scheduled runs, when the active interface shows them. */
	events?: readonly InterfaceEvent[];
	/** Scheduled jobs behind `events`, for linking a run to its cron routine. */
	jobs?: readonly ScheduledJob[];
	/** Live run, approval, unread and privacy inputs. Without them the snapshot
	 *  carries list fields only, exactly as older hosts send it. */
	live?: InterfaceLiveInput;
	/** The host clock for this build (epoch ms). Required with `live`. */
	nowMs?: number;
	projects?: readonly SnapshotProjectInput[];
	teams: readonly SnapshotTeamInput[];
}

/**
 * Users talk to main threads and plain chats; archived threads and the
 * sessions the sidebar hides behind a main thread stay out. A standalone
 * conversation carries Core's default `session` role without a parent or a
 * project, and stays in, exactly as in the sidebar.
 */
function isInterfaceThread(conversation: Conversation): boolean {
	return !(conversation.archived || isHiddenSession(conversation));
}

/** How many threads the snapshot leaves out past {@link MAX_INTERFACE_THREADS}. */
export function omittedInterfaceThreads(
	conversations: readonly Conversation[]
): number {
	let count = 0;
	for (const conversation of conversations) {
		if (isInterfaceThread(conversation)) {
			count += 1;
		}
	}
	return Math.max(0, count - MAX_INTERFACE_THREADS);
}

/**
 * Ids of conversations with a running session somewhere beneath them. Sessions
 * are hidden behind their main thread, so (as in the sidebar) the main thread
 * carries their live state. Walks the whole spawn chain; cycles stop the walk.
 */
function runningAncestorIds(
	conversations: readonly Conversation[],
	statusOf: (conversation: Conversation) => string | undefined
): Set<string> {
	const parentOf = new Map<string, string>();
	for (const conversation of conversations) {
		const parent = conversation.hierarchy?.spawnedByConversationId;
		if (parent) {
			parentOf.set(conversation.id, parent);
		}
	}
	const ids = new Set<string>();
	for (const conversation of conversations) {
		if (statusOf(conversation) !== "running") {
			continue;
		}
		const seen = new Set([conversation.id]);
		let parent = parentOf.get(conversation.id);
		while (parent && !seen.has(parent)) {
			ids.add(parent);
			seen.add(parent);
			parent = parentOf.get(parent);
		}
	}
	return ids;
}

function activityMs(conversation: Conversation): number {
	const { lastMessageAt, updatedAt } = conversation;
	if (typeof lastMessageAt === "number" && Number.isFinite(lastMessageAt)) {
		return lastMessageAt;
	}
	return Number.isFinite(updatedAt) ? updatedAt : 0;
}

/** RFC 3339 UTC; an out-of-range timestamp sorts as the oldest thread. */
function toIso(ms: number): string {
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? EPOCH_ISO : date.toISOString();
}

function messageRole(role: string | undefined): "assistant" | "user" | null {
	return role === "assistant" || role === "user" ? role : null;
}

const RUN_STATES: readonly ThreadRunState[] = [
	"completed",
	"failed",
	"interrupted",
	"running",
];

/** Core's run status, narrowed to the protocol's known run states. */
function runState(value: string | undefined): ThreadRunState | null {
	return RUN_STATES.find((state) => state === value) ?? null;
}

const PATH_SEPARATOR = /[\\/]/;

function basename(path: string): string {
	const parts = path.split(PATH_SEPARATOR).filter(Boolean);
	return parts.at(-1) ?? "";
}

/**
 * The run status to show: a run-stream row overrides the list's value when it
 * was written at or after the list row. Both are epoch ms from the same
 * column, so they compare directly.
 */
export function overlayRunStatus(
	conversation: Conversation,
	runs: ReadonlyMap<string, RunFrameStatus> | undefined
): string | undefined {
	const run = runs?.get(conversation.id);
	if (run && run.updated_at >= conversation.updatedAt) {
		return run.run_status ?? conversation.runStatus;
	}
	return conversation.runStatus;
}

function toThread(
	conversation: Conversation,
	status: string | undefined
): InterfaceThread {
	const hierarchy = conversation.hierarchy;
	const ownerProjectId =
		hierarchy?.ownerKind === "project" ? hierarchy.ownerId : undefined;
	// A run paused for the user's answer cannot continue without them. The
	// protocol has no run state for it, so it reads as the agent having the
	// last word: `threadStatus()` then classifies it as the user's turn
	// instead of falling back to whoever happened to write last.
	const awaitingInput = status === "awaiting_input";
	const thread: InterfaceThread = {
		// The primary agent first, then the additional participants.
		agentIds: conversationParticipantIds(conversation),
		id: conversation.id,
		lastMessage: conversation.lastMessage?.trim() || null,
		lastMessageRole: awaitingInput
			? "assistant"
			: messageRole(conversation.lastMessageRole),
		messageCount: conversation.messageCount ?? conversation.messages.length,
		pinned: conversation.pinned === true,
		projectId: hierarchy?.projectId || ownerProjectId || null,
		running: status === "running",
		runState: runState(status),
		teamId:
			hierarchy?.ownerKind === "group" && hierarchy.ownerId
				? hierarchy.ownerId
				: null,
		title: conversation.title.trim() || "New chat",
		updatedAt: toIso(activityMs(conversation)),
	};
	if (
		typeof conversation.lastMessageAt === "number" &&
		Number.isFinite(conversation.lastMessageAt)
	) {
		thread.lastMessageAt = toIso(conversation.lastMessageAt);
	}
	const folder = conversation.folderPath
		? basename(conversation.folderPath)
		: "";
	// "<folder>@<branch>" only; a folder without a branch gives no workspace.
	if (folder && conversation.branch) {
		thread.workspace = `${folder}@${conversation.branch}`;
	}
	return thread;
}

/** Spawned sessions per parent main thread, with the run-overlaid status. */
function helperRollup(
	conversations: readonly Conversation[],
	statusOf: (conversation: Conversation) => string | undefined
): Map<string, InterfaceHelpers> {
	const children = new Map<string, Conversation[]>();
	for (const conversation of conversations) {
		const parent = conversation.hierarchy?.spawnedByConversationId;
		if (conversation.hierarchy?.role === "session" && parent) {
			const list = children.get(parent) ?? [];
			list.push(conversation);
			children.set(parent, list);
		}
	}
	const rollup = new Map<string, InterfaceHelpers>();
	for (const [parent, sessions] of children) {
		const helpers: InterfaceHelpers = {
			done: 0,
			failed: 0,
			running: 0,
			titles: [],
		};
		const running: Conversation[] = [];
		for (const session of sessions) {
			const status = statusOf(session);
			if (status === "running") {
				helpers.running += 1;
				running.push(session);
			} else if (status === "failed") {
				helpers.failed += 1;
			} else if (status === "completed") {
				helpers.done += 1;
			}
		}
		helpers.titles = running
			.sort((a, b) => activityMs(b) - activityMs(a) || a.id.localeCompare(b.id))
			.slice(0, 3)
			.map((session) => session.title.trim() || "Helper");
		rollup.set(parent, helpers);
	}
	return rollup;
}

function projectGroups(
	projects: readonly SnapshotProjectInput[],
	threads: readonly InterfaceThread[]
): InterfaceGroup[] {
	const members = new Map<string, Set<string>>();
	for (const thread of threads) {
		if (!thread.projectId) {
			continue;
		}
		const set = members.get(thread.projectId) ?? new Set<string>();
		for (const agentId of thread.agentIds) {
			set.add(agentId);
		}
		members.set(thread.projectId, set);
	}
	return projects.map((project) => ({
		id: project.id,
		kind: "project",
		memberAgentIds: [...(members.get(project.id) ?? [])],
		name: project.name,
	}));
}

/**
 * The projects an interface groups threads under. Threads carry the node's
 * project ids, so a desktop folder project is published under the node
 * project it was migrated to (`folderProjectMap`, per node), and node projects
 * known only from their coordinator main thread are added after the folder
 * projects. Each id appears once.
 */
export function resolveSnapshotProjects({
	conversations,
	folderProjectMap = {},
	workspaceProjects,
}: {
	conversations: readonly Conversation[];
	folderProjectMap?: Readonly<Record<string, string>>;
	workspaceProjects: readonly SnapshotProjectInput[];
}): SnapshotProjectInput[] {
	const projects = new Map<string, SnapshotProjectInput>();
	for (const project of workspaceProjects) {
		const id = folderProjectMap[project.id] || project.id;
		if (!projects.has(id)) {
			projects.set(id, { id, name: project.name });
		}
	}
	for (const conversation of conversations) {
		const id = conversation.hierarchy?.ownerId;
		if (
			id &&
			!conversation.archived &&
			isProjectMainThread(conversation) &&
			!projects.has(id)
		) {
			projects.set(id, { id, name: conversation.title.trim() || "Project" });
		}
	}
	return [...projects.values()];
}

// ── Approvals ─────────────────────────────────────────────────────────────

const ASK_TEXT_MAX = 80;
const ASK_REASON_MAX = 160;
const TARGET_MAX = 40;
const WHITESPACE = /\s+/;
const WHITESPACE_RUNS = /\s+/g;

/** Control characters and backticks become spaces, so a target never carries
 *  terminal escapes or markdown into a bubble. */
function stripControl(value: string): string {
	let out = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f || char === "`" ? " " : char;
	}
	return out;
}

function clamp(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function sanitizeTarget(value: string): string | null {
	const clean = stripControl(value).trim();
	return clean ? clamp(clean.replace(WHITESPACE_RUNS, " "), TARGET_MAX) : null;
}

function urlHost(value: string): string | null {
	try {
		return new URL(value).host || null;
	} catch {
		return null;
	}
}

/**
 * A bounded, sanitised target for a gated tool call, from its arguments: the
 * first two tokens of `command` / `cmd`, the basename of `file_path` / `path` /
 * `notebook_path`, or the host of `url`. Nothing else from the arguments is
 * ever copied. Null for any other shape.
 */
export function approvalTarget(args: unknown): string | null {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return null;
	}
	const record = args as Record<string, unknown>;
	for (const key of ["command", "cmd"]) {
		const value = record[key];
		if (typeof value === "string") {
			const head = stripControl(value)
				.trim()
				.split(WHITESPACE)
				.slice(0, 2)
				.join(" ");
			return sanitizeTarget(head);
		}
	}
	for (const key of ["file_path", "path", "notebook_path"]) {
		const value = record[key];
		if (typeof value === "string") {
			return sanitizeTarget(basename(value));
		}
	}
	const url = record.url;
	if (typeof url === "string") {
		const host = urlHost(url);
		return host ? sanitizeTarget(host) : null;
	}
	return null;
}

/** Where an approval's thread lands in the snapshot. */
export interface ApprovalThreadIndex {
	/** Session conversation id → its parent main thread id. */
	sessionParents: ReadonlyMap<string, string>;
	/** Ids of the snapshot's threads. */
	threadIds: ReadonlySet<string>;
}

const BLOCKING_APPROVALS: ReadonlySet<string> = new Set([
	"tool_call",
	"workflow_gate",
	"scheduled_run",
	"trigger_run",
]);

function stringField(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

/**
 * An approval's action as loose fields. Core's action is a union keyed on
 * `type`; the ask mapping only reads the optional fields some variants carry
 * (`host_conversation_id`, `conversation_id`, `agent_id`, `arguments`).
 */
export function approvalActionFields(
	approval: Pick<ApprovalRequest, "action">
): Readonly<Record<string, unknown>> | null {
	return approval.action ?? null;
}

function isoOrNull(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? toIso(ms) : null;
}

/** A pending Core approval as an interface ask (spec §3.2 mapping table). */
export function approvalToAsk(
	approval: ApprovalRequest,
	index: ApprovalThreadIndex
): InterfaceAsk {
	const action = approvalActionFields(approval);
	const toolCall = approval.kind === "tool_call";
	const rawThread =
		approval.conversation_id ??
		stringField(action?.host_conversation_id) ??
		stringField(action?.conversation_id);
	let threadId: string | null = null;
	if (rawThread && index.threadIds.has(rawThread)) {
		threadId = rawThread;
	} else if (rawThread) {
		const parent = index.sessionParents.get(rawThread);
		threadId = parent && index.threadIds.has(parent) ? parent : null;
	}
	const ask: InterfaceAsk = {
		agentId: approval.agent_id ?? stringField(action?.agent_id) ?? null,
		blocking: BLOCKING_APPROVALS.has(approval.kind),
		choices: [
			{
				destructive: toolCall,
				id: "approve",
				label: "Approve",
				tone: "allow",
			},
			{ destructive: false, id: "reject", label: "Reject", tone: "deny" },
		],
		holdsRun: approval.kind === "workflow_gate",
		id: `approval:${approval.id}`,
		kind: "approval",
		reason: approval.summary ? clamp(approval.summary, ASK_REASON_MAX) : null,
		riskTags: [...approval.risk_tags],
		since: isoOrNull(approval.created_at),
		source: "approvals",
		subject: approval.kind,
		target: toolCall ? approvalTarget(action?.arguments) : null,
		text: clamp(
			approval.question || approval.title || "Approval",
			ASK_TEXT_MAX
		),
		threadId,
	};
	const expiresAt = isoOrNull(approval.expires_at);
	if (expiresAt) {
		ask.expiresAt = expiresAt;
	}
	return ask;
}

// ── Routines ──────────────────────────────────────────────────────────────

/** Core fires cron jobs within the matching minute on a 30 s tick. */
const ROUTINE_START_GATE_MS = 90_000;

/**
 * The cron routine whose firing started this run, or null. Set only when the
 * thread runs, is the `target.conversationId` of exactly one enabled agent job,
 * that job is cron (never interval), needs no approval, and fired at F with
 * `0 ≤ S − F ≤ 90 s` where S is the thread's runStartedAt.
 */
export function routineRunFor(
	thread: Pick<InterfaceThread, "id" | "running" | "runStartedAt">,
	jobs: readonly ScheduledJob[] | undefined
): { firedAt: string; jobId: string } | null {
	const start = thread.runStartedAt
		? Date.parse(thread.runStartedAt)
		: Number.NaN;
	if (!(thread.running && Number.isFinite(start) && jobs)) {
		return null;
	}
	const owners = jobs.filter(
		(job) =>
			job.enabled &&
			job.target.type === "agent" &&
			job.target.conversationId === thread.id
	);
	const job = owners.length === 1 ? owners[0] : undefined;
	if (job?.schedule.kind !== "cron" || job.requireApproval) {
		return null;
	}
	const fires = cronFireTimes(
		job,
		new Date(start - ROUTINE_START_GATE_MS),
		new Date(start)
	).filter((fire) => fire.getTime() <= start);
	const fired = fires.at(-1);
	return fired ? { firedAt: toIso(fired.getTime()), jobId: job.id } : null;
}

/**
 * Fill the thread of a failed per-firing run: Core records no run id for it,
 * but its `agentrun_*` conversation exists. Linked only when exactly one
 * conversation matches the agent, the routine name and a creation time inside
 * the run.
 */
export function linkOrphanRuns(
	events: readonly InterfaceEvent[],
	conversations: readonly Conversation[]
): InterfaceEvent[] {
	return events.map((event) => {
		const start = Date.parse(event.start);
		const end = event.end ? Date.parse(event.end) : Number.NaN;
		if (
			event.kind !== "past" ||
			event.outcome !== "failure" ||
			event.threadId ||
			!event.agentId ||
			!(Number.isFinite(start) && Number.isFinite(end))
		) {
			return event;
		}
		const matches = conversations.filter(
			(conversation) =>
				conversation.id.startsWith("agentrun_") &&
				conversationParticipantIds(conversation).includes(
					event.agentId ?? ""
				) &&
				conversation.title.trim() === event.title &&
				conversation.createdAt >= start &&
				conversation.createdAt <= end
		);
		return matches.length === 1 && matches[0]
			? { ...event, threadId: matches[0].id }
			: event;
	});
}

/** Each job's newest past run that failed and belongs to a snapshot thread. */
function scheduleBlockers(
	events: readonly InterfaceEvent[]
): Map<string, InterfaceBlocker> {
	const newest = new Map<string, InterfaceEvent>();
	for (const event of events) {
		if (event.kind !== "past" || !event.jobId) {
			continue;
		}
		const current = newest.get(event.jobId);
		if (!current || event.start > current.start) {
			newest.set(event.jobId, event);
		}
	}
	const blockers = new Map<string, InterfaceBlocker>();
	for (const event of newest.values()) {
		if (event.outcome !== "failure" || !event.threadId) {
			continue;
		}
		const blocker: InterfaceBlocker = {
			at: event.end ?? null,
			detail: event.error ?? null,
			kind: "schedule-failed",
			source: "schedule",
			title: clamp(`${event.title} failed`, 40),
		};
		const existing = blockers.get(event.threadId);
		if (!existing || (blocker.at ?? "") > (existing.at ?? "")) {
			blockers.set(event.threadId, blocker);
		}
	}
	return blockers;
}

// ── Live detail ───────────────────────────────────────────────────────────

/** The 1a summary blocker from the run state alone. Never uses updatedAt. */
function summaryBlocker(
	thread: InterfaceThread,
	terminal: TerminalSeen | undefined
): InterfaceBlocker | null {
	if (thread.runState === "interrupted") {
		return terminal
			? {
					at: toIso(terminal.atMs),
					atApprox: true,
					kind: "interrupted",
					source: "run-stream",
					title: "Interrupted",
				}
			: {
					at: null,
					kind: "interrupted",
					source: "run-stream",
					title: "Interrupted",
				};
	}
	if (thread.runState === "failed") {
		return {
			at: thread.runEndedAt ?? null,
			kind: "error",
			source: "run-stream",
			title: "Run failed",
		};
	}
	return null;
}

function replyAsk(thread: InterfaceThread): InterfaceAsk | null {
	if (
		thread.lastMessageRole !== "assistant" ||
		thread.running ||
		thread.awaitingInput ||
		thread.runState === "failed" ||
		(thread.unread ?? 0) <= 0
	) {
		return null;
	}
	const text =
		thread.outcome?.headline ||
		(thread.lastMessage ? shortLine(thread.lastMessage, 12) : "") ||
		"Answer ready";
	const exact = thread.runEndedAt ?? null;
	return {
		agentId: thread.agentIds[0] ?? null,
		blocking: false,
		holdsRun: false,
		id: `reply:${thread.id}`,
		kind: "reply",
		since: exact ?? thread.lastMessageAt ?? null,
		sinceApprox: exact === null,
		source: "messages",
		text: clamp(text, ASK_TEXT_MAX),
		threadId: thread.id,
	};
}

function inputAsk(
	thread: InterfaceThread,
	since: number | undefined
): InterfaceAsk | null {
	if (!thread.awaitingInput) {
		return null;
	}
	const meta = conversationRunStatusMeta("awaiting_input");
	return {
		agentId: thread.agentIds[0] ?? null,
		blocking: true,
		holdsRun: true,
		id: `input:${thread.id}`,
		kind: "input",
		reason: meta?.description ?? null,
		since: since === undefined ? null : toIso(since),
		sinceApprox: true,
		source: "run-stream",
		text: meta?.label ?? "Needs input",
		threadId: thread.id,
	};
}

/** 1a reads no message parts, so it sees no questions at all. */
export const ASK_BLIND_SPOTS_1A: readonly InterfaceAskKind[] = [
	"permission",
	"input",
	"question",
];

function applyLive(
	thread: InterfaceThread,
	status: string | undefined,
	live: InterfaceLiveInput
): InterfaceThread {
	const firstSeen = live.firstSeenRunning.get(thread.id);
	const terminal = live.terminalSeen.get(thread.id);
	const next: InterfaceThread = {
		...thread,
		detail: "summary",
		unread: live.unread.get(thread.id) ?? 0,
	};
	if (status === "awaiting_input") {
		next.awaitingInput = true;
	}
	if (thread.running && status === "running" && firstSeen !== undefined) {
		next.runStartedAt = toIso(firstSeen);
		next.runStartedApprox = true;
	}
	next.runEndedAt =
		terminal &&
		!terminal.approx &&
		(status === "completed" || status === "failed")
			? toIso(terminal.atMs)
			: null;
	// A parent kept live by a running helper is working, not stopped.
	const blocker = next.running ? null : summaryBlocker(next, terminal);
	if (blocker) {
		next.blocker = blocker;
	}
	return next;
}

// ── Phase 1b: limits, run starts, message detail ─────────────────────────

const NON_ALNUM = /[^a-z0-9]/g;

/** Port of Core's `models_match`: lowercase ASCII alphanumerics, false when
 *  either is empty, else true when either contains the other. */
export function modelsMatch(
	scoped: string | null | undefined,
	model: string | null | undefined
): boolean {
	const a = (scoped ?? "").toLowerCase().replace(NON_ALNUM, "");
	const b = (model ?? "").toLowerCase().replace(NON_ALNUM, "");
	if (!(a && b)) {
		return false;
	}
	return a.includes(b) || b.includes(a);
}

function windowLabel(window: UsageSnapshot["windows"][number]): string {
	return window.model && window.model !== window.label
		? `${window.label} (${window.model})`
		: window.label;
}

/**
 * An agent's limit from its usage snapshot (spec §3.2 `agent.limit`): blocked
 * by an at-100% window that is account-wide or names the agent's model;
 * unknown (null) when the probe failed or a per-model window at 100% cannot be
 * matched to an agent with no model; otherwise the highest-used relevant
 * window. `retry_after_seconds` only means the probe was throttled.
 */
export function chooseAgentLimit(
	usage: UsageSnapshot | null,
	agentModel: string | null
): InterfaceAgentLimit | null {
	if (!usage?.available || usage.reason) {
		return null;
	}
	const relevant = usage.windows.filter(
		(window) => window.model === null || modelsMatch(window.model, agentModel)
	);
	const toLimit = (
		window: UsageSnapshot["windows"][number],
		blocked: boolean
	): InterfaceAgentLimit => ({
		blocked,
		label: windowLabel(window),
		model: window.model,
		resetsAt: window.resetsAt,
		usedPercent: window.usedPercent,
		windowSeconds: window.windowSeconds,
	});
	const full = relevant
		.filter((window) => window.usedPercent >= 100)
		.sort(
			(a, b) =>
				(a.resetsAt ?? "\uffff").localeCompare(b.resetsAt ?? "\uffff") ||
				a.label.localeCompare(b.label)
		);
	if (full[0]) {
		return toLimit(full[0], true);
	}
	const unmatched = usage.windows.some(
		(window) => window.usedPercent >= 100 && window.model !== null
	);
	if (unmatched && !agentModel) {
		return null;
	}
	const highest = [...relevant].sort(
		(a, b) => b.usedPercent - a.usedPercent
	)[0];
	return highest ? toLimit(highest, false) : null;
}

/** A user-message start can predate first sighting by this much and still
 *  belong to this run (clock skew, the first frame's delay). */
const RUN_START_SLACK_MS = 5000;

/**
 * The start of the current run: the last user message's time counts as exact
 * only when it is not older than the first sighting (less 5 s), or no
 * assistant message follows it. Otherwise (a retry re-claiming the run, an
 * agent-to-agent turn) the first sighting stays, approximate.
 */
export function resolveRunStart(
	detailStart: number | null,
	firstSeenMs: number | null,
	hasLaterAssistant: boolean
): { approx: boolean; startMs: number } | null {
	if (detailStart !== null) {
		const fresh =
			firstSeenMs !== null && detailStart >= firstSeenMs - RUN_START_SLACK_MS;
		if (fresh || !hasLaterAssistant) {
			return { approx: false, startMs: detailStart };
		}
	}
	return firstSeenMs === null ? null : { approx: true, startMs: firstSeenMs };
}

/** The derived detail of a conversation the store has read (a newer read may
 *  be in flight; the last good one still describes the thread). */
function detailOf(
	detail: InterfaceDetailInput | undefined,
	id: string
): ThreadDetail | null {
	return detail?.entries.get(id)?.detail ?? null;
}

function applyDetail(
	thread: InterfaceThread,
	status: string | undefined,
	live: InterfaceLiveInput,
	detail: InterfaceDetailInput | undefined
): InterfaceThread {
	const entry = detailOf(detail, thread.id);
	const tab = detail?.live.get(thread.id);
	if (!(entry || tab)) {
		return thread;
	}
	const next: InterfaceThread = { ...thread };
	if (entry) {
		next.detail = "detail";
		next.progress = entry.progress ?? next.progress ?? null;
	}
	// Its own run (or an open tab's live turn), not one lifted from a helper:
	// a main kept live only by a helper has no start and no progress of its
	// own, so it is never judged stalled on its previous turn.
	const ownRunning = status === "running" || tab?.running === true;
	if (thread.running && !ownRunning) {
		next.activity = tab?.activity ?? null;
		next.outcome = null;
	} else if (thread.running) {
		const firstSeen = live.firstSeenRunning.get(thread.id) ?? null;
		const start =
			typeof tab?.startedAtMs === "number"
				? { approx: false, startMs: tab.startedAtMs }
				: resolveRunStart(
						entry?.userStart ?? null,
						firstSeen,
						entry?.hasLaterAssistant ?? false
					);
		if (start) {
			next.runStartedAt = toIso(start.startMs);
			next.runStartedApprox = start.approx;
		}
		next.activity = tab?.activity ?? entry?.activity ?? null;
		if (entry || tab?.lastProgressAt) {
			// Floored by this run's start: a retried or agent-to-agent run must not
			// read as stalled from the previous turn's last step.
			const start = next.runStartedAt ? Date.parse(next.runStartedAt) : null;
			const saved = entry
				? resolveLastProgress(entry.progressMarks, start)
				: null;
			next.lastProgressAt =
				tab?.lastProgressAt ??
				(saved === null ? null : toIso(saved)) ??
				next.runStartedAt ??
				null;
		}
		next.outcome = null;
	} else if (entry) {
		next.outcome = entry.outcome
			? { ...entry.outcome, finishedAt: thread.runEndedAt ?? null }
			: null;
		// A saved reason replaces the summary blocker of a run that stopped.
		const stopped =
			thread.runState === "failed" || thread.runState === "interrupted";
		if (stopped && entry.blocker) {
			next.blocker = entry.blocker;
		}
	}
	if (tab?.blocker) {
		next.blocker = tab.blocker;
	}
	return next;
}

/** Open Question asks from every hydrated conversation (mains and helper
 *  sessions), lifted to snapshot threads; blocking ones only while the
 *  holding conversation runs and before their upper-bound deadline. */
function questionAsks(
	conversations: readonly Conversation[],
	statusOf: (conversation: Conversation) => string | undefined,
	detail: InterfaceDetailInput,
	threadIds: ReadonlySet<string>,
	nowMs: number
): InterfaceAsk[] {
	const asks: InterfaceAsk[] = [];
	for (const conversation of conversations) {
		const entry = detailOf(detail, conversation.id);
		if (!entry) {
			continue;
		}
		const running = statusOf(conversation) === "running";
		for (const { ask } of entry.questionAsks) {
			if (!(ask.threadId && threadIds.has(ask.threadId))) {
				continue;
			}
			if (ask.blocking) {
				const expires = ask.expiresAt ? Date.parse(ask.expiresAt) : Number.NaN;
				if (!running || (Number.isFinite(expires) && nowMs > expires)) {
					continue;
				}
			}
			asks.push(ask);
		}
	}
	return asks;
}

/** Live-tab permission asks, while their thread runs and before expiry. */
function permissionAsks(
	threads: readonly InterfaceThread[],
	ownRunning: ReadonlySet<string>,
	detail: InterfaceDetailInput,
	nowMs: number
): InterfaceAsk[] {
	const asks: InterfaceAsk[] = [];
	for (const thread of threads) {
		const ask = detail.live.get(thread.id)?.permission?.ask;
		// The thread's own run, not one lifted from a helper, holds the prompt.
		if (!(ask && ownRunning.has(thread.id))) {
			continue;
		}
		const expires = ask.expiresAt ? Date.parse(ask.expiresAt) : Number.NaN;
		if (Number.isFinite(expires) && nowMs > expires) {
			continue;
		}
		asks.push(ask);
	}
	return asks;
}

/** "question" leaves the blind spots only when every running main and helper
 *  session is hydrated at its current revision within the cap, and the idle
 *  sweep has read every thread updated in the last 7 days. */
function questionCovered(
	conversations: readonly Conversation[],
	statusOf: (conversation: Conversation) => string | undefined,
	detail: InterfaceDetailInput
): boolean {
	if (!(detail.runningWithinCap && detail.sweepComplete)) {
		return false;
	}
	const runningParents = new Set<string>();
	for (const conversation of conversations) {
		const parent = conversation.hierarchy?.spawnedByConversationId;
		if (parent && statusOf(conversation) === "running") {
			runningParents.add(parent);
		}
	}
	return conversations
		.filter(
			(conversation) =>
				!conversation.archived &&
				(statusOf(conversation) === "running" ||
					runningParents.has(conversation.id))
		)
		.every((conversation) => {
			const entry = detail.entries.get(conversation.id);
			return (
				entry?.status === "ready" &&
				entry.revision ===
					interfaceDetailRevision({
						messageCount:
							conversation.messageCount ?? conversation.messages.length,
						runStatus: statusOf(conversation),
						updatedAt: conversation.updatedAt,
					})
			);
		});
}

/**
 * The limit-precedence rule (observable conditions only): with the agent's
 * window at 100% now, the focus thread's saved generic error becomes a likely
 * limit when it happened inside the window; a focus thread with no blocker
 * gets the limit itself as its blocker.
 */
function applyLimitPrecedence(
	snapshot: InterfaceSnapshot,
	nowMs: number
): InterfaceSnapshot {
	const acts = agentActs(snapshot, nowMs);
	const updates = new Map<string, InterfaceBlocker>();
	for (const agent of snapshot.agents) {
		const limit = agent.limit;
		const focus = acts.get(agent.id)?.threadId;
		const thread = focus
			? snapshot.threads.find((item) => item.id === focus)
			: undefined;
		if (!(limit?.blocked && thread) || thread.running) {
			continue;
		}
		const blocker = thread.blocker;
		if (!blocker) {
			updates.set(thread.id, {
				at: null,
				clearsAt: limit.resetsAt,
				kind: "rate-limited",
				source: "usage",
				title: "Limit hit",
			});
			continue;
		}
		const at = blocker.at ? Date.parse(blocker.at) : Number.NaN;
		const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
		const windowMs = (limit.windowSeconds ?? Number.NaN) * 1000;
		const savedGeneric =
			blocker.kind === "error" && blocker.source === "messages";
		if (
			savedGeneric &&
			Number.isFinite(at) &&
			Number.isFinite(resets) &&
			Number.isFinite(windowMs) &&
			at >= resets - windowMs &&
			at <= nowMs
		) {
			updates.set(thread.id, {
				at: blocker.at,
				atApprox: true,
				clearsAt: limit.resetsAt,
				detail: blocker.detail ?? blocker.title,
				kind: "rate-limited",
				source: "estimate",
				title: "Limit hit",
			});
		}
	}
	if (updates.size === 0) {
		return snapshot;
	}
	return {
		...snapshot,
		threads: snapshot.threads.map((thread) => {
			const blocker = updates.get(thread.id);
			return blocker ? { ...thread, blocker } : thread;
		}),
	};
}

/**
 * Project the desktop's chat state into an {@link InterfaceSnapshot}. Pure and
 * deterministic: threads are ordered newest first (id as tiebreaker) and capped
 * at {@link MAX_INTERFACE_THREADS}. With `live`, it adds the useful-state
 * fields (spec §3.2) and redacts last when privacy is "redacted".
 */
export function buildInterfaceSnapshot({
	account,
	agents,
	conversations,
	detail,
	events,
	jobs,
	live,
	nowMs,
	projects = [],
	teams,
}: BuildInterfaceSnapshotInput): InterfaceSnapshot {
	const statusOf = (conversation: Conversation) =>
		overlayRunStatus(conversation, live?.runs);
	// Helpers roll up before sessions are filtered out.
	const helpers = helperRollup(conversations, statusOf);
	// Sessions anywhere down the spawn chain keep their main thread live.
	const runningAncestors = runningAncestorIds(conversations, statusOf);
	let threads = conversations
		.filter(isInterfaceThread)
		.map((conversation) => {
			const status = statusOf(conversation);
			let thread = toThread(conversation, status);
			const rollup = helpers.get(conversation.id);
			// A running helper (or a session further down its spawn chain) keeps
			// its parent live, as the sidebar shows it.
			const lifted = !thread.running && runningAncestors.has(conversation.id);
			if (rollup || lifted) {
				thread = {
					...thread,
					...(rollup ? { helpers: rollup } : {}),
					running: thread.running || lifted,
					// While a helper runs, the thread's state is "running", so its
					// status, sentence and blockers agree with the lift.
					runState: lifted ? "running" : thread.runState,
				};
			}
			return live
				? applyDetail(applyLive(thread, status, live), status, live, detail)
				: thread;
		})
		.sort(
			(a, b) =>
				b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
		)
		.slice(0, MAX_INTERFACE_THREADS);
	const threadIds = new Set(threads.map((thread) => thread.id));

	// Routines: link orphans, keep only snapshot threads, then derive blockers.
	const linkedEvents = events
		? linkOrphanRuns(events, conversations).map((event) =>
				event.threadId && !threadIds.has(event.threadId)
					? { ...event, threadId: null }
					: event
			)
		: undefined;
	if (live) {
		const routineFailures = scheduleBlockers(linkedEvents ?? []);
		const clock = nowMs ?? Date.now();
		threads = threads.map((thread) => {
			let next = thread;
			const failure = routineFailures.get(thread.id);
			const summary =
				!next.blocker ||
				(next.blocker.kind === "error" && next.blocker.source === "run-stream");
			if (failure && summary) {
				next = { ...next, blocker: failure };
			}
			const routineRun = routineRunFor(next, jobs);
			if (routineRun) {
				next = { ...next, routineRun };
				const progress = estimateProgress(next, clock, linkedEvents);
				if (progress && !next.progress) {
					next = { ...next, progress };
				}
			}
			return next;
		});
	}

	const workingAgentIds = new Set<string>();
	for (const thread of threads) {
		if (thread.running) {
			for (const agentId of thread.agentIds) {
				workingAgentIds.add(agentId);
			}
		}
	}

	const interfaceAgents: InterfaceAgent[] = agents.map((agent) => {
		const projected: InterfaceAgent = {
			avatarUrl: agent.avatarUrl,
			description: agent.description ?? "",
			id: agent.id,
			name: agent.name,
			status: workingAgentIds.has(agent.id) ? "working" : "idle",
		};
		if (live) {
			projected.model = agent.model ?? null;
			if (live.limits?.has(agent.id)) {
				projected.limit = live.limits.get(agent.id) ?? null;
			}
		}
		return projected;
	});

	const teamGroups: InterfaceGroup[] = teams.map((team) => ({
		id: team.id,
		kind: "team",
		memberAgentIds: [...team.members],
		name: team.name,
	}));

	const snapshot: InterfaceSnapshot = {
		...(account ? { account } : {}),
		agents: interfaceAgents,
		...(linkedEvents ? { events: linkedEvents } : {}),
		groups: [...teamGroups, ...projectGroups(projects, threads)],
		threads,
		version: INTERFACE_PROTOCOL_VERSION,
	};
	if (!live) {
		return snapshot;
	}
	const clock = nowMs ?? Date.now();
	const sessionParents = new Map<string, string>();
	for (const conversation of conversations) {
		const parent = conversation.hierarchy?.spawnedByConversationId;
		if (conversation.hierarchy?.role === "session" && parent) {
			sessionParents.set(conversation.id, parent);
		}
	}
	const asks: InterfaceAsk[] = [];
	for (const approval of live.approvals ?? []) {
		if (approval.status === "pending") {
			asks.push(approvalToAsk(approval, { sessionParents, threadIds }));
		}
	}
	if (detail) {
		asks.push(
			...questionAsks(conversations, statusOf, detail, threadIds, clock),
			...permissionAsks(
				threads,
				new Set(
					conversations
						.filter((conversation) => statusOf(conversation) === "running")
						.map((conversation) => conversation.id)
				),
				detail,
				clock
			)
		);
	}
	for (const thread of threads) {
		const input = inputAsk(thread, live.awaitingSince?.get(thread.id));
		if (input) {
			asks.push(input);
		}
		const reply = replyAsk(thread);
		if (reply) {
			asks.push(reply);
		}
	}
	snapshot.asks = asks.sort(compareAsks);
	snapshot.askBlindSpots =
		detail && questionCovered(conversations, statusOf, detail)
			? ASK_BLIND_SPOTS_1A.filter((kind) => kind !== "question")
			: [...ASK_BLIND_SPOTS_1A];
	snapshot.observedAt = toIso(clock);
	snapshot.privacy = live.privacy;
	const limited = applyLimitPrecedence(snapshot, clock);
	// Focus threads use the same priority the scenes act on.
	const acts = agentActs(limited, clock);
	limited.agents = limited.agents.map((agent) => ({
		...agent,
		focusThreadId: acts.get(agent.id)?.threadId ?? null,
	}));
	return live.privacy === "redacted" ? redactSnapshot(limited) : limited;
}
