import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import type { ApiTarget } from "./client.ts";
import {
	callMcpTool,
	createMcpServer,
	mcpInstallPreviewSchema,
	updateMcpServer,
} from "./mcp.ts";

const originalFetch = globalThis.fetch;
const target: ApiTarget = {
	url: "http://127.0.0.1:8980",
	token: "node-token",
	userJwt: null,
};
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function respond(
	response: Response,
	capture?: (init: RequestInit | undefined) => void
): void {
	globalThis.fetch = Object.assign(
		(_input: RequestInfo | URL, init?: RequestInit) => {
			capture?.(init);
			return Promise.resolve(response);
		},
		{ preconnect: originalFetch.preconnect }
	);
}

test("MCP calls retain structured output and denied-call errors", async () => {
	respond(
		Response.json({
			ok: true,
			output: { structuredContent: { count: 2 }, content: [] },
		})
	);
	expect(
		await callMcpTool(target, {
			tool: "settings.read",
			agentId: "owner",
			arguments: {},
		})
	).toEqual({
		ok: true,
		output: { structuredContent: { count: 2 }, content: [] },
		error: undefined,
	});
	respond(Response.json({ ok: false, error: "Not allowed" }, { status: 403 }));
	expect(
		await callMcpTool(target, {
			tool: "settings.read",
			agentId: "owner",
			arguments: {},
		})
	).toEqual({
		ok: false,
		output: undefined,
		error: "Not allowed",
	});
});

test("MCP calls use HTTP success when the legacy response omits ok", async () => {
	respond(new Response(null, { status: 204 }));
	expect(
		(
			await callMcpTool(target, {
				tool: "settings.read",
				agentId: "owner",
				arguments: {},
			})
		).ok
	).toBe(true);
	respond(Response.json({ error: "Legacy failure" }, { status: 400 }));
	expect(
		(
			await callMcpTool(target, {
				tool: "settings.read",
				agentId: "owner",
				arguments: {},
			})
		).ok
	).toBe(false);
});

test("MCP create keeps defaults and update includes explicit false and empty values", async () => {
	let body: z.infer<ReturnType<typeof z.json>> | undefined;
	const capture = (init: RequestInit | undefined) => {
		const serialized = z.string().parse(init?.body);
		body = z.json().parse(JSON.parse(serialized));
	};
	respond(Response.json({ ok: true }), capture);
	await createMcpServer(target, { name: "drawing", command: "", url: "" });
	expect(body).toEqual({
		name: "drawing",
		headers: {},
		args: [],
		env: {},
		description: null,
	});
	respond(Response.json({ ok: true }), capture);
	await updateMcpServer(target, "drawing", {
		command: "",
		enabled: false,
		description: "",
		args: [],
		headers: {},
	});
	expect(body).toEqual({
		enabled: false,
		description: "",
		args: [],
		headers: {},
	});
});

test("MCP preview validates launch shape and preserves additional JSON metadata", () => {
	const preview = {
		action: "install",
		dryRun: true,
		success: true,
		server: {
			transport: "stdio",
			args: ["server"],
			command: "bun",
			name: "drawing",
			url: null,
		},
		explanation: { permissions: ["read"] },
	} satisfies z.infer<typeof mcpInstallPreviewSchema>;
	expect(mcpInstallPreviewSchema.parse(preview)).toEqual(preview);
	expect(
		mcpInstallPreviewSchema.safeParse({
			...preview,
			server: { ...preview.server, transport: "streamable-http" },
		}).success
	).toBe(false);
});
