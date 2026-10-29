// apps/desktop/src/lib/mission-control/turn-groups.test.ts
//
// Tests for the Mission Control digest. The load-bearing behaviours are: turn
// SPLITTING (a user message opens a turn, every assistant message until the
// next one belongs to it), the prose SPLIT at the first tool call (rationale
// before / outcome after, and answer-only turns are all outcome), write-beats-
// read path ranking, terminal-state driven status, and the newest-snapshot-wins
// rule for todos — the last of which is what makes the dashboard's "what's
// left" honest rather than a pile of stale plans.

import { describe, expect, it } from "bun:test";
import {
	buildMissionDigest,
	firstString,
	type MissionRawInput,
	type MissionStreamMessage,
	type MissionStreamPart,
	toolNameOf,
} from "./turn-groups.ts";

const text = (body: string): MissionStreamPart => ({
	type: "text",
	text: body,
});

const tool = (
	name: string,
	input: MissionRawInput,
	state = "output-available"
): MissionStreamPart => ({
	type: `tool-${name}`,
	toolCallId: `${name}-${Math.abs(JSON.stringify(input ?? "").length)}`,
	input,
	state,
});

const user = (body: string): MissionStreamMessage => ({
	id: `u-${body.slice(0, 8)}`,
	role: "user",
	parts: [text(body)],
});

const assistant = (
	id: string,
	parts: MissionStreamPart[]
): MissionStreamMessage => ({ id, role: "assistant", parts });

describe("buildMissionDigest — turn splitting", () => {
	it("opens a turn per user message and folds every reply into it", () => {
		const digest = buildMissionDigest([
			user("add auth"),
			assistant("a1", [
				text("Starting."),
				tool("Write", { file_path: "/a.ts" }),
			]),
			assistant("a2", [tool("Bash", { command: "bun test" }), text("Green.")]),
			user("now the docs"),
			assistant("a3", [tool("Edit", { file_path: "/README.md" })]),
		]);

		expect(digest.turns).toHaveLength(2);
		expect(digest.turns[0].request).toBe("add auth");
		expect(digest.turns[0].messageIds).toEqual(["u-add auth", "a1", "a2"]);
		expect(digest.turns[0].index).toBe(1);
		expect(digest.turns[1].request).toBe("now the docs");
		expect(digest.turns[1].index).toBe(2);
	});

	it("opens an unprompted turn for assistant output with no user message", () => {
		const digest = buildMissionDigest([
			assistant("a1", [text("Resumed and finished the migration.")]),
		]);

		expect(digest.turns).toHaveLength(1);
		expect(digest.turns[0].request).toBe("");
		expect(digest.turns[0].outcome).toBe("Resumed and finished the migration.");
	});

	it("drops turns that produced nothing, and renumbers what remains", () => {
		const digest = buildMissionDigest([
			user("hello"),
			assistant("a1", []),
			user("do the thing"),
			assistant("a2", [tool("Write", { file_path: "/x.ts" })]),
		]);

		expect(digest.turns).toHaveLength(1);
		expect(digest.turns[0].index).toBe(1);
		expect(digest.turns[0].request).toBe("do the thing");
	});
});

describe("buildMissionDigest — rationale vs outcome", () => {
	it("splits assistant prose at the first tool call", () => {
		const digest = buildMissionDigest([
			user("fix the bug"),
			assistant("a1", [
				text("The expiry check uses < instead of <=, so I'll patch it."),
				tool("Edit", { file_path: "/auth.ts" }),
				text("Patched and the suite is green."),
			]),
		]);

		const turn = digest.turns[0];
		expect(turn.rationale).toBe(
			"The expiry check uses < instead of <=, so I'll patch it."
		);
		expect(turn.outcome).toBe("Patched and the suite is green.");
	});

	it("treats a turn with no tool calls as pure answer, not rationale", () => {
		const digest = buildMissionDigest([
			user("what is a connection pool?"),
			assistant("a1", [text("It reuses open DB connections.")]),
		]);

		expect(digest.turns[0].rationale).toBe("");
		expect(digest.turns[0].outcome).toBe("It reuses open DB connections.");
	});

	it("collects reasoning parts separately from the answer text", () => {
		const digest = buildMissionDigest([
			user("why?"),
			assistant("a1", [
				{ type: "reasoning", text: "Considered two approaches." },
				text("Because of B."),
			]),
		]);

		expect(digest.turns[0].thinking).toBe("Considered two approaches.");
		expect(digest.turns[0].outcome).toBe("Because of B.");
	});
});

describe("buildMissionDigest — file touches", () => {
	it("ranks a write above a read for the same path and counts both", () => {
		const digest = buildMissionDigest([
			user("go"),
			assistant("a1", [
				tool("Read", { file_path: "/src/auth.ts" }),
				tool("Edit", { file_path: "/src/auth.ts" }),
			]),
		]);

		expect(digest.turns[0].files).toEqual([
			{ path: "/src/auth.ts", kind: "edit", count: 2 },
		]);
	});

	it("keeps create above edit above read when rolling up the conversation", () => {
		const digest = buildMissionDigest([
			user("go"),
			assistant("a1", [
				tool("Read", { file_path: "/r.ts" }),
				tool("Edit", { file_path: "/e.ts" }),
				tool("Write", { file_path: "/c.ts" }),
			]),
		]);

		expect(digest.files.map((f) => f.kind)).toEqual(["create", "edit", "read"]);
		expect(digest.totals.filesTouched).toBe(3);
		expect(digest.totals.writes).toBe(2);
	});

	it("reads the notebook and camelCase path keys too", () => {
		const digest = buildMissionDigest([
			user("go"),
			assistant("a1", [
				tool("NotebookEdit", { notebook_path: "/nb.ipynb" }),
				tool("Write", { filePath: "/camel.ts" }),
			]),
		]);

		expect(digest.files.map((f) => f.path).sort()).toEqual([
			"/camel.ts",
			"/nb.ipynb",
		]);
	});
});

describe("buildMissionDigest — status", () => {
	it("is failed when any tool call ended in error", () => {
		const digest = buildMissionDigest([
			user("go"),
			assistant("a1", [tool("Bash", { command: "bun test" }, "output-error")]),
		]);

		expect(digest.turns[0].status).toBe("failed");
		expect(digest.turns[0].shellCommands[0].failed).toBe(true);
		expect(digest.totals.failures).toBe(1);
	});

	it("is running while a tool call has no terminal frame", () => {
		const digest = buildMissionDigest([
			user("go"),
			assistant("a1", [
				tool("Bash", { command: "sleep 5" }, "input-available"),
			]),
		]);

		expect(digest.turns[0].status).toBe("running");
	});

	it("is ok when every call completed", () => {
		const digest = buildMissionDigest([
			user("go"),
			assistant("a1", [tool("Bash", { command: "ls" })]),
		]);

		expect(digest.turns[0].status).toBe("ok");
	});
});

describe("buildMissionDigest — todos", () => {
	it("uses the newest snapshot, not the union of every snapshot", () => {
		const digest = buildMissionDigest([
			user("go"),
			assistant("a1", [
				tool("TodoWrite", {
					todos: [
						{ content: "step one", status: "pending" },
						{ content: "step two", status: "pending" },
					],
				}),
			]),
			user("continue"),
			assistant("a2", [
				tool("TodoWrite", {
					todos: [
						{ content: "step one", status: "completed" },
						{ content: "step two", status: "in_progress" },
					],
				}),
			]),
		]);

		expect(digest.openTodos.map((t) => t.content)).toEqual(["step two"]);
		expect(digest.doneTodos.map((t) => t.content)).toEqual(["step one"]);
	});

	it("defaults an unrecognised status to pending rather than dropping the item", () => {
		const digest = buildMissionDigest([
			user("go"),
			assistant("a1", [
				tool("TodoWrite", { todos: [{ content: "x", status: "wat" }] }),
			]),
		]);

		expect(digest.openTodos).toEqual([{ content: "x", status: "pending" }]);
	});
});

describe("buildMissionDigest — headlines", () => {
	it("names the changed files, abbreviating past two", () => {
		const digest = buildMissionDigest([
			user("go"),
			assistant("a1", [
				tool("Edit", { file_path: "/src/a.ts" }),
				tool("Edit", { file_path: "/src/b.ts" }),
				tool("Edit", { file_path: "/src/c.ts" }),
			]),
		]);

		expect(digest.turns[0].headline).toBe("Changed a.ts, b.ts +1 more");
	});

	it("says Created when every write made a new file", () => {
		const digest = buildMissionDigest([
			user("go"),
			assistant("a1", [tool("Write", { file_path: "/src/new.ts" })]),
		]);

		expect(digest.turns[0].headline).toBe("Created new.ts");
	});

	it("falls back through commands, investigation and plain answers", () => {
		const ran = buildMissionDigest([
			user("go"),
			assistant("a1", [tool("Bash", { command: "ls" })]),
		]);
		const looked = buildMissionDigest([
			user("go"),
			assistant("a2", [tool("Grep", { pattern: "TODO" })]),
		]);
		const said = buildMissionDigest([
			user("go"),
			assistant("a3", [text("Hi.")]),
		]);

		expect(ran.turns[0].headline).toBe("ran 1 command");
		expect(looked.turns[0].headline).toBe("Investigated");
		expect(said.turns[0].headline).toBe("Answered");
	});
});

describe("toolNameOf", () => {
	it("reads the name out of a typed part and a dynamic part", () => {
		expect(toolNameOf({ type: "tool-Edit" })).toBe("Edit");
		expect(toolNameOf({ type: "dynamic-tool", toolName: "mcp.thing.do" })).toBe(
			"mcp.thing.do"
		);
	});

	it("degrades to a generic name rather than throwing on a malformed part", () => {
		expect(toolNameOf({ type: "dynamic-tool" })).toBe("tool");
		expect(toolNameOf({})).toBe("tool");
	});
});

describe("buildMissionDigest — totals", () => {
	it("counts calls, commands and failures across every turn", () => {
		const digest = buildMissionDigest([
			user("one"),
			assistant("a1", [
				tool("Bash", { command: "a" }),
				tool("Bash", { command: "b" }, "output-error"),
			]),
			user("two"),
			assistant("a2", [tool("Edit", { file_path: "/x.ts" })]),
		]);

		expect(digest.totals).toEqual({
			commands: 2,
			failures: 1,
			filesTouched: 1,
			toolCalls: 3,
			turns: 2,
			writes: 1,
		});
	});

	it("returns an empty digest for an empty conversation", () => {
		const digest = buildMissionDigest([]);
		expect(digest.turns).toEqual([]);
		expect(digest.files).toEqual([]);
		expect(digest.totals.turns).toBe(0);
	});
});

it("tool field projection preserves own prototype keys and live optional transport values", () => {
	const input = {
		...JSON.parse('{"__proto__":" source path ","file_path":" src/owner.ts "}'),
		future: {
			omitted: undefined,
			count: Number.POSITIVE_INFINITY,
			nested: [undefined, null],
		},
	};
	expect(firstString(input, ["__proto__"])).toBe("source path");
	expect(firstString(input, ["missing", "file_path"])).toBe("src/owner.ts");
	expect(
		firstString({ file_path: 1, path: "fallback.ts" }, ["file_path", "path"])
	).toBe("fallback.ts");
	expect(firstString(["path"], ["0"])).toBeUndefined();
	expect(firstString(null, ["file_path"])).toBeUndefined();
	const digest = buildMissionDigest([
		user("Read the file"),
		assistant("fixture", [tool("Read", input)]),
	]);
	expect(digest.turns[0]?.files).toEqual([
		{ path: "src/owner.ts", kind: "read", count: 1 },
	]);
	expect(input.future.nested[0]).toBeUndefined();
	expect(Object.hasOwn(input, "__proto__")).toBe(true);
});
