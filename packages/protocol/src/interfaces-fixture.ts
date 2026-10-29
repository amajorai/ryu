/**
 * The canonical "useful state" snapshot (spec docs/interfaces-useful-state.md
 * §7.1). Every game test, the story harness and the screenshots render this
 * one fixture, so the expected acts, sentences and counts are shared.
 *
 * All times are realistic epoch ms relative to `nowMs`. The snapshot never
 * carries approval arguments: Ada's gated call only shows its derived target.
 */
import {
	type ClockOptions,
	estimateProgress,
	INTERFACE_PROTOCOL_VERSION,
	type InterfaceAgent,
	type InterfaceAsk,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	redactSnapshot,
} from "./interfaces.ts";

/** Default fixture clock: Friday 16 Oct 2026, 10:00 UTC. */
export const FIXTURE_NOW_MS = Date.parse("2026-10-16T10:00:00Z");

/** Clock formatting pinned for tests and the story harness. */
export const FIXTURE_CLOCK: ClockOptions = { locale: "en-GB", timeZone: "UTC" };

/** Agent ids, in fixture order. */
export const FIXTURE_AGENT_IDS = {
	ada: "ada",
	bo: "bo",
	cy: "cy",
	di: "di",
	ed: "ed",
	fa: "fa",
	gu: "gu",
	ha: "ha",
	io: "io",
	ju: "ju",
} as const;

export const FIXTURE_THREAD_IDS = {
	ada: "t-ada",
	bo: "t-bo",
	cy: "t-cy",
	di: "t-di",
	diNightly: "t-di-nightly",
	ed: "t-ed",
	fa: "t-fa",
	gu: "t-gu",
	ha: "t-ha",
	haDigest: "agentrun_ha1",
	io: "t-io",
	ju: "t-ju",
} as const;

export const FIXTURE_ASK_IDS = {
	adaPermission: "permission:req-1",
	adaToolCall: "approval:ada-shell",
	boQuestion: "question:call-bo-db",
	guReply: `reply:${FIXTURE_THREAD_IDS.gu}`,
	haHeal: "approval:heal-digest",
	juReply: `reply:${FIXTURE_THREAD_IDS.ju}`,
	workflowGate: "approval:wf-deploy",
} as const;

export const FIXTURE_JOB_IDS = {
	cyStandup: "job-standup",
	diNightly: "job-nightly",
	haDigest: "job-digest",
	ioLogin: "job-login",
	ioSweep: "job-sweep",
} as const;

/** The value Ada's gated call carries in its arguments; it must never reach a snapshot. */
export const FIXTURE_ARGUMENT_SECRET = "fixture-secret";

/**
 * Every piece of user content in the fixture: message text, titles, ask
 * text / reasons / targets, routine names and errors, group names, agent
 * descriptions, ledger labels, outcome / progress / activity text and helper
 * titles. A redacted snapshot contains none of these anywhere.
 */
export const FIXTURE_PRIVATE_STRINGS: readonly string[] = [
	// thread titles
	"Deploy the site",
	"Choose a database",
	"Refactor snapshot",
	"Fix flaky tests",
	"Nightly backup",
	"Resume the migration",
	"Plan the launch",
	"Update the configs",
	"Answer the review",
	"Daily digest",
	"Fix login flow",
	"Weekly report",
	// last messages
	"I queued the deploy for your approval.",
	"Which database should the new service use?",
	"Splitting the snapshot builder into smaller pieces.",
	"The suite still fails in snapshot.test.ts.",
	"Backup target is full",
	"Picking up the schema migration where it stopped.",
	"The launch plan is drafted.",
	"I updated the three config files and their tests.",
	"Replied to every review comment.",
	"Digest source returned an error",
	"Checking the login redirect.",
	"Here is the weekly report summary you asked for.",
	// asks
	"Can I run `shell.run` now?",
	"Can I run shell.run now?",
	"Ada wants to run the deploy script.",
	"deploy.sh",
	"Which DB to use?",
	"Pick the database for the new service.",
	"Workflow gate: Deploy",
	"The deploy workflow is waiting at its approval gate.",
	"Apply the fix for Daily digest?",
	"Diagnosis: the digest source moved.",
	"Local file",
	"Server",
	"Allow Edit deploy.sh?",
	// activity, progress, outcome, helpers, workspace
	"Editing snapshot.ts",
	"snapshot.ts",
	"update snapshot builder",
	"write tests",
	"Check types",
	"Scan callers",
	"Edited 3 files",
	"Three config files now point at the new host.",
	"Ran the test suite",
	"Tests failed",
	"`bun test` failed",
	"Nightly backup failed",
	"Daily digest failed",
	"ryu@main",
	// routines, groups, descriptions, ledger
	"Login check",
	"Sweep stale branches",
	"Morning standup",
	"Core crew",
	"Marketing site",
	"Ships releases",
	"Designs data models",
	"Refactors the desktop host",
	"Keeps the test suite green",
	"Runs migrations",
	"Answers product questions",
	"Maintains configs",
	"Writes digests and reviews",
	"Watches the login flow",
	"Writes reports",
	"Asking which DB to use",
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface UsefulStateFixtureOptions {
	/** Keep only these agent ids, with their threads, asks and events. */
	agents?: readonly string[];
	/** Ada's thread runs and carries a live-tab permission ask. */
	livePermission?: boolean;
	nowMs?: number;
	privacy?: "full" | "redacted";
}

function baseThread(
	overrides: Partial<InterfaceThread> & {
		agentIds: string[];
		id: string;
		title: string;
		updatedAt: string;
	}
): InterfaceThread {
	return {
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 6,
		pinned: false,
		projectId: null,
		running: false,
		runState: "completed",
		teamId: null,
		unread: 0,
		...overrides,
	};
}

function agent(
	id: string,
	name: string,
	description: string,
	extra: Partial<InterfaceAgent> = {}
): InterfaceAgent {
	return {
		avatarUrl: null,
		description,
		id,
		model: "large-1",
		name,
		status: "idle",
		...extra,
	};
}

function approveReject(destructiveApprove: boolean): InterfaceAsk["choices"] {
	return [
		{
			destructive: destructiveApprove,
			id: "approve",
			label: "Approve",
			tone: "allow",
		},
		{ id: "reject", label: "Reject", tone: "deny" },
	];
}

function buildEvents(nowMs: number): InterfaceEvent[] {
	const iso = (ms: number) => new Date(ms).toISOString();
	const ids = FIXTURE_AGENT_IDS;
	const events: InterfaceEvent[] = [];
	for (const daysAgo of [3, 2, 1]) {
		// Io's persistent cron routine: fired 09:45, took 20 minutes.
		const loginStart = nowMs - daysAgo * DAY - 15 * MINUTE;
		events.push({
			agentId: ids.io,
			end: iso(loginStart + 20 * MINUTE),
			error: null,
			id: `ev-login-${daysAgo}`,
			jobId: FIXTURE_JOB_IDS.ioLogin,
			kind: "past",
			label: "Daily at 9:45 AM",
			outcome: "success",
			requiresApproval: false,
			start: iso(loginStart),
			threadId: FIXTURE_THREAD_IDS.io,
			title: "Login check",
		});
		// Io's per-firing routine: 2-hour runs that must not pool into the login estimate.
		const sweepStart = nowMs - daysAgo * DAY - 8 * HOUR;
		events.push({
			agentId: ids.io,
			end: iso(sweepStart + 2 * HOUR),
			error: null,
			id: `ev-sweep-${daysAgo}`,
			jobId: FIXTURE_JOB_IDS.ioSweep,
			kind: "past",
			label: "Daily at 2 AM",
			outcome: "success",
			requiresApproval: false,
			start: iso(sweepStart),
			threadId: null,
			title: "Sweep stale branches",
		});
	}
	events.push(
		{
			agentId: ids.ha,
			end: iso(nowMs - 30 * HOUR),
			error: "Digest source returned an error",
			id: "ev-digest-failed",
			jobId: FIXTURE_JOB_IDS.haDigest,
			kind: "past",
			label: "Daily at 4 AM",
			outcome: "failure",
			requiresApproval: false,
			start: iso(nowMs - 30 * HOUR - 5 * MINUTE),
			threadId: FIXTURE_THREAD_IDS.haDigest,
			title: "Daily digest",
		},
		{
			agentId: ids.di,
			end: iso(nowMs - 6 * HOUR),
			error: "Backup target is full",
			id: "ev-nightly-failed",
			jobId: FIXTURE_JOB_IDS.diNightly,
			kind: "past",
			label: "Daily at 3:50 AM",
			outcome: "failure",
			requiresApproval: false,
			start: iso(nowMs - 6 * HOUR - 10 * MINUTE),
			threadId: FIXTURE_THREAD_IDS.diNightly,
			title: "Nightly backup",
		},
		{
			agentId: ids.cy,
			id: "ev-standup-next",
			jobId: FIXTURE_JOB_IDS.cyStandup,
			kind: "upcoming",
			label: "Daily at 9 AM",
			requiresApproval: false,
			start: iso(nowMs + 23 * HOUR),
			threadId: null,
			title: "Morning standup",
		}
	);
	return events.sort(
		(a, b) =>
			Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id)
	);
}

function buildThreads(
	nowMs: number,
	livePermission: boolean
): InterfaceThread[] {
	const iso = (ms: number) => new Date(ms).toISOString();
	const ids = FIXTURE_AGENT_IDS;
	const t = FIXTURE_THREAD_IDS;
	const ada = livePermission
		? baseThread({
				agentIds: [ids.ada],
				detail: "summary",
				id: t.ada,
				lastMessage: "I queued the deploy for your approval.",
				lastMessageAt: iso(nowMs - 15 * MINUTE),
				projectId: "proj-site",
				running: true,
				runStartedApprox: true,
				runStartedAt: iso(nowMs - 8 * MINUTE),
				runState: "running",
				title: "Deploy the site",
				updatedAt: iso(nowMs - 7 * MINUTE),
			})
		: baseThread({
				agentIds: [ids.ada],
				detail: "summary",
				id: t.ada,
				lastMessage: "I queued the deploy for your approval.",
				lastMessageAt: iso(nowMs - 15 * MINUTE),
				projectId: "proj-site",
				title: "Deploy the site",
				updatedAt: iso(nowMs - 14 * MINUTE),
			});
	const threads: InterfaceThread[] = [
		ada,
		baseThread({
			activity: {
				kind: "ask",
				label: "Asking which DB to use",
				observedAt: iso(nowMs),
				recent: ["read", "think"],
				since: iso(nowMs - 3 * MINUTE),
				source: "messages",
				target: null,
				tool: "Question",
			},
			agentIds: [ids.bo],
			detail: "detail",
			id: t.bo,
			lastMessage: "Which database should the new service use?",
			lastMessageAt: iso(nowMs - 5 * MINUTE),
			lastProgressAt: iso(nowMs - 3 * MINUTE),
			running: true,
			runStartedApprox: false,
			runStartedAt: iso(nowMs - 6 * MINUTE),
			runState: "running",
			title: "Choose a database",
			updatedAt: iso(nowMs - 3 * MINUTE),
		}),
		baseThread({
			activity: {
				kind: "edit",
				label: "Editing snapshot.ts",
				observedAt: iso(nowMs),
				recent: ["read", "read", "search", "edit", "run"],
				since: iso(nowMs - MINUTE),
				source: "messages",
				target: "snapshot.ts",
				tool: "Edit",
			},
			agentIds: [ids.cy],
			detail: "detail",
			helpers: {
				done: 0,
				failed: 0,
				running: 2,
				titles: ["Check types", "Scan callers"],
			},
			id: t.cy,
			lastMessage: "Splitting the snapshot builder into smaller pieces.",
			lastMessageAt: iso(nowMs - 11 * MINUTE),
			lastProgressAt: iso(nowMs - MINUTE),
			messageCount: 14,
			progress: {
				current: "update snapshot builder",
				done: 3,
				kind: "plan",
				next: "write tests",
				source: "messages",
				total: 7,
			},
			running: true,
			runStartedApprox: false,
			runStartedAt: iso(nowMs - 12 * MINUTE),
			runState: "running",
			teamId: "team-core",
			title: "Refactor snapshot",
			updatedAt: iso(nowMs - MINUTE),
			workspace: "ryu@main",
		}),
		baseThread({
			agentIds: [ids.di],
			blocker: {
				at: iso(nowMs - 20 * MINUTE),
				detail: "`bun test` failed",
				kind: "command-failed",
				source: "messages",
				title: "Tests failed",
			},
			detail: "detail",
			id: t.di,
			lastMessage: "The suite still fails in snapshot.test.ts.",
			lastMessageAt: iso(nowMs - 22 * MINUTE),
			outcome: {
				failures: 1,
				filesChanged: 0,
				finishedAt: iso(nowMs - 20 * MINUTE),
				headline: "Ran the test suite",
				source: "messages",
				summary: "The suite still fails in snapshot.test.ts.",
			},
			runEndedAt: iso(nowMs - 20 * MINUTE),
			runState: "failed",
			teamId: "team-core",
			title: "Fix flaky tests",
			updatedAt: iso(nowMs - 20 * MINUTE),
		}),
		baseThread({
			agentIds: [ids.di],
			blocker: {
				at: iso(nowMs - 6 * HOUR),
				detail: "Backup target is full",
				kind: "schedule-failed",
				source: "schedule",
				title: "Nightly backup failed",
			},
			detail: "summary",
			id: t.diNightly,
			lastMessage: "Backup target is full",
			lastMessageAt: iso(nowMs - 6 * HOUR - 2 * MINUTE),
			runState: "failed",
			title: "Nightly backup",
			updatedAt: iso(nowMs - 6 * HOUR),
		}),
		baseThread({
			agentIds: [ids.ed],
			blocker: {
				at: iso(nowMs - HOUR),
				atApprox: true,
				kind: "interrupted",
				source: "run-stream",
				title: "Interrupted",
			},
			detail: "summary",
			id: t.ed,
			lastMessage: "Picking up the schema migration where it stopped.",
			lastMessageAt: iso(nowMs - 2 * HOUR),
			runEndedAt: null,
			runState: "interrupted",
			title: "Resume the migration",
			updatedAt: iso(nowMs - 2 * HOUR),
		}),
		baseThread({
			agentIds: [ids.fa],
			detail: "summary",
			id: t.fa,
			lastMessage: "The launch plan is drafted.",
			lastMessageAt: iso(nowMs - 3 * HOUR),
			title: "Plan the launch",
			updatedAt: iso(nowMs - 3 * HOUR),
		}),
		baseThread({
			agentIds: [ids.gu],
			detail: "detail",
			id: t.gu,
			lastMessage: "I updated the three config files and their tests.",
			lastMessageAt: iso(nowMs - 45 * MINUTE),
			outcome: {
				artifacts: 0,
				deletions: 7,
				failures: 0,
				filesChanged: 3,
				finishedAt: iso(nowMs - 40 * MINUTE),
				headline: "Edited 3 files",
				insertions: 42,
				source: "messages",
				summary: "Three config files now point at the new host.",
			},
			runEndedAt: iso(nowMs - 40 * MINUTE),
			title: "Update the configs",
			unread: 1,
			updatedAt: iso(nowMs - 40 * MINUTE),
		}),
		baseThread({
			agentIds: [ids.ha],
			detail: "summary",
			id: t.ha,
			lastMessage: "Replied to every review comment.",
			lastMessageAt: iso(nowMs - 2 * HOUR),
			title: "Answer the review",
			updatedAt: iso(nowMs - 2 * HOUR),
		}),
		baseThread({
			agentIds: [ids.ha],
			blocker: {
				at: iso(nowMs - 30 * HOUR),
				detail: "Digest source returned an error",
				kind: "schedule-failed",
				source: "schedule",
				title: "Daily digest failed",
			},
			detail: "summary",
			id: t.haDigest,
			lastMessage: "Digest source returned an error",
			lastMessageAt: iso(nowMs - 30 * HOUR - 2 * MINUTE),
			messageCount: 2,
			runState: "failed",
			title: "Daily digest",
			updatedAt: iso(nowMs - 30 * HOUR),
		}),
		baseThread({
			agentIds: [ids.io],
			detail: "summary",
			id: t.io,
			lastMessage: "Checking the login redirect.",
			lastMessageAt: iso(nowMs - 14 * MINUTE),
			routineRun: {
				firedAt: iso(nowMs - 15 * MINUTE),
				jobId: FIXTURE_JOB_IDS.ioLogin,
			},
			running: true,
			// First seen 20 s after the 09:45 fire: a lower bound, so no elapsed number.
			runStartedApprox: true,
			runStartedAt: iso(nowMs - 15 * MINUTE + 20_000),
			runState: "running",
			title: "Fix login flow",
			updatedAt: iso(nowMs - 14 * MINUTE),
		}),
		baseThread({
			agentIds: [ids.ju],
			detail: "summary",
			id: t.ju,
			lastMessage: "Here is the weekly report summary you asked for.",
			lastMessageAt: iso(nowMs - 30 * HOUR),
			runEndedAt: null,
			title: "Weekly report",
			unread: 1,
			updatedAt: iso(nowMs - 30 * HOUR),
		}),
	];
	return threads;
}

function buildAsks(nowMs: number, livePermission: boolean): InterfaceAsk[] {
	const iso = (ms: number) => new Date(ms).toISOString();
	const ids = FIXTURE_AGENT_IDS;
	const t = FIXTURE_THREAD_IDS;
	const a = FIXTURE_ASK_IDS;
	const asks: InterfaceAsk[] = [
		{
			agentId: null,
			blocking: true,
			choices: approveReject(false),
			holdsRun: true,
			id: a.workflowGate,
			kind: "approval",
			reason: "The deploy workflow is waiting at its approval gate.",
			riskTags: ["workflow"],
			since: iso(nowMs - 20 * MINUTE),
			source: "approvals",
			subject: "workflow_gate",
			target: null,
			text: "Workflow gate: Deploy",
			threadId: null,
		},
		{
			agentId: ids.ada,
			blocking: true,
			choices: approveReject(true),
			holdsRun: false,
			id: a.adaToolCall,
			kind: "approval",
			reason: "Ada wants to run the deploy script.",
			riskTags: ["run"],
			since: iso(nowMs - 14 * MINUTE),
			source: "approvals",
			subject: "tool_call",
			target: "deploy.sh",
			text: "Can I run `shell.run` now?",
			threadId: t.ada,
		},
		{
			agentId: ids.bo,
			blocking: true,
			choices: [
				{ id: "local", label: "Local file", tone: "neutral" },
				{ id: "server", label: "Server", tone: "neutral" },
			],
			expiresApprox: true,
			expiresAt: iso(nowMs + 7 * MINUTE),
			holdsRun: true,
			id: a.boQuestion,
			kind: "question",
			reason: "Pick the database for the new service.",
			since: iso(nowMs - 3 * MINUTE),
			source: "messages",
			subject: null,
			target: null,
			text: "Which DB to use?",
			threadId: t.bo,
		},
		{
			agentId: ids.gu,
			blocking: false,
			holdsRun: false,
			id: a.guReply,
			kind: "reply",
			since: iso(nowMs - 40 * MINUTE),
			source: "messages",
			text: "Edited 3 files",
			threadId: t.gu,
		},
		{
			agentId: ids.ha,
			blocking: false,
			choices: approveReject(false),
			holdsRun: false,
			id: a.haHeal,
			kind: "approval",
			reason: "Diagnosis: the digest source moved.",
			riskTags: ["heal", "auto"],
			since: iso(nowMs - 2 * HOUR),
			source: "approvals",
			subject: "heal_fix",
			target: null,
			text: "Apply the fix for Daily digest?",
			threadId: null,
		},
		{
			agentId: ids.ju,
			blocking: false,
			holdsRun: false,
			id: a.juReply,
			kind: "reply",
			since: iso(nowMs - 30 * HOUR),
			sinceApprox: true,
			source: "messages",
			text: "Here is the weekly report summary you asked for.",
			threadId: t.ju,
		},
	];
	if (livePermission) {
		asks.push({
			agentId: ids.ada,
			blocking: true,
			choices: [
				{
					destructive: true,
					id: "allow_once",
					label: "Allow once",
					tone: "allow",
				},
				{ id: "reject_once", label: "Reject", tone: "deny" },
			],
			expiresApprox: true,
			expiresAt: iso(nowMs + 3 * MINUTE),
			holdsRun: true,
			id: a.adaPermission,
			kind: "permission",
			reason: null,
			since: iso(nowMs - 7 * MINUTE),
			sinceApprox: true,
			source: "live-tab",
			subject: "edit",
			target: "deploy.sh",
			text: "Allow Edit deploy.sh?",
			threadId: t.ada,
		});
	}
	return asks;
}

function buildAgents(livePermission: boolean, nowMs: number): InterfaceAgent[] {
	const ids = FIXTURE_AGENT_IDS;
	return [
		agent(ids.ada, "Ada", "Ships releases", {
			status: livePermission ? "working" : "idle",
		}),
		agent(ids.bo, "Bo", "Designs data models", { status: "working" }),
		agent(ids.cy, "Cy", "Refactors the desktop host", { status: "working" }),
		agent(ids.di, "Di", "Keeps the test suite green"),
		agent(ids.ed, "Ed", "Runs migrations"),
		agent(ids.fa, "Fa", "Answers product questions", {
			limit: {
				blocked: true,
				label: "Weekly",
				model: null,
				resetsAt: new Date(nowMs + 5 * HOUR + 10 * MINUTE).toISOString(),
				usedPercent: 100,
				windowSeconds: 604_800,
			},
			model: null,
		}),
		agent(ids.gu, "Gu", "Maintains configs"),
		agent(ids.ha, "Ha", "Writes digests and reviews"),
		agent(ids.io, "Io", "Watches the login flow", { status: "working" }),
		agent(ids.ju, "Ju", "Writes reports"),
	];
}

function filterToAgents(
	snapshot: InterfaceSnapshot,
	keep: ReadonlySet<string>
): InterfaceSnapshot {
	const threads = snapshot.threads.filter((thread) =>
		thread.agentIds.some((id) => keep.has(id))
	);
	const threadIds = new Set(threads.map((thread) => thread.id));
	const filtered: InterfaceSnapshot = {
		...snapshot,
		agents: snapshot.agents.filter((entry) => keep.has(entry.id)),
		// Unowned asks (workflow gates) stay unless their thread was dropped.
		asks: snapshot.asks?.filter((ask) => {
			if (ask.agentId !== null) {
				return keep.has(ask.agentId);
			}
			return ask.threadId === null || threadIds.has(ask.threadId);
		}),
		events: snapshot.events?.filter(
			(event) => event.agentId !== null && keep.has(event.agentId)
		),
		groups: snapshot.groups.map((group) => ({
			...group,
			memberAgentIds: group.memberAgentIds.filter((id) => keep.has(id)),
		})),
		threads,
	};
	if (snapshot.account) {
		filtered.account = {
			...snapshot.account,
			transactions: snapshot.account.transactions.filter(
				(transaction) =>
					transaction.threadId === null || threadIds.has(transaction.threadId)
			),
		};
	}
	return filtered;
}

/**
 * The shared useful-state snapshot (spec §7.1). `agents` keeps only those
 * agents and their threads, asks and events (the unowned workflow gate stays); `livePermission` makes Ada run with a live-tab permission ask;
 * `privacy: "redacted"` returns `redactSnapshot` of the result.
 */
export function usefulStateFixture(
	opts: UsefulStateFixtureOptions = {}
): InterfaceSnapshot {
	const nowMs = opts.nowMs ?? FIXTURE_NOW_MS;
	const livePermission = opts.livePermission === true;
	const events = buildEvents(nowMs);
	const threads = buildThreads(nowMs, livePermission).map((thread) =>
		// The host computes the estimate for a routine run with no plan (spec §3.2).
		thread.routineRun && !thread.progress
			? { ...thread, progress: estimateProgress(thread, nowMs, events) }
			: thread
	);
	let snapshot: InterfaceSnapshot = {
		account: {
			balance: 12_500_000,
			breakdown: { gift: null, plan: 10_000_000, topup: 2_500_000 },
			currency: "usd",
			transactions: [
				{
					amount: -120_000,
					at: new Date(nowMs - 30 * MINUTE).toISOString(),
					balanceAfter: 12_500_000,
					id: "tx-cy-1",
					inputTokens: 12_000,
					kind: "debit",
					label: "Refactor snapshot",
					model: "large-1",
					outputTokens: 3000,
					provider: null,
					threadId: FIXTURE_THREAD_IDS.cy,
				},
			],
		},
		agents: buildAgents(livePermission, nowMs),
		askBlindSpots: ["permission", "input", "question"],
		asks: buildAsks(nowMs, livePermission),
		events,
		groups: [
			{
				id: "team-core",
				kind: "team",
				memberAgentIds: [FIXTURE_AGENT_IDS.cy, FIXTURE_AGENT_IDS.di],
				name: "Core crew",
			},
			{
				id: "proj-site",
				kind: "project",
				memberAgentIds: [FIXTURE_AGENT_IDS.ada],
				name: "Marketing site",
			},
		],
		observedAt: new Date(nowMs).toISOString(),
		privacy: "full",
		threads,
		version: INTERFACE_PROTOCOL_VERSION,
	};
	if (opts.agents) {
		snapshot = filterToAgents(snapshot, new Set(opts.agents));
	}
	return opts.privacy === "redacted" ? redactSnapshot(snapshot) : snapshot;
}
