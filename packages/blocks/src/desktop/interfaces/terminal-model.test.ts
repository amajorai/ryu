import { describe, expect, test } from "bun:test";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfaceSnapshot,
	type InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import {
	completeInput,
	listAgents,
	listThreads,
	promptPath,
	resolveOpenTarget,
	resolveStartTarget,
	statusChanges,
	statusMap,
	terminalCounts,
} from "./terminal-model.ts";

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: ["agent-atlas"],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: `Thread ${input.id}`,
		updatedAt: "2026-10-12T10:00:00Z",
		...input,
	};
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Research",
			id: "agent-atlas",
			name: "Atlas",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Builds",
			id: "agent-forge",
			name: "Forge",
			status: "working",
		},
	],
	groups: [
		{
			id: "team-launch",
			kind: "team",
			memberAgentIds: ["agent-atlas"],
			name: "Launch Crew",
		},
	],
	threads: [
		thread({ id: "t-reply", updatedAt: "2026-10-12T09:00:00Z" }),
		thread({
			agentIds: ["agent-forge"],
			id: "t-run",
			running: true,
			updatedAt: "2026-10-12T11:00:00Z",
		}),
		thread({ id: "t-fail", runState: "failed" }),
		thread({ agentIds: [], id: "t-mine", lastMessageRole: "user" }),
	],
	version: INTERFACE_PROTOCOL_VERSION,
};

describe("terminal model", () => {
	test("lists threads most urgent first, numbered from 1", () => {
		const rows = listThreads(SNAPSHOT, "all");
		expect(rows.map((row) => [row.number, row.threadId, row.status])).toEqual([
			[1, "t-fail", "attention"],
			[2, "t-reply", "your-turn"],
			[3, "t-run", "working"],
			[4, "t-mine", "waiting"],
		]);
		expect(rows[3]?.agentLabel).toBe("-");
		expect(listThreads(SNAPSHOT, "working").map((row) => row.threadId)).toEqual(
			["t-run"]
		);
	});

	test("counts working threads and threads that need you", () => {
		expect(terminalCounts(SNAPSHOT)).toEqual({
			agents: 2,
			attention: 1,
			needsYou: 2,
			threads: 4,
			working: 1,
		});
		expect(
			listAgents(SNAPSHOT).map((row) => [row.handle, row.needsYou])
		).toEqual([
			["@atlas", 2],
			["@forge", 0],
		]);
	});

	test("open resolves list numbers against the last listing, ids, and prefixes", () => {
		expect(resolveOpenTarget(SNAPSHOT, "2", null)).toEqual({
			kind: "found",
			number: 2,
			threadId: "t-reply",
		});
		expect(resolveOpenTarget(SNAPSHOT, "1", ["t-run"])).toEqual({
			kind: "found",
			number: 1,
			threadId: "t-run",
		});
		expect(resolveOpenTarget(SNAPSHOT, "t-mine", null).kind).toBe("found");
		expect(resolveOpenTarget(SNAPSHOT, "t-r", null).kind).toBe("missing");
		expect(resolveOpenTarget(SNAPSHOT, "9", null).kind).toBe("missing");
	});

	test("an open miss counts threads in the right number", () => {
		const one: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [thread({ id: "t-only" })],
		};
		expect(resolveOpenTarget(one, "9", null)).toMatchObject({
			hint: "1 thread · ls to refresh",
			kind: "missing",
		});
		expect(resolveOpenTarget(SNAPSHOT, "9", null)).toMatchObject({
			hint: "4 threads · ls to refresh",
		});
		expect(resolveOpenTarget(SNAPSHOT, "9", ["t-run"])).toMatchObject({
			hint: "1 in the last listing · ls to refresh",
		});
	});

	test("new addresses agents, then teams, and suggests close handles", () => {
		expect(resolveStartTarget(SNAPSHOT, "ATLAS")).toMatchObject({
			kind: "agent",
		});
		expect(resolveStartTarget(SNAPSHOT, "launch-crew")).toMatchObject({
			kind: "group",
		});
		expect(resolveStartTarget(SNAPSHOT, null)).toEqual({ kind: "none" });
		expect(resolveStartTarget(SNAPSHOT, "forj")).toEqual({
			close: true,
			kind: "unknown",
			suggestions: ["@forge"],
		});
		expect(resolveStartTarget(SNAPSHOT, "zeus")).toMatchObject({
			close: false,
			kind: "unknown",
		});
	});

	test("tab completes verbs, ls filters, and handles", () => {
		expect(completeInput(SNAPSHOT, "ag").value).toBe("agents ");
		expect(completeInput(SNAPSHOT, "ls wo").value).toBe("ls working ");
		expect(completeInput(SNAPSHOT, "new @f").value).toBe("new @forge ");
		expect(completeInput(SNAPSHOT, "cl")).toEqual({
			candidates: ["close", "clear"],
			value: "cl",
		});
		expect(completeInput(SNAPSHOT, "xyz").value).toBe("xyz");
	});

	test("prompt path cuts long titles at a word boundary", () => {
		expect(promptPath(undefined)).toBe("~");
		expect(
			promptPath(
				thread({ id: "a", title: "Pick a palette for the marketing site" })
			)
		).toBe("~/pick-a-palette-for-the");
	});

	test("reports status changes between snapshots", () => {
		const before = statusMap(SNAPSHOT);
		const after: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: SNAPSHOT.threads.map((item) =>
				item.id === "t-run" ? { ...item, running: false } : item
			),
		};
		expect(
			statusChanges(before, after).map(({ status, thread: changed }) => [
				changed.id,
				status,
			])
		).toEqual([["t-run", "your-turn"]]);
	});
});
