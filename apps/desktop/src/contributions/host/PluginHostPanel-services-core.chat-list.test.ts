import { afterAll, beforeEach, expect, test } from "bun:test";
import { dispatchRpc } from "@ryu/app-host/rpc";
import { listChatBroadcastConversations } from "@/src/lib/api/chat-broadcast.ts";
import type { PluginHostServicesContext } from "./PluginHostPanel-services-context.ts";
import { buildPluginHostCoreServices } from "./PluginHostPanel-services-core.ts";

// chat.list rides the ask-to-send grant, which the Gateway approves for any
// app id. The fixture node answers the list as Core does with previews on. An
// app frame must get picker rows only: no message text, no local paths and
// nothing a later Core adds to a row.

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
	"last_message_role",
	"folder_path",
	"worktree_path",
	"linked_pull_requests",
	LATER,
];

const requests: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		requests.push(`${url.pathname}${url.search}`);
		return Response.json({ conversations: [CORE_ROW] });
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	requests.length = 0;
});

const node = {
	url: `${server.url.toString().replace(/\/$/, "")}/node`,
	token: "fixture-node-token",
	userJwt: null,
};
const context = {
	assistantContextRef: { current: [] },
	assistantOwner: "plugin:com.example.picker",
	assistantSurfaceRef: { current: null },
	companion: { pluginId: "com.example.picker" },
	fileAccess: undefined,
	getActiveNode: () => node,
	i18n: { locale: "en" },
	isActiveTabRef: { current: true },
	node,
	onRequestClose: undefined,
	toastHost: {},
} as unknown as PluginHostServicesContext;
const services = buildPluginHostCoreServices(context);

test("the chat.list RPC gives a frame picker rows without message text or paths", async () => {
	const result = await dispatchRpc(
		"chat.list",
		[],
		new Set(["chat.broadcast"]),
		services
	);
	expect(requests).toEqual(["/node/api/conversations?preview=1"]);
	expect(result).toEqual([PICKER_ROW]);
	const text = JSON.stringify(result);
	for (const value of HELD_BACK) {
		expect(text).not.toContain(value);
	}
	expect(text).not.toContain('"last_message":');
});

test("the host service itself holds only the picker fields", async () => {
	const rows = await services.chatListConversations?.();
	expect(rows).toEqual([PICKER_ROW]);
	expect(Object.keys(rows?.[0] ?? {})).toHaveLength(
		Object.keys(PICKER_ROW).length
	);
});

test("the desktop client returns the same reduced rows to any caller", async () => {
	const rows = await listChatBroadcastConversations({
		url: node.url,
		token: node.token,
	});
	expect(rows).toEqual([PICKER_ROW]);
	const text = JSON.stringify(rows);
	for (const value of HELD_BACK) {
		expect(text).not.toContain(value);
	}
});
