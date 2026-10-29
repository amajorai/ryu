import { describe, expect, test } from "bun:test";
import {
	agentHandleText,
	EMPTY_BOARD_FILTER,
	type InterfaceSnapshot,
	type InterfaceThread,
	isBoardFilterEmpty,
	localDayKey,
	matchesBoardFilter,
	parseTerminalCommand,
	projectArena,
	projectBoard,
	projectContacts,
	projectDeskViews,
	projectGraph,
	projectInbox,
	projectTimeline,
	resolveAgentHandle,
	resolveInterfaceParams,
	threadStatus,
} from "./interfaces.ts";

function thread(
	overrides: Partial<InterfaceThread> & { id: string }
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: null,
		messageCount: 1,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: overrides.id,
		updatedAt: "2026-10-10T12:00:00.000Z",
		...overrides,
	};
}

const snapshot: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "",
			id: "atlas",
			name: "Atlas",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "",
			id: "forge",
			name: "Forge",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "",
			id: "quiet",
			name: "Quiet One",
			status: "idle",
		},
	],
	groups: [
		{
			id: "crew",
			kind: "team",
			memberAgentIds: ["atlas", "forge"],
			name: "Crew",
		},
		{ id: "site", kind: "project", memberAgentIds: [], name: "Site" },
	],
	threads: [
		thread({
			agentIds: ["forge"],
			id: "live",
			lastMessageRole: "user",
			running: true,
			runState: "running",
			updatedAt: "2026-10-12T09:00:00.000Z",
		}),
		thread({
			agentIds: ["atlas"],
			id: "answered",
			lastMessage: "Done, here is the plan.",
			lastMessageRole: "assistant",
			updatedAt: "2026-10-12T08:00:00.000Z",
		}),
		thread({
			agentIds: ["atlas", "forge"],
			id: "broken",
			lastMessageRole: "assistant",
			projectId: "site",
			runState: "failed",
			teamId: "crew",
			updatedAt: "2026-10-11T08:00:00.000Z",
		}),
		thread({
			agentIds: ["atlas"],
			id: "sent",
			lastMessageRole: "user",
			pinned: true,
			updatedAt: "2026-10-01T08:00:00.000Z",
		}),
		thread({ id: "orphan", updatedAt: "2026-10-09T08:00:00.000Z" }),
	],
	version: 1,
};

describe("thread status", () => {
	test("classifies by live run, failure, and who spoke last", () => {
		const byId = Object.fromEntries(
			snapshot.threads.map((item) => [item.id, threadStatus(item)])
		);
		expect(byId).toEqual({
			answered: "your-turn",
			broken: "attention",
			live: "working",
			orphan: "quiet",
			sent: "waiting",
		});
	});

	test("awaitingInput reads as your turn (Core sends it from Phase 2(a))", () => {
		expect(
			threadStatus(
				thread({ awaitingInput: true, id: "input", lastMessageRole: "user" })
			)
		).toBe("your-turn");
		expect(
			threadStatus(thread({ awaitingInput: true, id: "both", running: true }))
		).toBe("working");
	});

	test("params for the new layouts fall back safely", () => {
		expect(resolveInterfaceParams("board", { groupBy: "x" })).toEqual({
			groupBy: "status",
			view: "board",
		});
		expect(
			resolveInterfaceParams("board", { groupBy: "project", view: "list" })
		).toEqual({ groupBy: "project", view: "list" });
		expect(resolveInterfaceParams("timeline", { scale: "week" })).toEqual({
			scale: "week",
		});
		expect(resolveInterfaceParams("terminal", { evil: true })).toEqual({});
	});
});

describe("projectBoard and projectInbox", () => {
	test("status columns follow urgency; pinned first inside a column", () => {
		const columns = projectBoard(snapshot, { groupBy: "status" });
		expect(columns.map((column) => [column.status, column.threadIds])).toEqual([
			["attention", ["broken"]],
			["your-turn", ["answered"]],
			["working", ["live"]],
			["waiting", ["sent"]],
			["quiet", ["orphan"]],
		]);
		const noQuiet = projectBoard(
			{
				...snapshot,
				threads: snapshot.threads.filter((item) => item.id !== "orphan"),
			},
			{ groupBy: "status" }
		);
		expect(noQuiet.some((column) => column.status === "quiet")).toBe(false);
	});

	test("agent columns include idle agents and an Unassigned column", () => {
		const columns = projectBoard(snapshot, { groupBy: "agent" });
		expect(columns.map((column) => [column.label, column.threadIds])).toEqual([
			["Atlas", ["sent", "answered", "broken"]],
			["Forge", ["live"]],
			["Quiet One", []],
			["Unassigned", ["orphan"]],
		]);
	});

	test("project columns include every project and a No project column", () => {
		const columns = projectBoard(snapshot, { groupBy: "project" });
		expect(
			columns.map((column) => [column.label, column.groupId, column.threadIds])
		).toEqual([
			["Site", "site", ["broken"]],
			["No project", null, ["sent", "live", "answered", "orphan"]],
		]);
	});

	test("filters narrow every grouping; a status filter keeps its columns", () => {
		const byStatus = projectBoard(snapshot, {
			filter: { agentIds: [], groupIds: [], statuses: ["quiet", "working"] },
			groupBy: "status",
		});
		expect(byStatus.map((column) => [column.status, column.threadIds])).toEqual(
			[
				["working", ["live"]],
				["quiet", ["orphan"]],
			]
		);
		const forgeInCrew = projectBoard(snapshot, {
			filter: { agentIds: ["forge"], groupIds: ["crew"], statuses: [] },
			groupBy: "agent",
		});
		expect(forgeInCrew.flatMap((column) => column.threadIds).sort()).toEqual([
			"broken",
		]);
		expect(isBoardFilterEmpty(EMPTY_BOARD_FILTER)).toBe(true);
		expect(
			matchesBoardFilter(snapshot.threads[0] as InterfaceThread, {
				...EMPTY_BOARD_FILTER,
				groupIds: ["site"],
			})
		).toBe(false);
	});

	test("inbox omits empty sections", () => {
		expect(projectInbox(snapshot).map((section) => section.id)).toEqual([
			"attention",
			"your-turn",
			"working",
			"waiting",
			"quiet",
		]);
		expect(projectInbox({ ...snapshot, threads: [] })).toEqual([]);
	});
});

describe("projectGraph", () => {
	test("hub, agent ring, group ring, and collaboration edges", () => {
		const graph = projectGraph(snapshot);
		expect(graph.nodes[0]).toMatchObject({
			id: "you",
			status: "working",
			x: 0,
			y: 0,
		});
		expect(graph.nodes.filter((node) => node.kind === "agent")).toHaveLength(3);
		const edgeIds = graph.edges.map((edge) => edge.id);
		expect(edgeIds).toContain("talks:atlas");
		expect(edgeIds).not.toContain("talks:quiet");
		expect(edgeIds).toContain("member:team:crew:forge");
		expect(edgeIds).toContain("member:project:site:atlas");
		expect(edgeIds).toContain("collaborates:atlas|forge");
		expect(projectGraph(snapshot)).toEqual(graph);
		const ids = new Set(graph.nodes.map((node) => node.id));
		for (const edge of graph.edges) {
			expect(ids.has(edge.source) && ids.has(edge.target)).toBe(true);
		}
	});
});

describe("projectTimeline", () => {
	const now = new Date(2026, 9, 12, 18, 0);

	test("day scale lists active days newest first", () => {
		const days = projectTimeline(snapshot, { scale: "day" }, now).days;
		expect(days.map((day) => day.key)).toEqual(
			[...days.map((day) => day.key)].sort((a, b) => b.localeCompare(a))
		);
		expect(days.flatMap((day) => day.threadIds).sort()).toEqual(
			snapshot.threads.map((item) => item.id).sort()
		);
	});

	test("week scale has seven days ending today and counts older threads", () => {
		const week = projectTimeline(snapshot, { scale: "week" }, now);
		expect(week.days).toHaveLength(7);
		expect(week.days.at(-1)?.key).toBe(localDayKey(now));
		expect(week.earlierCount).toBe(1);
	});
});

describe("projectArena and projectContacts", () => {
	test("arena puts working agents first and focuses the live thread", () => {
		const cards = projectArena(snapshot);
		expect(cards.map((card) => card.agentId)).toEqual([
			"forge",
			"atlas",
			"quiet",
		]);
		expect(cards[0]?.focusThreadId).toBe("live");
		expect(cards[1]?.counts).toMatchObject({
			attention: 1,
			waiting: 1,
			"your-turn": 1,
		});
		expect(cards[2]?.focusThreadId).toBeNull();
	});

	test("a parent whose running was lifted from a helper sorts first and counts as working", () => {
		const lifted: InterfaceSnapshot = {
			...snapshot,
			agents: [
				...snapshot.agents.filter((agent) => agent.id !== "quiet"),
				{
					avatarUrl: null,
					description: "",
					id: "quiet",
					name: "Quiet",
					status: "working",
				},
			],
			threads: [
				...snapshot.threads,
				thread({
					agentIds: ["quiet"],
					helpers: { done: 0, failed: 0, running: 1, titles: ["Helper"] },
					id: "parent",
					lastMessageRole: "assistant",
					running: true,
					updatedAt: "2026-10-01T00:00:00.000Z",
				}),
			],
		};
		const cards = projectArena(lifted);
		// Working agents lead the wall; Quiet now sorts with them, ahead of idle Atlas.
		expect(cards.map((card) => card.agentId)).toEqual([
			"forge",
			"quiet",
			"atlas",
		]);
		expect(cards.find((card) => card.agentId === "quiet")?.counts.working).toBe(
			1
		);
		expect(cards.find((card) => card.agentId === "quiet")?.focusThreadId).toBe(
			"parent"
		);
	});

	test("contacts sort by last conversation and count unread replies", () => {
		const contacts = projectContacts(snapshot);
		expect(contacts.map((contact) => contact.agentId)).toEqual([
			"forge",
			"atlas",
			"quiet",
		]);
		expect(contacts[1]).toMatchObject({
			lastMessage: "Done, here is the plan.",
			lastThreadId: "answered",
			unread: 1,
		});
		expect(contacts[2]?.lastThreadId).toBeNull();
	});
});

describe("terminal", () => {
	test("parses the command language", () => {
		expect(parseTerminalCommand("  ")).toEqual({ kind: "empty" });
		expect(parseTerminalCommand("ls")).toEqual({ filter: "all", kind: "list" });
		expect(parseTerminalCommand("ls running")).toEqual({
			filter: "working",
			kind: "list",
		});
		expect(parseTerminalCommand("ls nonsense").kind).toBe("unknown");
		expect(parseTerminalCommand("open 3")).toEqual({
			kind: "open",
			target: "3",
		});
		expect(parseTerminalCommand("open").kind).toBe("unknown");
		expect(parseTerminalCommand("new @atlas ship it")).toEqual({
			agentHandle: "atlas",
			kind: "new",
			prompt: "ship it",
		});
		expect(parseTerminalCommand("@forge  fix the build")).toEqual({
			agentHandle: "forge",
			kind: "new",
			prompt: "fix the build",
		});
		expect(parseTerminalCommand("new just do it")).toEqual({
			agentHandle: null,
			kind: "new",
			prompt: "just do it",
		});
		expect(parseTerminalCommand("EXIT")).toEqual({ kind: "close" });
		expect(parseTerminalCommand("rm -rf /")).toEqual({
			input: "rm -rf /",
			kind: "unknown",
		});
	});

	test("resolves @handles by name or id", () => {
		expect(resolveAgentHandle(snapshot, "@quietone")?.id).toBe("quiet");
		expect(resolveAgentHandle(snapshot, "Quiet-One")?.id).toBe("quiet");
		expect(resolveAgentHandle(snapshot, "forge")?.id).toBe("forge");
		expect(resolveAgentHandle(snapshot, "@")).toBeUndefined();
		expect(resolveAgentHandle(snapshot, "nobody")).toBeUndefined();
	});

	test("every displayed handle resolves back to its agent", () => {
		const longName = "Quarterly Revenue Forecasting Assistant";
		const [base] = snapshot.agents;
		if (!base) {
			throw new Error("The fixture has no agent");
		}
		const named = {
			...snapshot,
			agents: [
				{ ...base, id: "agent-long", name: longName },
				{ ...base, id: "agent-cjk", name: "研究者" },
			],
		};
		const shownLong = agentHandleText(longName);
		expect(shownLong).toHaveLength(24);
		expect(resolveAgentHandle(named, `@${shownLong}`)?.id).toBe("agent-long");
		expect(agentHandleText("研究者")).toBe("agent");
		expect(resolveAgentHandle(named, "@agent")?.id).toBe("agent-cjk");
		// The untruncated name and the id keep working.
		expect(resolveAgentHandle(named, longName)?.id).toBe("agent-long");
		expect(resolveAgentHandle(named, "agent-cjk")?.id).toBe("agent-cjk");
	});
});

describe("projectDeskViews", () => {
	test("shared views, an inbox per agent, and team/project views", () => {
		const sections = projectDeskViews(snapshot);
		expect(sections.map((section) => section.id)).toEqual([
			"views",
			"inboxes",
			"groups",
		]);
		const view = (id: string) =>
			sections
				.flatMap((section) => section.views)
				.find((item) => item.id === id);
		expect(view("all")?.threadIds[0]).toBe("sent");
		expect(view("needs-you")?.threadIds).toEqual(["answered", "broken"]);
		expect(view("working")?.threadIds).toEqual(["live"]);
		expect(view("waiting")?.threadIds).toEqual(["sent"]);
		expect(view("pinned")?.threadIds).toEqual(["sent"]);
		expect(view("agent:quiet")?.threadIds).toEqual([]);
		expect(view("team:crew")?.threadIds).toEqual(["broken"]);
		expect(view("project:site")?.threadIds).toEqual(["broken"]);
		expect(
			projectDeskViews({ ...snapshot, groups: [] }).map((section) => section.id)
		).toEqual(["views", "inboxes"]);
	});
});
