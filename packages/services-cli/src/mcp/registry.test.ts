import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RyuOptions } from "@ryuhq/services";
import {
	defaultNotifyUsageWindow,
	NOTIFY_TOOL_LEVELS,
	RYU_TOOL_SERVICES,
	RYU_TOOLS,
} from "@ryuhq/services/tools";
import { defaultUsageWindow, NOTIFY_LEVELS } from "../commands/notify.ts";
import { MCP_TOOL_MODULES } from "./registry.ts";
import { createServicesMcpServer } from "./server.ts";

/** Env that configures every service with tools. */
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

async function connectClient(config: RyuOptions<"throw">, readOnly = false) {
	const { server } = createServicesMcpServer({
		config,
		log: () => undefined,
		readOnly,
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "registry-test", version: "1.0.0" });
	await client.connect(clientTransport);
	return client;
}

async function listTools(config: RyuOptions<"throw">, readOnly = false) {
	const client = await connectClient(config, readOnly);
	try {
		return (await client.listTools()).tools;
	} finally {
		await client.close();
	}
}

describe("MCP tools come from the @ryuhq/services registry", () => {
	test("one MCP module per registry service", () => {
		expect(MCP_TOOL_MODULES.map((module) => module.service)).toEqual([
			...RYU_TOOL_SERVICES,
		]);
	});

	test("the MCP tool list equals RYU_TOOLS, field for field", async () => {
		const tools = await listTools({ env: ALL_ENV });
		expect(tools.map((tool) => tool.name)).toEqual(
			RYU_TOOLS.map((tool) => tool.name)
		);
		for (const definition of RYU_TOOLS) {
			const listed = tools.find((tool) => tool.name === definition.name);
			expect({
				name: definition.name,
				title: listed?.title,
				description: listed?.description,
				annotations: listed?.annotations,
				properties: Object.keys(listed?.inputSchema.properties ?? {}).sort(),
			}).toEqual({
				name: definition.name,
				title: definition.title,
				description: definition.description,
				annotations: { ...definition.annotations, title: definition.title },
				properties: Object.keys(definition.inputSchema.shape).sort(),
			});
		}
	});

	test("read-only mode lists exactly the registry's read-only tools", async () => {
		const tools = await listTools({ env: ALL_ENV }, true);
		expect(tools.map((tool) => tool.name)).toEqual(
			RYU_TOOLS.filter((tool) => tool.annotations.readOnlyHint).map(
				(tool) => tool.name
			)
		);
	});

	test("the managed-agents approval tools are kept", async () => {
		const names = (await listTools({ env: ALL_ENV })).map((tool) => tool.name);
		expect(names).toContain("managed_agents_list_pending_approvals");
		expect(names).toContain("managed_agents_answer_approval");
		const readOnly = (await listTools({ env: ALL_ENV }, true)).map(
			(tool) => tool.name
		);
		expect(readOnly).toContain("managed_agents_list_pending_approvals");
		expect(readOnly).not.toContain("managed_agents_answer_approval");
	});

	test("the MCP tool modules define no tools of their own", () => {
		const directory = join(import.meta.dir, "tools");
		for (const file of readdirSync(directory)) {
			const source = readFileSync(join(directory, file), "utf8");
			expect({
				file,
				inline: /server\.tool\(|z\.object\(|from "zod"/u.test(source),
				registry: source.includes('from "@ryuhq/services/tools"'),
			}).toEqual({ file, inline: false, registry: true });
		}
	});

	test("an argument the schema rejects is the registry's invalid_arguments, not the SDK's text error", async () => {
		const client = await connectClient({
			env: ALL_ENV,
			fetch: () => Promise.reject(new Error("no request expected")),
		});
		try {
			for (const [name, args, path] of [
				["notify_list_events", { limit: 5000 }, "limit"],
				["notify_usage", { from: "2026-10-01T00:00:00Z" }, "to"],
				["sites_deploy", { siteId: "site_1", expectedRevision: 0 }, "html"],
			] as const) {
				const result = await client.callTool({ name, arguments: args });
				expect({ name, isError: result.isError }).toEqual({
					name,
					isError: true,
				});
				expect(result.structuredContent).toMatchObject({
					error: {
						code: "invalid_arguments",
						retryable: false,
						details: {
							tool: name,
							issues: [expect.objectContaining({ path })],
						},
					},
				});
			}
		} finally {
			await client.close();
		}
	});

	test("a cancelled MCP request aborts the facade call the tool is waiting on", async () => {
		const signals: AbortSignal[] = [];
		const client = await connectClient({
			env: ALL_ENV,
			maxRetries: 0,
			fetch: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (signal) {
						signals.push(signal);
						signal.addEventListener(
							"abort",
							() => reject(new DOMException("aborted", "AbortError")),
							{ once: true }
						);
					}
				}),
		});
		const controller = new AbortController();
		const call = client
			.callTool(
				{
					name: "box_exec",
					arguments: { boxId: "bx_1", command: "sleep 600" },
				},
				{ signal: controller.signal }
			)
			.catch((error: unknown) => error);
		for (let tick = 0; tick < 500 && signals.length === 0; tick += 1) {
			await new Promise((done) => setTimeout(done, 2));
		}
		expect(signals).toHaveLength(1);
		controller.abort();
		await call;
		for (let tick = 0; tick < 500 && !signals[0]?.aborted; tick += 1) {
			await new Promise((done) => setTimeout(done, 2));
		}
		expect(signals[0]?.aborted).toBe(true);
		await client.close();
	});

	test("the notify CLI command and the notify_usage tool share levels and the default window", () => {
		expect([...NOTIFY_LEVELS]).toEqual([...NOTIFY_TOOL_LEVELS]);
		for (const now of [
			Date.UTC(2026, 9, 22, 10, 0, 0),
			Date.UTC(2026, 9, 22, 10, 30, 0),
		]) {
			expect(defaultUsageWindow(now)).toEqual(defaultNotifyUsageWindow(now));
		}
	});
});
