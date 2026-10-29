import { afterAll, describe, expect, test } from "bun:test";
import { type RpcErrorPayload, toRpcError } from "@ryu/app-host/rpc";
import { widgetToolResultSchema } from "./widget-wire-contracts.ts";
import { widgetCallTool, widgetFollowUp, widgetSetState } from "./widgets.ts";

let scenario = "tool";
let body = "";
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		body = await request.text();
		if (scenario === "known-error") {
			return Response.json(
				{ error: { code: "denied", message: "Denied" } },
				{ status: 403 }
			);
		}
		if (scenario === "future-error") {
			return Response.json(
				{ error: { code: "future", message: "Future" } },
				{ status: 403 }
			);
		}
		if (scenario === "legacy-error") {
			return Response.json({ error: "Legacy" }, { status: 429 });
		}
		if (scenario === "empty") {
			return new Response(null, { status: 204 });
		}
		if (scenario === "follow") {
			return Response.json({
				ok: true,
				ticket: "ticket",
				injected: {
					conversation_id: "conversation",
					origin_server: "server",
					prompt: "Prompt",
					role: "user",
					source: "widget",
					tool_call_id: null,
					widget_instance_id: "instance",
					future: true,
				},
				future: true,
			});
		}
		if (scenario === "invalid-follow") {
			return Response.json({ ok: true, ticket: "ticket", injected: {} });
		}
		return new Response(
			'{"ok":true,"output":{"__proto__":{"future":true},"values":[1,null]},"future":true}',
			{ headers: { "content-type": "application/json" } }
		);
	},
});
const target = { token: null, url: server.url.origin };
const input = {
	instanceId: "instance",
	name: "tool",
	serverId: "server",
	toolCallId: "call",
	args: { value: false },
};
afterAll(() => server.stop(true));

describe("Widget HTTP owner boundaries", () => {
	test("validates the full tool result and preserves output metadata identity", async () => {
		const result = await widgetCallTool(target, input);
		expect(result.output).toEqual(
			JSON.parse('{"__proto__":{"future":true},"values":[1,null]}')
		);
		expect(JSON.parse(body)).toEqual({
			instance_id: "instance",
			server_id: "server",
			tool_id: "tool",
			tool_call_id: "call",
			arguments: { value: false },
		});
		const original = JSON.parse(
			'{"ok":true,"output":{"value":false},"future":true}'
		);
		expect(widgetToolResultSchema.parse(original)).toBe(original);
		expect(widgetToolResultSchema.safeParse({ ok: true }).success).toBe(false);
	});
	test("keeps follow-up provenance and rejects incomplete confirmations", async () => {
		try {
			scenario = "follow";
			const result = await widgetFollowUp(target, {
				instanceId: "instance",
				toolCallId: "call",
				prompt: "Prompt",
			});
			expect(result.injected.source).toBe("widget");
			expect(
				Object.getOwnPropertyDescriptor(result.injected, "future")?.value
			).toBe(true);
			scenario = "invalid-follow";
			await expect(
				widgetFollowUp(target, {
					instanceId: "instance",
					toolCallId: "call",
					prompt: "Prompt",
				})
			).rejects.toThrow("invalid widget follow-up envelope");
		} finally {
			scenario = "tool";
		}
	});
	test("keeps empty state replies and undefined-field omission", async () => {
		try {
			scenario = "empty";
			await widgetSetState(target, {
				instanceId: "instance",
				toolCallId: "call",
				state: undefined,
			});
			expect(JSON.parse(body)).toEqual({
				instance_id: "instance",
				tool_call_id: "call",
			});
			await widgetSetState(target, {
				instanceId: "instance",
				toolCallId: "call",
				state: { enabled: false },
			});
			expect(JSON.parse(body)).toEqual({
				instance_id: "instance",
				tool_call_id: "call",
				state: { enabled: false },
			});
		} finally {
			scenario = "tool";
		}
	});
	test("keeps the closed public error vocabulary and legacy status fallbacks", async () => {
		try {
			const cases = [
				{
					mode: "known-error",
					expected: { code: "denied", message: "Denied" },
				},
				{
					mode: "future-error",
					expected: { code: "server_error", message: "Future" },
				},
				{
					mode: "legacy-error",
					expected: { code: "over_budget", message: "Legacy" },
				},
			] satisfies { mode: string; expected: RpcErrorPayload }[];
			for (const fixture of cases) {
				scenario = fixture.mode;
				await widgetCallTool(target, input).then(
					() => {
						throw new Error("Expected failure");
					},
					(error) => expect(toRpcError(error)).toEqual(fixture.expected)
				);
			}
		} finally {
			scenario = "tool";
		}
	});
});
