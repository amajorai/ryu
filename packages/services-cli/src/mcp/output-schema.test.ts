// `ryu-services mcp` declares each registry tool's outputSchema, the MCP SDK
// checks every successful structuredContent against it, and a tool error
// stays `isError: true` with `{ error }`, which is not checked.

import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RyuFetch, RyuOptions } from "@ryuhq/services";
import {
	getRyuTool,
	RYU_TOOLS,
	ryuToolOutputJsonSchema,
	toolOutput,
} from "@ryuhq/services/tools";
import * as z from "zod";
import { MCP_TOOL_MODULES, type ServiceToolModule } from "./registry.ts";
import { createServicesMcpServer } from "./server.ts";

const ALL_ENV = {
	RYU_NOTIFY_URL: "https://notify.example.com",
	RYU_NOTIFY_API_KEY: "notify-key",
	RYU_API_KEY: "ryu_test_key",
	RYU_ORGANIZATION_ID: "org_test",
	RYU_MAIL_URL: "https://mail.example.com",
	RYU_MAIL_API_KEY: "mail-key",
	RYU_BOX_URL: "https://box.example.com",
	RYU_BOX_API_KEY: "box-key",
	RYU_GATEWAY_URL: "https://gateway.example.com",
	RYU_GATEWAY_TOKEN: "gateway-token",
	RYU_PASSPORT_URL: "https://passport.example.com",
	RYU_PASSPORT_API_KEY: "passport-key",
	RYU_SITES_URL: "https://sites.example.com",
	RYU_SITES_API_KEY: "sites-key",
};

const NOW = "2026-10-21T12:00:00.000Z";
const BOX = {
	id: "bx_1",
	name: "work",
	size: "default",
	status: "ready",
	lastError: null,
	image: "ubuntu:24.04",
	driver: "filesystem-dev",
	network: "none",
	allowedHosts: [],
	envNames: [],
	secrets: [],
	repo: null,
	snapshotId: null,
	stoppedAt: null,
	ttlSeconds: null,
	createdAt: NOW,
	updatedAt: NOW,
};

async function connect(
	config: RyuOptions<"throw">,
	modules: readonly ServiceToolModule[] = MCP_TOOL_MODULES
) {
	const { server } = createServicesMcpServer({
		config,
		log: () => undefined,
		modules,
		readOnly: false,
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "output-schema-test", version: "1.0.0" });
	await client.connect(clientTransport);
	return client;
}

function boxFetch(status: number, body: unknown): RyuFetch {
	return () =>
		Promise.resolve(
			Response.json(body, {
				status,
				headers: { "x-request-id": "req_box" },
			})
		);
}

describe("ryu-services mcp outputSchema", () => {
	test("tools/list advertises every registry tool's { data, meta } schema", async () => {
		const client = await connect({ env: ALL_ENV });
		try {
			const listed = (await client.listTools()).tools;
			expect(listed.map((tool) => tool.name).sort()).toEqual(
				RYU_TOOLS.map((tool) => tool.name).sort()
			);
			for (const tool of listed) {
				const registry = getRyuTool(tool.name);
				if (registry === undefined) {
					throw new Error(`${tool.name} is not a registry tool`);
				}
				const { $schema: _dialect, ...advertised } = (tool.outputSchema ??
					{}) as Record<string, unknown>;
				expect({ name: tool.name, schema: advertised }).toEqual({
					name: tool.name,
					schema: ryuToolOutputJsonSchema(registry),
				});
			}
		} finally {
			await client.close();
		}
	});

	test("a successful call's structuredContent conforms to the advertised schema", async () => {
		const client = await connect({
			env: ALL_ENV,
			fetch: boxFetch(200, { box: BOX }),
		});
		try {
			const result = await client.callTool({
				name: "box_get",
				arguments: { boxId: "bx_1" },
			});
			expect(result.isError).toBeFalsy();
			const listed = (await client.listTools()).tools.find(
				(tool) => tool.name === "box_get"
			);
			const schema = z.fromJSONSchema(
				listed?.outputSchema as z.core.JSONSchema.JSONSchema
			);
			expect(schema.safeParse(result.structuredContent).success).toBe(true);
			expect(result.structuredContent).toMatchObject({
				data: { id: "bx_1", status: "ready" },
				meta: { requestId: "req_box" },
			});
		} finally {
			await client.close();
		}
	});

	test("a tool error stays isError with { error } and is not checked against the schema", async () => {
		const client = await connect({
			env: ALL_ENV,
			fetch: boxFetch(404, {
				ok: false,
				type: "box.error",
				code: "not_found",
				message: "Box not found.",
				error: { code: "not_found", message: "Box not found." },
			}),
		});
		try {
			const result = await client.callTool({
				name: "box_get",
				arguments: { boxId: "bx_missing" },
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				error: { service: "box", status: 404 },
			});
			const registry = getRyuTool("box_get");
			expect(
				registry?.outputSchema.safeParse(result.structuredContent).success
			).toBe(false);
			// Bad arguments are a tool error too, with the same shape.
			const invalid = await client.callTool({
				name: "box_get",
				arguments: {},
			});
			expect(invalid.isError).toBe(true);
			expect(invalid.structuredContent).toMatchObject({
				error: { code: "invalid_arguments" },
			});
		} finally {
			await client.close();
		}
	});

	test("a body whose success breaks its outputSchema is refused by the server", async () => {
		const broken: ServiceToolModule = {
			service: "box",
			register: (server) =>
				server.tool({
					name: "box_broken",
					title: "Broken",
					description: "Answers data its outputSchema does not allow.",
					inputSchema: z.object({}),
					outputSchema: toolOutput(z.object({ id: z.string() })),
					annotations: {
						readOnlyHint: true,
						destructiveHint: false,
						idempotentHint: true,
						openWorldHint: false,
					},
					run: () => ({ id: 42 }),
				}),
		};
		const client = await connect({ env: ALL_ENV }, [broken]);
		try {
			const result = await client.callTool({
				name: "box_broken",
				arguments: {},
			});
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.content)).toContain("Output validation");
		} finally {
			await client.close();
		}
	});
});
