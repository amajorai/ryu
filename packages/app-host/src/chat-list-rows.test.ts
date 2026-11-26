import { describe, expect, test } from "bun:test";
import { chatListRowSchema, chatListRowsSchema } from "./chat-list-rows.ts";
import { type Capability, dispatchRpc, type HostServices } from "./rpc.ts";

// chat.list rides the ask-to-send grant, which the Gateway approves for any
// app id. CORE_ROW is one conversation as Core lists it with previews on. A
// frame must get the picker fields only, and nothing a later Core adds.

const GRANTED: ReadonlySet<Capability> = new Set<Capability>([
	"chat.broadcast",
]);
const LATER = "field-added-by-a-later-core";
const CORE_ROW = {
	addedLater: LATER,
	agent_id: "agent-1",
	archived: false,
	branch: "feature/private-branch",
	continued_on: { at: 5, nodeLabel: "office-node" },
	coordination: "coordinator",
	created_at: 1000,
	folder_path: "C:\\Users\\owner\\work\\secret-project",
	icon: { kind: "emoji", value: "icon-value" },
	id: "conversation-1",
	last_message: "The deploy token is tok-live-123",
	last_message_at: 1900,
	last_message_role: "user",
	linked_pull_requests: ["https://github.com/example/private-repo/pull/7"],
	message_count: 4,
	owner_id: "owner-5",
	owner_kind: "bot",
	participants: ["agent-1", "agent-reviewer"],
	pinned: true,
	project_id: "project-9",
	run_status: "running",
	spawned_by_conversation_id: "conversation-0",
	spawned_by_message_id: "message-0",
	thread_role: "worker",
	title: "Release plan",
	updated_at: 2000,
	visibility: "org",
	worktree_path: "C:\\Users\\owner\\worktrees\\wt-7",
};
const PICKER_ROW = {
	agent_id: "agent-1",
	archived: false,
	created_at: 1000,
	id: "conversation-1",
	last_message_at: 1900,
	message_count: 4,
	run_status: "running",
	title: "Release plan",
	updated_at: 2000,
};
const BARE_ROW = {
	agent_id: null,
	created_at: 1,
	id: "conversation-2",
	message_count: 0,
	run_status: null,
	title: null,
	updated_at: 2,
};
const HELD_BACK = [
	"tok-live-123",
	"deploy token",
	"secret-project",
	"wt-7",
	"private-branch",
	"agent-reviewer",
	"private-repo",
	"office-node",
	"project-9",
	"owner-5",
	"conversation-0",
	"message-0",
	"icon-value",
	LATER,
];

describe("chatListRowSchema", () => {
	test("returns a new object that holds only the picker fields", () => {
		const row = chatListRowSchema.parse(CORE_ROW);
		expect(row).toEqual(PICKER_ROW);
		expect(Object.keys(row)).toHaveLength(Object.keys(PICKER_ROW).length);
		expect(row).not.toBe(CORE_ROW);
		// Core's row is left as it was.
		expect(CORE_ROW.last_message).toBe("The deploy token is tok-live-123");
	});

	test("drops message text, paths and every field that is not listed", () => {
		const text = JSON.stringify(chatListRowSchema.parse(CORE_ROW));
		for (const value of HELD_BACK) {
			expect(text).not.toContain(value);
		}
		for (const name of [
			"last_message_role",
			"folder_path",
			"worktree_path",
			"branch",
			"participants",
			"linked_pull_requests",
			"visibility",
			"continued_on",
			"pinned",
		]) {
			expect(text).not.toContain(`"${name}"`);
		}
		expect(text).not.toContain('"last_message":');
	});

	test("keeps a row that has only the required fields", () => {
		expect(chatListRowSchema.parse(BARE_ROW)).toEqual(BARE_ROW);
	});

	test("refuses a row without an id and a value that is not a record", () => {
		const withoutId = { ...CORE_ROW, id: undefined };
		expect(chatListRowSchema.safeParse(withoutId).success).toBe(false);
		expect(chatListRowSchema.safeParse("conversation-1").success).toBe(false);
		expect(chatListRowSchema.safeParse(null).success).toBe(false);
	});
});

describe("chat.list through dispatchRpc", () => {
	// What a host does: it parses Core's rows with chatListRowsSchema and hands
	// the result to the dispatcher.
	const services = {
		chatListConversations: () =>
			Promise.resolve(chatListRowsSchema.parse([CORE_ROW, BARE_ROW])),
	} as unknown as HostServices;

	test("the frame gets picker rows only", async () => {
		const result = await dispatchRpc("chat.list", [], GRANTED, services);
		expect(result).toEqual([PICKER_ROW, BARE_ROW]);
		const text = JSON.stringify(result);
		for (const value of HELD_BACK) {
			expect(text).not.toContain(value);
		}
	});

	test("the list is a new array of new objects", () => {
		const input = [CORE_ROW];
		const rows = chatListRowsSchema.parse(input);
		expect(rows).not.toBe(input);
		expect(rows[0]).not.toBe(CORE_ROW);
		expect(rows).toHaveLength(1);
	});
});
