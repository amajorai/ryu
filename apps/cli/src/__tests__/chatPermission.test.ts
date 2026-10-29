import { afterEach, expect, test } from "bun:test";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	parseChatPermission,
	permissionToolDetail,
	permissionToolTitle,
	respondToChatPermission,
} from "../core/chatPermission.ts";

interface PermissionRequestObservation {
	body?: RequestInit["body"];
	headers?: RequestInit["headers"];
	url?: string;
}

const target: ApiTarget = { url: "http://node:7980", token: "node-secret" };
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

test("parses the Core ryu-permission frame and preserves tool metadata", () => {
	const permission = parseChatPermission({
		requestId: "perm-7",
		toolCall: { fields: { title: "Run shell" } },
		options: [
			{ kind: "allow_once", name: "Allow once", optionId: "allow" },
			{ kind: "reject_once", name: "Reject", optionId: "reject" },
		],
	});

	expect(permission?.requestId).toBe("perm-7");
	expect(permission?.options).toHaveLength(2);
	expect(permissionToolTitle(permission?.toolCall)).toBe("Run shell");
});

test("rejects malformed permission frames", () => {
	expect(parseChatPermission(null)).toBeNull();
	expect(parseChatPermission({ requestId: "perm-7", options: [] })).toBeNull();
	expect(
		parseChatPermission({
			requestId: "perm-7",
			options: [{ name: "Allow", optionId: "allow" }],
		})
	).toBeNull();
});

test("posts the selected option to Core's permission contract", async () => {
	let captured: PermissionRequestObservation = {};
	globalThis.fetch = Object.assign(
		(
			url: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		) => {
			captured = {
				body: init?.body,
				headers: init?.headers,
				url: String(url),
			};
			return Promise.resolve(
				new Response(JSON.stringify({ resolved: true }), {
					headers: { "Content-Type": "application/json" },
					status: 200,
				})
			);
		},
		{ preconnect: realFetch.preconnect }
	);

	expect(await respondToChatPermission(target, "perm-7", "allow")).toBe(true);
	expect(captured.url).toBe("http://node:7980/api/chat/permission");
	expect(
		appResponseValueSchema.parse(JSON.parse(String(captured.body ?? "{}")))
	).toEqual({
		request_id: "perm-7",
		option_id: "allow",
	});
	const headers = new Headers(captured.headers);
	expect(headers.get("Authorization")).toBe("Bearer node-secret");
});

test("permission detail exposes an execute command, its cwd and the tool call", () => {
	expect(
		permissionToolDetail({
			toolCallId: "t1",
			kind: "execute",
			title: "Run terminal",
			rawInput: { command: ["rm", "-rf", "build"], cwd: "/repo" },
		})
	).toEqual({
		title: "Run terminal",
		kind: "execute",
		toolCallId: "t1",
		command: "rm -rf build",
		cwd: "/repo",
		diff: null,
	});
	// Agents that nest metadata under `fields` resolve the same way.
	expect(
		permissionToolDetail({
			fields: { kind: "execute", rawInput: { command: "ls" } },
		})
	).toMatchObject({ kind: "execute", command: "ls", title: "run a tool" });
});

test("permission detail renders an ACP content diff for an edit", () => {
	const detail = permissionToolDetail({
		toolCallId: "edit-1",
		kind: "edit",
		title: "Edit src/a.ts",
		locations: [{ path: "/repo/src/a.ts" }],
		content: [
			{ type: "text", text: "ignored" },
			{
				type: "diff",
				path: "/repo/src/a.ts",
				oldText: "const a = 1;",
				newText: "const a = 2;",
			},
		],
	});
	expect(detail.path).toBe("/repo/src/a.ts");
	expect(detail.diff).toEqual([
		{ kind: "header", text: "--- /repo/src/a.ts" },
		{ kind: "header", text: "+++ /repo/src/a.ts" },
		{ kind: "removed", text: "- const a = 1;" },
		{ kind: "added", text: "+ const a = 2;" },
	]);
});

test("permission detail falls back to the raw edit input diff", () => {
	const detail = permissionToolDetail({
		kind: "edit",
		rawInput: { file_path: "b.ts", old_string: "x", new_string: "y" },
	});
	expect(detail.path).toBe("b.ts");
	expect(detail.diff?.map((line) => line.kind)).toEqual([
		"header",
		"header",
		"removed",
		"added",
	]);
});

test("permission detail degrades to the title when fields are missing", () => {
	expect(permissionToolDetail(undefined)).toEqual({
		title: "run a tool",
		diff: null,
	});
	expect(
		permissionToolDetail({ title: "Fetch", rawInput: { command: 42 } })
	).toEqual({ title: "Fetch", diff: null });
});
