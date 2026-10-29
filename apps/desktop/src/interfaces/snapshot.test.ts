import { describe, expect, test } from "bun:test";
import {
	agentActs,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	isSuggestion,
	threadStatus,
	unownedAsks,
} from "@ryuhq/protocol/interfaces";
import type { ApprovalRequest } from "@/src/lib/api/approvals.ts";
import type { ScheduledJob } from "@/src/lib/api/schedules.ts";
import type { UsageSnapshot } from "@/src/lib/api/usage.ts";
import type { CalendarEvent } from "@/src/lib/calendar/events.ts";
import type { ThreadDetail } from "@/src/lib/interface-detail.ts";
import type { InterfaceDetailEntry } from "@/src/store/useInterfaceDetailStore.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	approvalTarget,
	approvalToAsk,
	buildInterfaceSnapshot,
	chooseAgentLimit,
	type InterfaceLiveInput,
	linkOrphanRuns,
	MAX_INTERFACE_EVENTS,
	MAX_INTERFACE_THREADS,
	modelsMatch,
	omittedInterfaceThreads,
	resolveRunStart,
	resolveSnapshotProjects,
	routineRunFor,
	stabilizeSnapshot,
	toInterfaceAccount,
	toInterfaceEvents,
	withInterfaceAccount,
} from "./snapshot.ts";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function conversation(
	id: string,
	overrides: Partial<Conversation> = {}
): Conversation {
	return {
		createdAt: T0,
		id,
		messages: [],
		title: `Thread ${id}`,
		updatedAt: T0,
		...overrides,
	};
}

const agents = [
	{
		avatarUrl: null,
		description: "Writes code",
		id: "coder",
		name: "Coder",
	},
	{
		avatarUrl: "data:image/png;base64,AA==",
		description: null,
		id: "writer",
		name: "Writer",
	},
];

const teams = [{ id: "team-1", members: ["coder", "writer"], name: "Launch" }];

describe("buildInterfaceSnapshot", () => {
	test("projects main threads newest first and drops archived threads and sessions", () => {
		const snapshot = buildInterfaceSnapshot({
			agents,
			conversations: [
				conversation("old", { agentId: "coder", updatedAt: T0 - 60_000 }),
				conversation("new", {
					agentId: "writer",
					lastMessageAt: T0 + 60_000,
				}),
				conversation("archived", { archived: true }),
				conversation("session", {
					hierarchy: { role: "session", spawnedByConversationId: "new" },
				}),
			],
			teams,
		});
		expect(snapshot.version).toBe(1);
		expect(snapshot.threads.map((thread) => thread.id)).toEqual(["new", "old"]);
		expect(snapshot.threads[0]?.updatedAt).toBe(
			new Date(T0 + 60_000).toISOString()
		);
	});

	test("maps participants, owners, previews, and run state", () => {
		const snapshot = buildInterfaceSnapshot({
			agents,
			conversations: [
				conversation("team-thread", {
					hierarchy: { ownerId: "team-1", ownerKind: "group", role: "main" },
					lastMessage: "  Ship it  ",
					lastMessageRole: "assistant",
					messageCount: 4,
					participants: ["coder", "writer", "coder"],
					pinned: true,
					runStatus: "running",
				}),
				conversation("project-thread", {
					agentId: "coder",
					hierarchy: { projectId: "folder:app", role: "main" },
					lastMessageRole: "tool",
					runStatus: "interrupted",
				}),
			],
			projects: [{ id: "folder:app", name: "App" }],
			teams,
		});
		const byId = (id: string) =>
			snapshot.threads.find((thread) => thread.id === id);
		const teamThread = byId("team-thread");
		const projectThread = byId("project-thread");
		expect(teamThread).toEqual({
			agentIds: ["coder", "writer"],
			id: "team-thread",
			lastMessage: "Ship it",
			lastMessageRole: "assistant",
			messageCount: 4,
			pinned: true,
			projectId: null,
			running: true,
			runState: "running",
			teamId: "team-1",
			title: "Thread team-thread",
			updatedAt: new Date(T0).toISOString(),
		});
		expect(projectThread).toMatchObject({
			agentIds: ["coder"],
			lastMessage: null,
			lastMessageRole: null,
			messageCount: 0,
			projectId: "folder:app",
			running: false,
			runState: "interrupted",
			teamId: null,
		});
		expect(snapshot.agents).toEqual([
			{
				avatarUrl: null,
				description: "Writes code",
				id: "coder",
				name: "Coder",
				status: "working",
			},
			{
				avatarUrl: "data:image/png;base64,AA==",
				description: "",
				id: "writer",
				name: "Writer",
				status: "working",
			},
		]);
		expect(snapshot.groups).toEqual([
			{
				id: "team-1",
				kind: "team",
				memberAgentIds: ["coder", "writer"],
				name: "Launch",
			},
			{
				id: "folder:app",
				kind: "project",
				memberAgentIds: ["coder"],
				name: "App",
			},
		]);
	});

	test("guards invalid timestamps and empty titles", () => {
		const snapshot = buildInterfaceSnapshot({
			agents: [],
			conversations: [
				conversation("nan", {
					lastMessageAt: Number.NaN,
					title: "  ",
					updatedAt: Number.NaN,
				}),
				conversation("huge", { lastMessageAt: 1e20 }),
			],
			teams: [],
		});
		for (const thread of snapshot.threads) {
			expect(thread.updatedAt).toBe(new Date(0).toISOString());
		}
		expect(snapshot.threads.find((thread) => thread.id === "nan")?.title).toBe(
			"New chat"
		);
	});

	test("keeps standalone chats that carry Core's default session role", () => {
		const snapshot = buildInterfaceSnapshot({
			agents,
			conversations: [
				conversation("standalone", {
					agentId: "coder",
					hierarchy: { role: "session" },
				}),
				conversation("project-session", {
					hierarchy: { projectId: "p1", role: "session" },
				}),
			],
			teams: [],
		});
		expect(snapshot.threads.map((thread) => thread.id)).toEqual(["standalone"]);
	});

	test("rolls a running session up to its main thread and agents", () => {
		const snapshot = buildInterfaceSnapshot({
			agents,
			conversations: [
				conversation("main", {
					agentId: "coder",
					hierarchy: { role: "main" },
					runStatus: "completed",
				}),
				conversation("child", {
					hierarchy: { role: "session", spawnedByConversationId: "main" },
				}),
				conversation("grandchild", {
					hierarchy: { role: "session", spawnedByConversationId: "child" },
					runStatus: "running",
				}),
				conversation("idle", { agentId: "writer" }),
			],
			teams: [],
		});
		const main = snapshot.threads.find((thread) => thread.id === "main");
		expect(main?.running).toBe(true);
		// The lift reaches the whole spawn chain, and the lifted state reads
		// "running", as a direct helper's does.
		expect(main?.runState).toBe("running");
		expect(snapshot.threads.map((thread) => thread.id).sort()).toEqual([
			"idle",
			"main",
		]);
		expect(
			Object.fromEntries(
				snapshot.agents.map((agent) => [agent.id, agent.status])
			)
		).toEqual({ coder: "working", writer: "idle" });
	});

	test("includes the primary agent alongside additional participants", () => {
		const snapshot = buildInterfaceSnapshot({
			agents,
			conversations: [
				conversation("council", {
					agentId: "writer",
					participants: ["coder", "writer"],
					runStatus: "running",
				}),
			],
			teams: [],
		});
		expect(snapshot.threads[0]?.agentIds).toEqual(["writer", "coder"]);
		expect(snapshot.agents.every((agent) => agent.status === "working")).toBe(
			true
		);
	});

	test("a run awaiting the user's input reads as their turn", () => {
		const snapshot = buildInterfaceSnapshot({
			agents,
			conversations: [
				conversation("asking", {
					agentId: "coder",
					lastMessage: "Which branch?",
					lastMessageRole: "user",
					runStatus: "awaiting_input",
				}),
			],
			teams: [],
		});
		expect(snapshot.threads[0]).toMatchObject({
			lastMessageRole: "assistant",
			running: false,
			runState: null,
		});
		expect(threadStatus(snapshot.threads[0] as InterfaceThread)).toBe(
			"your-turn"
		);
	});

	test("caps the thread list to the most recent threads", () => {
		const conversations = Array.from(
			{ length: MAX_INTERFACE_THREADS + 25 },
			(_, index) => conversation(`t${index}`, { updatedAt: T0 + index })
		);
		const snapshot = buildInterfaceSnapshot({
			agents: [],
			conversations,
			teams: [],
		});
		expect(snapshot.threads).toHaveLength(MAX_INTERFACE_THREADS);
		expect(snapshot.threads[0]?.id).toBe(`t${MAX_INTERFACE_THREADS + 24}`);
		expect(snapshot.threads.some((thread) => thread.id === "t0")).toBe(false);
		// The interface says how many it left out, so the list never reads as whole.
		expect(omittedInterfaceThreads(conversations)).toBe(25);
		expect(omittedInterfaceThreads(conversations.slice(0, 10))).toBe(0);
	});
});

describe("toInterfaceEvents", () => {
	const base: CalendarEvent = {
		id: "e1",
		jobId: "job-1",
		jobName: "Morning digest",
		kind: "upcoming",
		scheduleLabel: "Daily at 9 AM",
		start: new Date(T0 + 3_600_000),
	};

	test("maps scheduled runs, oldest first, and drops Core maintenance jobs", () => {
		const events = toInterfaceEvents([
			{ ...base, agentId: "atlas" },
			{
				...base,
				end: new Date(T0 + 60_000),
				id: "e0",
				kind: "past",
				outcome: "failure",
				start: new Date(T0),
				workflowName: "Weekly report",
			},
			{ ...base, id: "sys", start: new Date(T0 - 1000), system: true },
		]);
		expect(events).toEqual([
			{
				agentId: null,
				count: null,
				end: new Date(T0 + 60_000).toISOString(),
				error: null,
				id: "e0",
				jobId: "job-1",
				kind: "past",
				label: "Daily at 9 AM",
				outcome: "failure",
				requiresApproval: false,
				start: new Date(T0).toISOString(),
				threadId: null,
				title: "Weekly report",
			},
			{
				agentId: "atlas",
				count: null,
				end: null,
				error: null,
				id: "e1",
				jobId: "job-1",
				kind: "upcoming",
				label: "Daily at 9 AM",
				outcome: null,
				requiresApproval: false,
				start: new Date(T0 + 3_600_000).toISOString(),
				threadId: null,
				title: "Morning digest",
			},
		]);
	});

	test("over the cap, keeps the runs nearest now so upcoming runs survive", () => {
		const history = Array.from(
			{ length: MAX_INTERFACE_EVENTS },
			(_, index): CalendarEvent => ({
				...base,
				id: `past-${index}`,
				kind: "past",
				start: new Date(T0 - (index + 1) * 60_000),
			})
		);
		const next: CalendarEvent = {
			...base,
			id: "next",
			start: new Date(T0 + 60_000),
		};
		const events = toInterfaceEvents([...history, next], T0);
		expect(events).toHaveLength(MAX_INTERFACE_EVENTS);
		expect(events.at(-1)?.id).toBe("next");
		expect(
			events.some((event) => event.id === `past-${MAX_INTERFACE_EVENTS - 1}`)
		).toBe(false);
		expect(events[0]?.start.localeCompare(events[1]?.start ?? "")).toBe(-1);
	});

	test("snapshots carry events only when the host passes them", () => {
		const without = buildInterfaceSnapshot({
			agents: [],
			conversations: [],
			teams: [],
		});
		expect("events" in without).toBe(false);
		const withEvents = buildInterfaceSnapshot({
			agents: [],
			conversations: [],
			events: toInterfaceEvents([base]),
			teams: [],
		});
		expect(withEvents.events?.map((event) => event.id)).toEqual(["e1"]);
	});
});

describe("resolveSnapshotProjects", () => {
	test("publishes folder projects under their node project ids", () => {
		const projects = resolveSnapshotProjects({
			conversations: [
				conversation("app-main", {
					hierarchy: {
						ownerId: "proj-app",
						ownerKind: "project",
						role: "main",
					},
					title: "App (node)",
				}),
				conversation("docs-main", {
					hierarchy: {
						ownerId: "proj-docs",
						ownerKind: "project",
						role: "main",
					},
					title: "Docs",
				}),
			],
			folderProjectMap: { "folder:app": "proj-app" },
			workspaceProjects: [
				{ id: "folder:app", name: "App" },
				{ id: "folder:unmigrated", name: "Scratch" },
			],
		});
		expect(projects).toEqual([
			{ id: "proj-app", name: "App" },
			{ id: "folder:unmigrated", name: "Scratch" },
			{ id: "proj-docs", name: "Docs" },
		]);
	});

	test("migrated threads group under the node project", () => {
		const snapshot = buildInterfaceSnapshot({
			agents,
			conversations: [
				conversation("work", {
					agentId: "coder",
					hierarchy: { projectId: "proj-app", role: "main" },
				}),
			],
			projects: resolveSnapshotProjects({
				conversations: [],
				folderProjectMap: { "folder:app": "proj-app" },
				workspaceProjects: [{ id: "folder:app", name: "App" }],
			}),
			teams: [],
		});
		expect(snapshot.groups).toEqual([
			{
				id: "proj-app",
				kind: "project",
				memberAgentIds: ["coder"],
				name: "App",
			},
		]);
	});
});

describe("toInterfaceAccount", () => {
	const entry = {
		balanceAfter: 4_000_000,
		createdAt: "2026-10-01T12:00:00.000Z",
		delta: -250_000,
		durationMs: 1200,
		estimated: false,
		id: "led-1",
		inputTokens: 1200,
		model: "model-a",
		orgId: null,
		outputTokens: 300,
		provider: "openrouter",
		reason: "usage",
		refId: "thread-1",
		taskLabel: "Draft release notes",
		upstreamProvider: null,
		userId: "user-1",
		walletId: "wallet-1",
	};

	test("maps balance, breakdown, and transactions newest first", () => {
		const account = toInterfaceAccount(
			{
				ledger: [
					entry,
					{
						...entry,
						createdAt: "2026-10-02T12:00:00.000Z",
						delta: 5_000_000,
						id: "led-2",
						inputTokens: null,
						outputTokens: null,
						reason: "topup",
						refId: "not-a-thread",
						taskLabel: null,
					},
				],
				wallet: {
					balanceMicroUsd: 9_000_000,
					currency: "USD",
					id: "wallet-1",
					ownerId: "org-1",
					ownerType: "org",
					subscriptionBalanceMicroUsd: 4_000_000,
					topupBalanceMicroUsd: 5_000_000,
					updatedAt: "2026-10-02T12:00:00.000Z",
				},
			},
			new Set(["thread-1"])
		);
		expect(account.balance).toBe(9_000_000);
		expect(account.currency).toBe("usd");
		expect(account.breakdown).toEqual({
			gift: null,
			plan: 4_000_000,
			topup: 5_000_000,
		});
		expect(account.transactions.map((row) => row.id)).toEqual([
			"led-2",
			"led-1",
		]);
		const [credit, debit] = account.transactions;
		expect(credit?.kind).toBe("credit");
		expect(credit?.threadId).toBeNull();
		expect(debit).toMatchObject({
			amount: -250_000,
			kind: "debit",
			label: "Draft release notes",
			threadId: "thread-1",
		});
	});
});

// ---------------------------------------------------------------------------
// Useful state, phase 1a (spec docs/interfaces-useful-state.md §3.2, §7.2)
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Realistic epoch ms, so a seconds/ms mix-up fails loudly. */
const NOW = 1_760_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

function liveInput(
	overrides: Partial<InterfaceLiveInput> = {}
): InterfaceLiveInput {
	return {
		approvals: [],
		firstSeenRunning: new Map(),
		privacy: "full",
		runs: new Map(),
		terminalSeen: new Map(),
		unread: new Map(),
		...overrides,
	};
}

function liveSnapshot(
	conversations: Conversation[],
	live: Partial<InterfaceLiveInput> = {},
	extra: { events?: InterfaceEvent[]; jobs?: ScheduledJob[] } = {}
) {
	return buildInterfaceSnapshot({
		agents,
		conversations,
		live: liveInput(live),
		nowMs: NOW,
		teams,
		...extra,
	});
}

function approval(
	overrides: Partial<ApprovalRequest> & { id: string }
): ApprovalRequest {
	return {
		created_at: iso(NOW - 14 * MINUTE),
		kind: "tool_call",
		risk_tags: ["run"],
		status: "pending",
		summary: "Run a tool",
		title: "Run shell.run",
		...overrides,
	};
}

function job(overrides: Partial<ScheduledJob> & { id: string }): ScheduledJob {
	return {
		appId: null,
		createdAt: iso(NOW - 30 * 24 * HOUR),
		enabled: true,
		history: [],
		lastOutcome: null,
		lastRunAt: null,
		name: "Login check",
		ownerApp: null,
		requireApproval: false,
		schedule: { expr: "45 9 * * *", kind: "cron", tz: "UTC" },
		system: false,
		target: {
			agentId: "coder",
			conversationId: "routine-chat",
			prompt: "check",
			type: "agent",
		},
		updatedAt: iso(NOW - 30 * 24 * HOUR),
		...overrides,
	};
}

const threadOf = (snapshot: InterfaceSnapshot, id: string) =>
	snapshot.threads.find((thread) => thread.id === id);

describe("run overlay (test 8)", () => {
	const base = conversation("c", {
		agentId: "coder",
		runStatus: "completed",
		updatedAt: NOW - HOUR,
	});

	test("a newer run frame overrides the list status and an older one does not", () => {
		const newer = liveSnapshot([base], {
			runs: new Map([
				["c", { run_status: "running", updated_at: NOW - HOUR + 1 }],
			]),
		});
		expect(threadOf(newer, "c")).toMatchObject({
			running: true,
			runState: "running",
		});
		const older = liveSnapshot([base], {
			runs: new Map([
				["c", { run_status: "running", updated_at: NOW - HOUR - 1 }],
			]),
		});
		expect(threadOf(older, "c")).toMatchObject({
			running: false,
			runState: "completed",
		});
	});

	test("run times: first sighting is approximate, end time only from an exact terminal entry", () => {
		const running = liveSnapshot([{ ...base, runStatus: "running" }], {
			firstSeenRunning: new Map([["c", NOW - 5 * MINUTE]]),
		});
		expect(threadOf(running, "c")).toMatchObject({
			runStartedApprox: true,
			runStartedAt: iso(NOW - 5 * MINUTE),
		});
		const exact = liveSnapshot([base], {
			terminalSeen: new Map([["c", { approx: false, atMs: NOW - 2 * MINUTE }]]),
		});
		expect(threadOf(exact, "c")?.runEndedAt).toBe(iso(NOW - 2 * MINUTE));
		const approx = liveSnapshot([base], {
			terminalSeen: new Map([["c", { approx: true, atMs: NOW - 2 * MINUTE }]]),
		});
		expect(threadOf(approx, "c")?.runEndedAt).toBeNull();
	});

	test("interrupted and failed summary blockers never use updatedAt", () => {
		const seen = liveSnapshot([{ ...base, runStatus: "interrupted" }], {
			terminalSeen: new Map([["c", { approx: true, atMs: NOW - 50 * MINUTE }]]),
		});
		expect(threadOf(seen, "c")?.blocker).toMatchObject({
			at: iso(NOW - 50 * MINUTE),
			atApprox: true,
			kind: "interrupted",
		});
		const unseen = liveSnapshot([{ ...base, runStatus: "interrupted" }]);
		expect(threadOf(unseen, "c")?.blocker?.at).toBeNull();
		const failed = liveSnapshot([{ ...base, runStatus: "failed" }]);
		expect(threadOf(failed, "c")?.blocker).toMatchObject({
			at: null,
			kind: "error",
			title: "Run failed",
		});
		for (const snap of [seen, unseen, failed]) {
			expect(threadOf(snap, "c")?.blocker?.at).not.toBe(iso(base.updatedAt));
		}
	});

	test("awaiting_input plumbing: your turn, not running, an input ask that holds the run", () => {
		const snap = liveSnapshot([base], {
			awaitingSince: new Map([["c", NOW - MINUTE]]),
			runs: new Map([["c", { run_status: "awaiting_input", updated_at: NOW }]]),
		});
		expect(threadOf(snap, "c")).toMatchObject({
			awaitingInput: true,
			running: false,
		});
		expect(snap.asks?.find((ask) => ask.kind === "input")).toMatchObject({
			blocking: true,
			holdsRun: true,
			id: "input:c",
			since: iso(NOW - MINUTE),
			sinceApprox: true,
		});
	});

	test("helpers roll up onto their parent and lift the agent to working", () => {
		const snap = liveSnapshot([
			conversation("parent", { agentId: "coder", runStatus: "completed" }),
			conversation("s1", {
				hierarchy: { role: "session", spawnedByConversationId: "parent" },
				runStatus: "running",
				title: "Check types",
			}),
			conversation("s2", {
				hierarchy: { role: "session", spawnedByConversationId: "parent" },
				runStatus: "failed",
			}),
			conversation("s3", {
				hierarchy: { role: "session", spawnedByConversationId: "parent" },
				runStatus: "completed",
			}),
		]);
		expect(threadOf(snap, "parent")).toMatchObject({
			helpers: { done: 1, failed: 1, running: 1, titles: ["Check types"] },
			running: true,
		});
		expect(snap.agents.find((agent) => agent.id === "coder")?.status).toBe(
			"working"
		);
		expect(snap.threads.map((thread) => thread.id)).toEqual(["parent"]);
	});

	test("observedAt, privacy, blind spots, model and focus thread", () => {
		const snap = liveSnapshot([base]);
		expect(snap.observedAt).toBe(iso(NOW));
		expect(snap.privacy).toBe("full");
		expect(snap.askBlindSpots).toEqual(["permission", "input", "question"]);
		expect(snap.agents.find((agent) => agent.id === "coder")).toMatchObject({
			focusThreadId: "c",
			model: null,
		});
		expect(threadOf(snap, "c")?.detail).toBe("summary");
	});

	test("without live inputs the snapshot has no useful-state keys", () => {
		const snap = buildInterfaceSnapshot({
			agents,
			conversations: [base],
			teams,
		});
		expect(snap.asks).toBeUndefined();
		expect(snap.privacy).toBeUndefined();
		expect(threadOf(snap, "c")).not.toHaveProperty("unread");
	});

	test("once previews arrive, updatedAt is the newest message start (sort-key latch)", () => {
		const snap = liveSnapshot([
			{ ...base, lastMessageAt: NOW - 3 * HOUR, lastMessageRole: "assistant" },
		]);
		expect(threadOf(snap, "c")).toMatchObject({
			lastMessageAt: iso(NOW - 3 * HOUR),
			updatedAt: iso(NOW - 3 * HOUR),
		});
	});
});

describe("approvals (tests 8, 13a)", () => {
	const index = {
		sessionParents: new Map([["session-1", "main-1"]]),
		threadIds: new Set(["main-1", "host-1"]),
	};

	test("a session approval lifts to its parent; action ids fill the top-level gaps", () => {
		expect(
			approvalToAsk(approval({ conversation_id: "session-1", id: "a" }), index)
				.threadId
		).toBe("main-1");
		const ask = approvalToAsk(
			approval({
				action: {
					agent_id: "coder",
					arguments: {
						command: "deploy.sh --prod",
						env: { TOKEN: "fixture-secret" },
					},
					configure_approved: false,
					host_conversation_id: "host-1",
					profile_ids: [],
					tool_id: "shell.run",
					type: "tool_call",
				},
				agent_id: null,
				conversation_id: null,
				id: "b",
				question: "Can I run `shell.run` now?",
			}),
			index
		);
		expect(ask).toMatchObject({
			agentId: "coder",
			blocking: true,
			holdsRun: false,
			id: "approval:b",
			subject: "tool_call",
			target: "deploy.sh --prod",
			text: "Can I run `shell.run` now?",
			threadId: "host-1",
		});
		expect(JSON.stringify(ask)).not.toContain("fixture-secret");
		expect(JSON.stringify(ask)).not.toContain("TOKEN");
	});

	test("blocking, holdsRun and suggestions per kind", () => {
		const kinds = (kind: ApprovalRequest["kind"]) =>
			approvalToAsk(approval({ id: kind, kind }), index);
		expect(kinds("workflow_gate")).toMatchObject({
			blocking: true,
			holdsRun: true,
		});
		expect(kinds("scheduled_run")).toMatchObject({
			blocking: true,
			holdsRun: false,
		});
		expect(kinds("trigger_run")).toMatchObject({
			blocking: true,
			holdsRun: false,
		});
		expect(isSuggestion(kinds("heal_fix"))).toBe(true);
		expect(isSuggestion(kinds("skill_synthesis"))).toBe(true);
		expect(kinds("workflow_gate").threadId).toBeNull();
	});

	test("Approve is destructive only for a gated tool call; Reject never", () => {
		const destructive = (kind: ApprovalRequest["kind"], tags: string[]) => {
			const ask = approvalToAsk(
				approval({ id: "x", kind, risk_tags: tags }),
				index
			);
			return ask.choices?.map((choice) => choice.destructive === true);
		};
		for (const tags of [
			["delete"],
			["pay"],
			["agent-configuration"],
			["manual-mode"],
		]) {
			expect(destructive("tool_call", tags)).toEqual([true, false]);
		}
		expect(destructive("scheduled_run", ["scheduled"])).toEqual([false, false]);
		expect(destructive("workflow_gate", ["workflow"])).toEqual([false, false]);
		expect(destructive("heal_fix", ["heal", "auto"])).toEqual([false, false]);
	});

	test("approvalTarget (test 4)", () => {
		expect(approvalTarget({ command: "rm -rf /tmp/x" })).toBe("rm -rf");
		expect(approvalTarget({ file_path: "/a/b/snapshot.ts" })).toBe(
			"snapshot.ts"
		);
		expect(approvalTarget({ url: "https://api.example.com/x?k=1" })).toBe(
			"api.example.com"
		);
		for (const shape of ["rm", ["rm"], null, { foo: 1 }, undefined]) {
			expect(approvalTarget(shape)).toBeNull();
		}
		expect(approvalTarget({ command: `${"a".repeat(200)} b` })?.length).toBe(
			40
		);
		expect(approvalTarget({ command: "`rm`\u0007 now" })).not.toContain("`");
		expect(approvalTarget({ cmd: "echo\u0000 hi there" })).toBe("echo hi");
		expect(
			approvalTarget({ command: "deploy.sh", env: { TOKEN: "fixture-secret" } })
		).toBe("deploy.sh");
	});

	test("the snapshot carries pending approvals as asks; no argument value leaks", () => {
		const snap = liveSnapshot([conversation("host-1", { agentId: "coder" })], {
			approvals: [
				approval({
					action: {
						arguments: {
							command: "deploy.sh",
							env: { TOKEN: "fixture-secret" },
							note: "private-note",
						},
						configure_approved: false,
						host_conversation_id: "host-1",
						profile_ids: [],
						tool_id: "shell.run",
						type: "tool_call",
					},
					id: "p",
				}),
				approval({ id: "done", status: "approved" }),
			],
		});
		expect(snap.asks?.map((ask) => ask.id)).toEqual(["approval:p"]);
		const text = JSON.stringify(snap);
		expect(text).not.toContain("fixture-secret");
		expect(text).not.toContain("private-note");
	});

	test("an approval for an unknown agent with no thread is unowned and still counts", () => {
		const snap = liveSnapshot([], {
			approvals: [approval({ agent_id: "ghost", id: "g" })],
		});
		expect(unownedAsks(snap).map((ask) => ask.id)).toEqual(["approval:g"]);
		expect(snap.asks?.filter((ask) => ask.blocking)).toHaveLength(1);
	});
});

describe("reply asks (test 8)", () => {
	test("500 read answers make no asks; an unread one does, until it is read", () => {
		const read = Array.from({ length: 500 }, (_, i) =>
			conversation(`r${i}`, {
				agentId: "coder",
				lastMessageRole: "assistant",
				runStatus: "completed",
			})
		);
		expect(liveSnapshot(read).asks).toEqual([]);
		const unread = liveSnapshot(read, { unread: new Map([["r7", 2]]) });
		expect(unread.asks?.map((ask) => ask.id)).toEqual(["reply:r7"]);
	});

	test("since is the exact end when seen, else the message start, approximate", () => {
		const reply = conversation("r", {
			agentId: "coder",
			lastMessage: "Here is the plan for the release, step by step and more",
			lastMessageAt: NOW - 50 * MINUTE,
			lastMessageRole: "assistant",
			runStatus: "completed",
			updatedAt: NOW - 40 * MINUTE,
		});
		const unread = new Map([["r", 1]]);
		const exact = liveSnapshot([reply], {
			terminalSeen: new Map([
				["r", { approx: false, atMs: NOW - 41 * MINUTE }],
			]),
			unread,
		});
		expect(exact.asks?.[0]).toMatchObject({
			blocking: false,
			since: iso(NOW - 41 * MINUTE),
			sinceApprox: false,
		});
		const approx = liveSnapshot([reply], { unread });
		expect(approx.asks?.[0]).toMatchObject({
			since: iso(NOW - 50 * MINUTE),
			sinceApprox: true,
		});
		expect(approx.asks?.[0]?.since).not.toBe(iso(reply.updatedAt));
		expect(approx.asks?.[0]?.text.split(" ").length).toBeLessThanOrEqual(12);
	});

	test("a failed or running thread makes no reply ask", () => {
		const unread = new Map([["f", 1]]);
		for (const runStatus of ["failed", "running"]) {
			const snap = liveSnapshot(
				[
					conversation("f", {
						agentId: "coder",
						lastMessageRole: "assistant",
						runStatus,
					}),
				],
				{ unread }
			);
			expect(snap.asks?.filter((ask) => ask.kind === "reply")).toEqual([]);
		}
	});
});

describe("routines (tests 6, 8)", () => {
	// 09:45 UTC on the day of NOW.
	const day = new Date(NOW);
	const fire = Date.UTC(
		day.getUTCFullYear(),
		day.getUTCMonth(),
		day.getUTCDate(),
		9,
		45
	);
	const running = (startMs: number, id = "routine-chat") => ({
		id,
		running: true,
		runStartedAt: iso(startMs),
	});

	test("routineRunFor links a run that started at its cron fire time", () => {
		const jobs = [job({ id: "job-login" })];
		expect(routineRunFor(running(fire + 20_000), jobs)).toEqual({
			firedAt: iso(fire),
			jobId: "job-login",
		});
		expect(routineRunFor(running(fire + 3 * HOUR), jobs)).toBeNull();
		expect(routineRunFor(running(fire + 10 * MINUTE), jobs)).toBeNull();
		expect(
			routineRunFor({ ...running(fire + 20_000), running: false }, jobs)
		).toBeNull();
		expect(
			routineRunFor(running(fire + 20_000), [
				job({ id: "a", requireApproval: true }),
			])
		).toBeNull();
		expect(
			routineRunFor(running(fire + 20_000, "agentrun_1"), [
				job({
					id: "p",
					target: { agentId: "coder", prompt: "x", type: "agent" },
				}),
			])
		).toBeNull();
	});

	test("an interval routine never links, even at a projected occurrence", () => {
		const interval = job({
			history: [
				{
					error: null,
					finishedAt: iso(fire - 40 * MINUTE),
					outcome: "success",
					runId: null,
					startedAt: iso(fire - 60 * MINUTE),
				},
			],
			id: "every",
			lastRunAt: iso(fire - 40 * MINUTE),
			schedule: { interval: "40m", kind: "every" },
		});
		expect(routineRunFor(running(fire), [interval])).toBeNull();
		expect(routineRunFor(running(fire + 20 * MINUTE), [interval])).toBeNull();
	});

	test("the snapshot gives a linked routine run its estimate from its own history", () => {
		const events: InterfaceEvent[] = [1, 2, 3].map((daysAgo) => ({
			agentId: "coder",
			end: iso(fire - daysAgo * 24 * HOUR + 20 * MINUTE),
			id: `e${daysAgo}`,
			jobId: "job-login",
			kind: "past",
			label: null,
			outcome: "success",
			start: iso(fire - daysAgo * 24 * HOUR),
			threadId: "routine-chat",
			title: "Login check",
		}));
		const snap = buildInterfaceSnapshot({
			agents,
			conversations: [
				conversation("routine-chat", {
					agentId: "coder",
					runStatus: "running",
				}),
			],
			events,
			jobs: [job({ id: "job-login" })],
			live: liveInput({
				firstSeenRunning: new Map([["routine-chat", fire + 20_000]]),
			}),
			nowMs: fire + 15 * MINUTE,
			teams,
		});
		const thread = threadOf(snap, "routine-chat") as {
			progress?: { done: number; kind: string; total: number };
			routineRun?: unknown;
		};
		expect(thread.routineRun).toEqual({
			firedAt: iso(fire),
			jobId: "job-login",
		});
		expect(thread.progress?.kind).toBe("estimate");
		expect(
			(thread.progress?.done ?? 0) / (thread.progress?.total ?? 1)
		).toBeCloseTo(0.75);
	});

	test("toInterfaceEvents keeps a persistent routine's thread for a failed run", () => {
		const [event] = toInterfaceEvents([
			{
				agentId: "coder",
				conversationId: "routine-chat",
				end: new Date(NOW - HOUR),
				error: "disk full",
				id: "f",
				jobId: "job-nightly",
				jobName: "Nightly backup",
				kind: "past",
				outcome: "failure",
				requireApproval: true,
				runId: null,
				scheduleLabel: "Daily at 4 AM",
				start: new Date(NOW - HOUR - MINUTE),
			},
		]);
		expect(event).toMatchObject({
			error: "disk full",
			jobId: "job-nightly",
			requiresApproval: true,
			threadId: "routine-chat",
		});
	});

	const failure: InterfaceEvent = {
		agentId: "coder",
		end: iso(NOW - 2 * HOUR + 5 * MINUTE),
		error: "source down",
		id: "fail",
		jobId: "job-digest",
		kind: "past",
		label: null,
		outcome: "failure",
		start: iso(NOW - 2 * HOUR),
		threadId: null,
		title: "Daily digest",
	};
	const orphan = conversation("agentrun_1", {
		agentId: "coder",
		createdAt: NOW - 2 * HOUR + 1000,
		runStatus: "failed",
		title: "Daily digest",
		updatedAt: NOW - 2 * HOUR + 5 * MINUTE,
	});

	test("linkOrphanRuns links exactly one matching per-firing conversation", () => {
		expect(linkOrphanRuns([failure], [orphan])[0]?.threadId).toBe("agentrun_1");
		expect(linkOrphanRuns([failure], [])[0]?.threadId).toBeNull();
		expect(
			linkOrphanRuns([failure], [orphan, { ...orphan, id: "agentrun_2" }])[0]
				?.threadId
		).toBeNull();
		expect(
			linkOrphanRuns([failure], [{ ...orphan, title: "Other" }])[0]?.threadId
		).toBeNull();
		expect(
			linkOrphanRuns([failure], [{ ...orphan, createdAt: NOW - 3 * HOUR }])[0]
				?.threadId
		).toBeNull();
	});

	test("a linked failure replaces Run failed; a newer success clears it", () => {
		const failed = liveSnapshot([orphan], {}, { events: [failure] });
		expect(threadOf(failed, "agentrun_1")?.blocker).toEqual({
			at: failure.end,
			detail: "source down",
			kind: "schedule-failed",
			source: "schedule",
			title: "Daily digest failed",
		});
		const acts = agentActs(failed, NOW);
		expect(acts.get("coder")?.act).toBe("blocked");
		const cleared = liveSnapshot(
			[orphan],
			{},
			{
				events: [
					failure,
					{
						...failure,
						end: iso(NOW - HOUR + MINUTE),
						id: "ok",
						outcome: "success",
						start: iso(NOW - HOUR),
						threadId: null,
					},
				],
			}
		);
		expect(threadOf(cleared, "agentrun_1")?.blocker?.kind).toBe("error");
	});

	test("event thread ids that are not snapshot threads are dropped", () => {
		const snap = liveSnapshot(
			[],
			{},
			{
				events: [{ ...failure, outcome: "success", threadId: "agentrun_gone" }],
			}
		);
		expect(snap.events?.[0]?.threadId).toBeNull();
	});
});

describe("privacy (test 8)", () => {
	test("redacted snapshots carry no titles, messages, ask text, routine names or errors", () => {
		const snap = liveSnapshot(
			[
				conversation("secret-thread", {
					agentId: "coder",
					folderPath: "/work/secret-repo",
					branch: "main",
					lastMessage: "secret message body",
					lastMessageRole: "assistant",
					runStatus: "completed",
					title: "Nightly backup",
				}),
			],
			{
				approvals: [
					approval({
						action: {
							arguments: { command: "secret-deploy.sh" },
							configure_approved: false,
							profile_ids: [],
							tool_id: "shell.run",
							type: "tool_call",
						},
						id: "s",
						question: "Can I run the secret thing?",
						summary: "secret reason",
					}),
				],
				privacy: "redacted",
				unread: new Map([["secret-thread", 1]]),
			},
			{
				events: [
					{
						agentId: "coder",
						end: iso(NOW - HOUR),
						error: "secret error",
						id: "e",
						jobId: "j",
						kind: "past",
						label: "Daily at 4 AM",
						outcome: "failure",
						start: iso(NOW - HOUR - MINUTE),
						threadId: "secret-thread",
						title: "Nightly backup",
					},
				],
			}
		);
		const text = JSON.stringify(snap);
		for (const secret of [
			"Nightly backup",
			"secret message body",
			"secret-repo",
			"Can I run the secret thing?",
			"secret reason",
			"secret-deploy.sh",
			"secret error",
			"Writes code",
			"Launch",
		]) {
			expect(text).not.toContain(secret);
		}
		expect(snap.privacy).toBe("redacted");
		expect(snap.asks?.map((ask) => ask.id).sort()).toEqual([
			"approval:s",
			"reply:secret-thread",
		]);
		expect(snap.events?.[0]?.label).toBe("Daily at 4 AM");
	});
});

// ---------------------------------------------------------------------------
// Phase 1b: limits, run starts, message detail
// ---------------------------------------------------------------------------

function usage(
	windows: UsageSnapshot["windows"],
	extra: Partial<UsageSnapshot> = {}
): UsageSnapshot {
	return {
		agentId: "a",
		available: true,
		engine: "acp",
		extraUsageUsd: null,
		meters: [],
		plan: null,
		reason: null,
		retryAfterSeconds: null,
		windows,
		...extra,
	};
}

const win = (
	label: string,
	model: string | null,
	usedPercent: number,
	extra: Partial<UsageSnapshot["windows"][number]> = {}
): UsageSnapshot["windows"][number] => ({
	label,
	model,
	resetsAt: "2026-10-16T15:10:00Z",
	usedPercent,
	windowSeconds: 604_800,
	...extra,
});

describe("limits (test 8)", () => {
	test("modelsMatch mirrors Core", () => {
		expect(modelsMatch("Opus", "claude-opus-4-1")).toBe(true);
		expect(modelsMatch("GPT-5.3-Codex-Spark", "gpt-5.3-codex-spark")).toBe(
			true
		);
		expect(modelsMatch("Opus", "claude-sonnet-4-5")).toBe(false);
		expect(modelsMatch("", "x")).toBe(false);
		expect(modelsMatch("x", null)).toBe(false);
		expect(modelsMatch("sonnet", "SONNET")).toBe(true);
	});

	test("per-model windows block only the matching model; unknown without a model", () => {
		const opus = usage([win("Weekly", null, 40), win("Opus", "Opus", 100)]);
		expect(chooseAgentLimit(opus, "claude-opus-4-1")).toMatchObject({
			blocked: true,
			label: "Opus",
			model: "Opus",
		});
		expect(chooseAgentLimit(opus, "claude-sonnet-4-5")).toMatchObject({
			blocked: false,
			label: "Weekly",
		});
		expect(chooseAgentLimit(opus, null)).toBeNull();
	});

	test("an account-wide window at 100% blocks every agent", () => {
		const weekly = usage([win("Weekly", null, 100)]);
		for (const model of [null, "anything"]) {
			expect(chooseAgentLimit(weekly, model)).toMatchObject({
				blocked: true,
				label: "Weekly",
				windowSeconds: 604_800,
			});
		}
	});

	test("a model that differs from its label is named in the label", () => {
		const spark = usage([win("Spark weekly", "GPT-5.3-Codex-Spark", 100)]);
		expect(chooseAgentLimit(spark, "gpt-5.3-codex-spark")?.label).toBe(
			"Spark weekly (GPT-5.3-Codex-Spark)"
		);
	});

	test("a throttled or unavailable probe is unknown, whatever retry_after says", () => {
		expect(
			chooseAgentLimit(
				usage([], {
					available: false,
					reason: "rate_limited",
					retryAfterSeconds: 60,
				}),
				"m"
			)
		).toBeNull();
		expect(chooseAgentLimit(null, "m")).toBeNull();
	});

	test("polled limits reach the snapshot; never-polled agents have none", () => {
		const snap = liveSnapshot([], {
			limits: new Map([
				[
					"coder",
					{
						blocked: true,
						label: "Weekly",
						model: null,
						resetsAt: null,
						usedPercent: 100,
					},
				],
			]),
		});
		expect(
			snap.agents.find((agent) => agent.id === "coder")?.limit?.blocked
		).toBe(true);
		expect(
			snap.agents.find((agent) => agent.id === "writer")
		).not.toHaveProperty("limit");
	});
});

describe("resolveRunStart (test 10a)", () => {
	const first = NOW;
	test("a fresh turn is exact", () => {
		expect(resolveRunStart(first - 2000, first, true)).toEqual({
			approx: false,
			startMs: first - 2000,
		});
	});
	test("a retry keeps the first sighting", () => {
		expect(resolveRunStart(first - 3 * HOUR, first, true)).toEqual({
			approx: true,
			startMs: first,
		});
	});
	test("an agent-to-agent turn keeps the first sighting", () => {
		expect(resolveRunStart(first - HOUR, first, true)?.approx).toBe(true);
		expect(resolveRunStart(null, first, true)).toEqual({
			approx: true,
			startMs: first,
		});
	});
	test("opened mid-run with no answer yet: the user message is exact", () => {
		expect(resolveRunStart(first - 20 * MINUTE, first, false)).toEqual({
			approx: false,
			startMs: first - 20 * MINUTE,
		});
	});
});

const emptyDetail: ThreadDetail = {
	activity: null,
	blocker: null,
	hasLaterAssistant: false,
	outcome: null,
	progress: null,
	progressMarks: {
		messageAt: null,
		partAt: null,
		turnMessageAt: null,
		turnPartAt: null,
	},
	questionAsks: [],
	userStart: null,
};

function entry(
	conversation: Conversation,
	detail: Partial<ThreadDetail>,
	status = conversation.runStatus
): InterfaceDetailEntry {
	return {
		detail: { ...emptyDetail, ...detail },
		hasOlder: false,
		readAt: NOW,
		revision: `${conversation.updatedAt}:${conversation.messageCount ?? conversation.messages.length}:${status ?? ""}`,
		status: "ready",
	};
}

function withDetail(
	conversations: Conversation[],
	entries: [Conversation, Partial<ThreadDetail>][],
	options: {
		live?: Partial<InterfaceLiveInput>;
		liveTabs?: Map<
			string,
			import("@/src/store/useInterfaceDetailStore.ts").LiveTabEntry
		>;
		runningWithinCap?: boolean;
		sweepComplete?: boolean;
	} = {}
) {
	return buildInterfaceSnapshot({
		agents,
		conversations,
		detail: {
			entries: new Map(entries.map(([c, d]) => [c.id, entry(c, d)])),
			live: options.liveTabs ?? new Map(),
			runningWithinCap: options.runningWithinCap ?? true,
			sweepComplete: options.sweepComplete ?? true,
		},
		live: liveInput(options.live),
		nowMs: NOW,
		teams,
	});
}

const questionAsk = (
	threadId: string,
	overrides: Partial<import("@ryuhq/protocol/interfaces").InterfaceAsk> = {}
) => ({
	ask: {
		agentId: "coder",
		blocking: true,
		expiresAt: iso(NOW + 7 * MINUTE),
		expiresApprox: true,
		holdsRun: true,
		id: "question:q1",
		kind: "question" as const,
		since: iso(NOW - 3 * MINUTE),
		source: "messages" as const,
		text: "Which DB to use?",
		threadId,
		...overrides,
	},
	holderId: threadId,
	toolCallId: "q1",
});

describe("message detail in the snapshot (tests 8, 10b)", () => {
	const running = conversation("run", {
		agentId: "coder",
		messageCount: 3,
		runStatus: "running",
	});

	test("a blocking question shows only while its thread runs and before its deadline", () => {
		const live = withDetail(
			[running],
			[[running, { questionAsks: [questionAsk("run")] }]]
		);
		expect(live.asks?.map((ask) => ask.id)).toEqual(["question:q1"]);
		const done = { ...running, runStatus: "completed" };
		const stopped = withDetail(
			[done],
			[[done, { questionAsks: [questionAsk("run")] }]]
		);
		expect(stopped.asks?.some((ask) => ask.kind === "question")).toBe(false);
		const expired = withDetail(
			[running],
			[
				[
					running,
					{ questionAsks: [questionAsk("run", { expiresAt: iso(NOW - 1) })] },
				],
			]
		);
		expect(expired.asks?.some((ask) => ask.kind === "question")).toBe(false);
		const deferred = withDetail(
			[done],
			[
				[
					done,
					{
						questionAsks: [
							questionAsk("run", {
								blocking: false,
								expiresAt: null,
								holdsRun: false,
							}),
						],
					},
				],
			]
		);
		expect(deferred.asks?.map((ask) => ask.id)).toEqual(["question:q1"]);
	});

	test("a running helper's question surfaces on its parent; a finished helper's does not", () => {
		const parent = conversation("main", {
			agentId: "coder",
			runStatus: "completed",
		});
		const helper = conversation("helper", {
			hierarchy: { role: "session", spawnedByConversationId: "main" },
			messageCount: 2,
			runStatus: "running",
		});
		const lifted = questionAsk("main");
		const snap = withDetail(
			[parent, helper],
			[[helper, { questionAsks: [lifted] }]]
		);
		expect(snap.asks?.find((ask) => ask.kind === "question")?.threadId).toBe(
			"main"
		);
		const finished = { ...helper, runStatus: "completed" };
		const none = withDetail(
			[parent, finished],
			[[finished, { questionAsks: [lifted] }]]
		);
		expect(none.asks?.some((ask) => ask.kind === "question")).toBe(false);
	});

	test("a live permission entry shows while running and before expiry", () => {
		const permission = {
			agentId: "coder",
			blocking: true,
			expiresAt: iso(NOW + 3 * MINUTE),
			expiresApprox: true,
			holdsRun: true,
			id: "permission:req-1",
			kind: "permission" as const,
			since: iso(NOW - 7 * MINUTE),
			sinceApprox: true,
			source: "live-tab" as const,
			text: "Allow Edit deploy.sh?",
			threadId: "run",
		};
		const tabs = (ask: typeof permission) =>
			new Map([
				[
					"run",
					{ permission: { ask, respond: () => undefined }, threadId: "run" },
				],
			]);
		expect(
			withDetail([running], [], { liveTabs: tabs(permission) }).asks?.map(
				(ask) => ask.id
			)
		).toEqual(["permission:req-1"]);
		expect(
			withDetail([running], [], {
				liveTabs: tabs({ ...permission, expiresAt: iso(NOW - 1) }),
			}).asks
		).toEqual([]);
		const done = { ...running, runStatus: "completed" };
		expect(withDetail([done], [], { liveTabs: tabs(permission) }).asks).toEqual(
			[]
		);
	});

	test("hydrated threads read as detail; their start resolves against first sighting", () => {
		const snap = withDetail(
			[running],
			[
				[
					running,
					{
						hasLaterAssistant: true,
						progressMarks: {
							messageAt: null,
							partAt: NOW - MINUTE,
							turnMessageAt: null,
							turnPartAt: NOW - MINUTE,
						},
						userStart: NOW - 12 * MINUTE,
					},
				],
			],
			{
				live: {
					firstSeenRunning: new Map([["run", NOW - 11 * MINUTE - 58_000]]),
				},
			}
		);
		expect(threadOf(snap, "run")).toMatchObject({
			detail: "detail",
			lastProgressAt: iso(NOW - MINUTE),
			runStartedApprox: false,
			runStartedAt: iso(NOW - 12 * MINUTE),
		});
	});

	test("a saved reason replaces the summary blocker of a failed run", () => {
		const failed = conversation("f", { agentId: "coder", runStatus: "failed" });
		const blocker = {
			at: iso(NOW - 20 * MINUTE),
			kind: "command-failed" as const,
			source: "messages" as const,
			title: "Tests failed",
		};
		const snap = withDetail([failed], [[failed, { blocker }]]);
		expect(threadOf(snap, "f")?.blocker).toEqual(blocker);
		const ok = { ...failed, runStatus: "completed" };
		expect(
			threadOf(withDetail([ok], [[ok, { blocker }]]), "f")?.blocker
		).toBeUndefined();
	});

	test("limit precedence: a saved generic error inside the window becomes a likely limit", () => {
		const failed = conversation("f", { agentId: "coder", runStatus: "failed" });
		const limit = {
			blocked: true,
			label: "Weekly",
			model: null,
			resetsAt: iso(NOW + 5 * HOUR),
			usedPercent: 100,
			windowSeconds: 604_800,
		};
		const error = (at: string | null) => ({
			at,
			atApprox: true,
			detail: "upstream said no",
			kind: "error" as const,
			source: "messages" as const,
			title: "Agent error",
		});
		const inside = withDetail(
			[failed],
			[[failed, { blocker: error(iso(NOW - HOUR)) }]],
			{
				live: { limits: new Map([["coder", limit]]) },
			}
		);
		expect(threadOf(inside, "f")?.blocker).toMatchObject({
			at: iso(NOW - HOUR),
			atApprox: true,
			clearsAt: limit.resetsAt,
			detail: "upstream said no",
			kind: "rate-limited",
			source: "estimate",
		});
		expect(agentActs(inside, NOW).get("coder")?.act).toBe("limited");
		for (const variant of [
			{ at: iso(NOW + 5 * HOUR - 604_800_000 - 1), windowSeconds: 604_800 },
			{ at: null, windowSeconds: 604_800 },
			{ at: iso(NOW - HOUR), windowSeconds: null },
		]) {
			// Unread keeps the week-old failure counted, so only precedence decides.
			const snap = withDetail(
				[failed],
				[[failed, { blocker: error(variant.at) }]],
				{
					live: {
						limits: new Map([
							["coder", { ...limit, windowSeconds: variant.windowSeconds }],
						]),
						unread: new Map([["f", 1]]),
					},
				}
			);
			expect(threadOf(snap, "f")?.blocker?.kind).toBe("error");
			expect(agentActs(snap, NOW).get("coder")?.act).toBe("blocked");
		}
		const idle = conversation("i", {
			agentId: "coder",
			runStatus: "completed",
		});
		const usageOnly = withDetail([idle], [], {
			live: { limits: new Map([["coder", limit]]) },
		});
		expect(threadOf(usageOnly, "i")?.blocker).toEqual({
			at: null,
			clearsAt: limit.resetsAt,
			kind: "rate-limited",
			source: "usage",
			title: "Limit hit",
		});
	});

	test("the outcome headline names the reply and the exact end time is kept", () => {
		const done = conversation("d", {
			agentId: "coder",
			lastMessage: "long answer text",
			lastMessageRole: "assistant",
			runStatus: "completed",
		});
		const snap = withDetail(
			[done],
			[
				[
					done,
					{
						outcome: {
							failures: 0,
							filesChanged: 3,
							headline: "Edited 3 files",
							source: "messages",
						},
					},
				],
			],
			{
				live: {
					terminalSeen: new Map([
						["d", { approx: false, atMs: NOW - 40 * MINUTE }],
					]),
					unread: new Map([["d", 1]]),
				},
			}
		);
		expect(threadOf(snap, "d")?.outcome?.finishedAt).toBe(
			iso(NOW - 40 * MINUTE)
		);
		expect(snap.asks?.[0]).toMatchObject({
			id: "reply:d",
			text: "Edited 3 files",
		});
	});
});

describe("a retried run is not stalled by its previous turn (test 10a)", () => {
	test("first-seen start, approximate, and progress floored at that start", () => {
		const retried = conversation("r", {
			agentId: "coder",
			messageCount: 6,
			runStatus: "running",
		});
		const snap = withDetail(
			[retried],
			[
				[
					retried,
					{
						hasLaterAssistant: true,
						// The user message and every step belong to a turn 3 h ago.
						progressMarks: {
							messageAt: NOW - 3 * HOUR + MINUTE,
							partAt: NOW - 3 * HOUR + 2 * MINUTE,
							turnMessageAt: NOW - 3 * HOUR + MINUTE,
							turnPartAt: NOW - 3 * HOUR + 2 * MINUTE,
						},
						userStart: NOW - 3 * HOUR,
					},
				],
			],
			{ live: { firstSeenRunning: new Map([["r", NOW - MINUTE]]) } }
		);
		expect(threadOf(snap, "r")).toMatchObject({
			lastProgressAt: iso(NOW - MINUTE),
			runStartedApprox: true,
			runStartedAt: iso(NOW - MINUTE),
		});
		const act = agentActs(snap, NOW).get("coder");
		expect(act?.stalled).toBe(false);
		expect(act?.elapsed).toBeNull();
	});
});

describe("a main kept live only by a helper (review)", () => {
	test("is never stalled on its previous turn's marks", () => {
		const main = conversation("m", {
			agentId: "coder",
			messageCount: 4,
			runStatus: "completed",
		});
		const helper = conversation("h", {
			hierarchy: { role: "session", spawnedByConversationId: "m" },
			runStatus: "running",
		});
		const snap = withDetail(
			[main, helper],
			[
				[
					main,
					{
						progressMarks: {
							messageAt: NOW - 3 * HOUR,
							partAt: NOW - 3 * HOUR,
							turnMessageAt: NOW - 3 * HOUR,
							turnPartAt: NOW - 3 * HOUR,
						},
					},
				],
			]
		);
		const thread = threadOf(snap, "m");
		expect(thread?.running).toBe(true);
		expect(thread?.lastProgressAt).toBeUndefined();
		expect(agentActs(snap, NOW).get("coder")?.stalled).toBe(false);
	});
});

describe("stable thread references (§3.1)", () => {
	test("unchanged threads keep their object; a changed one is new", () => {
		const a = conversation("a", { agentId: "coder", runStatus: "completed" });
		const b = conversation("b", { agentId: "writer", runStatus: "completed" });
		const first = liveSnapshot([a, b]);
		const same = stabilizeSnapshot(first, liveSnapshot([a, b]));
		expect(same.threads).toBe(first.threads);
		const changed = stabilizeSnapshot(
			first,
			liveSnapshot([a, { ...b, runStatus: "failed" }])
		);
		expect(threadOf(changed, "a")).toBe(threadOf(first, "a"));
		expect(threadOf(changed, "b")).not.toBe(threadOf(first, "b"));
	});
});

describe("blind spots 1b (test 8)", () => {
	const main = conversation("m", {
		agentId: "coder",
		messageCount: 2,
		runStatus: "running",
	});
	const helper = conversation("h", {
		hierarchy: { role: "session", spawnedByConversationId: "m" },
		messageCount: 1,
		runStatus: "running",
	});

	test("question drops only with every running main and helper hydrated and the sweep done", () => {
		const covered = withDetail(
			[main, helper],
			[
				[main, {}],
				[helper, {}],
			]
		);
		expect(covered.askBlindSpots).toEqual(["permission", "input"]);
		expect(withDetail([main, helper], [[main, {}]]).askBlindSpots).toContain(
			"question"
		);
		expect(
			withDetail(
				[main, helper],
				[
					[main, {}],
					[helper, {}],
				],
				{ sweepComplete: false }
			).askBlindSpots
		).toContain("question");
		expect(
			withDetail(
				[main, helper],
				[
					[main, {}],
					[helper, {}],
				],
				{ runningWithinCap: false }
			).askBlindSpots
		).toContain("question");
		expect(withDetail([main], []).askBlindSpots).toContain("question");
		expect(threadOf(withDetail([main], []), "m")?.detail).toBe("summary");
	});
});

describe("review follow-ups (1a)", () => {
	test("a redacted snapshot redacts the account merged after it", () => {
		const snap = liveSnapshot([], { privacy: "redacted" });
		const merged = withInterfaceAccount(snap, {
			balance: 1,
			breakdown: null,
			currency: "usd",
			transactions: [
				{
					amount: -1,
					at: iso(NOW),
					balanceAfter: null,
					id: "tx",
					inputTokens: null,
					kind: "debit",
					label: "Secret task label",
					model: null,
					outputTokens: null,
					provider: null,
					threadId: null,
				},
			],
		});
		expect(merged.account?.transactions[0]?.label).toBe("Usage");
		expect(JSON.stringify(merged)).not.toContain("Secret task label");
		const full = withInterfaceAccount(liveSnapshot([]), merged.account);
		expect(full.account?.transactions[0]?.label).toBe("Usage");
	});

	test("a workspace needs a branch; a bare folder gives none", () => {
		const snap = liveSnapshot([
			conversation("w", {
				agentId: "coder",
				branch: "main",
				folderPath: "/x/repo",
			}),
			conversation("b", { agentId: "coder", folderPath: "/x/repo" }),
		]);
		expect(threadOf(snap, "w")?.workspace).toBe("repo@main");
		expect(threadOf(snap, "b")).not.toHaveProperty("workspace");
	});

	test("interrupted helpers are not failed, and a lifted parent has no summary blocker", () => {
		const snap = liveSnapshot([
			conversation("p", { agentId: "coder", runStatus: "failed" }),
			conversation("s1", {
				hierarchy: { role: "session", spawnedByConversationId: "p" },
				runStatus: "interrupted",
			}),
			conversation("s2", {
				hierarchy: { role: "session", spawnedByConversationId: "p" },
				runStatus: "running",
			}),
		]);
		expect(threadOf(snap, "p")).toMatchObject({
			helpers: { done: 0, failed: 0, running: 1 },
			running: true,
			runState: "running",
		});
		expect(threadOf(snap, "p")?.blocker).toBeUndefined();
	});

	test("capped events keep the newest runs, oldest first", () => {
		const events: CalendarEvent[] = Array.from({ length: 1005 }, (_, i) => ({
			id: `e${String(i).padStart(4, "0")}`,
			jobId: "j",
			jobName: "Job",
			kind: "past",
			scheduleLabel: "",
			start: new Date(NOW + i * MINUTE),
		}));
		const out = toInterfaceEvents(events);
		expect(out).toHaveLength(1000);
		expect(out[0]?.id).toBe("e0005");
		expect(out.at(-1)?.id).toBe("e1004");
	});
});
