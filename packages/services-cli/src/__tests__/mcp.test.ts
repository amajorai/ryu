import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RyuFetch, RyuOptions } from "@ryuhq/services";
import { createRyuError, Ryu, RyuConfigurationError } from "@ryuhq/services";
import { RYU_TOOLS } from "@ryuhq/services/tools";
import * as z from "zod";
import { runCli } from "../cli.ts";
import { MCP_ENV_ADVICE, mcpHintText } from "../hints.ts";
import {
	configurationErrorReason,
	configurationProblem,
	MCP_TOOL_MODULES,
	registerServiceTools,
	type ServiceToolModule,
} from "../mcp/registry.ts";
import { collectEvents, runTool, toolFailure } from "../mcp/result.ts";
import {
	createServicesMcpServer,
	emptyToolsLine,
	mcpInstructions,
	mcpModeLine,
} from "../mcp/server.ts";
import { workspaceProgram } from "../program.ts";
import { CLI_VERSION } from "../version.ts";

const PACKAGE_DIR = resolve(import.meta.dir, "../..");

const NOTIFY_ENV = {
	RYU_NOTIFY_URL: "https://notify.example.com",
	RYU_NOTIFY_API_KEY: "notify-mcp-secret",
};

/** Tool modules shaped like the real ones, so the framework is tested without the service work packages. */
const FAKE_MODULES: readonly ServiceToolModule[] = [
	{
		service: "notify",
		register(server, ryu) {
			server.tool({
				name: "notify_echo",
				title: "Echo",
				description: "Returns its input.",
				inputSchema: z.object({ text: z.string() }),
				annotations: {
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
				run: (input) => ({ echoed: input.text }),
			});
			server.tool({
				name: "notify_publish",
				title: "Publish",
				description: "Publishes a notification.",
				inputSchema: z.object({ title: z.string() }),
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: true,
				},
				run: (input) => ryu.notify.publish({ title: input.title }),
			});
		},
	},
	{
		service: "box",
		register(server) {
			server.tool({
				name: "box_list",
				title: "List boxes",
				description: "Lists boxes.",
				inputSchema: z.object({}),
				annotations: {
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				},
				run: () => [],
			});
		},
	},
];

async function connect(
	config: RyuOptions<"throw">,
	options: {
		readOnly?: boolean;
		services?: ("notify" | "box" | "connect")[];
		modules?: readonly ServiceToolModule[];
	} = {}
) {
	const lines: string[] = [];
	const { server, registration } = createServicesMcpServer({
		config,
		log: (line) => lines.push(line),
		modules: options.modules ?? FAKE_MODULES,
		...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
		...(options.services === undefined ? {} : { services: options.services }),
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "ryu-services-test", version: "1.0.0" });
	await client.connect(clientTransport);
	return { client, lines, registration, close: () => client.close() };
}

function notifyUnauthorized(): RyuFetch {
	return async () =>
		new Response(
			JSON.stringify({
				ok: false,
				type: "notify.error",
				code: "unauthorized",
				message: "Invalid API key.",
				status: 401,
				requestId: "req_mcp",
				error: {
					code: "unauthorized",
					message: "Invalid API key.",
					requestId: "req_mcp",
					status: 401,
				},
			}),
			{ status: 401, headers: { "content-type": "application/json" } }
		);
}

describe("registerServiceTools", () => {
	test("lists only the credential-free status tools when no env is set, with the real tool modules", async () => {
		const { client, lines, registration, close } = await connect(
			{ env: {} },
			{ modules: MCP_TOOL_MODULES }
		);
		try {
			const listed = (await client.listTools()).tools;
			expect(listed.map((tool) => tool.name)).toEqual([
				"messaging_status",
				"mail_status",
			]);
			for (const tool of listed) {
				expect(tool.annotations).toMatchObject({
					readOnlyHint: true,
					destructiveHint: false,
				});
			}
			expect(registration.tools).toEqual(["messaging_status", "mail_status"]);
			expect(registration.credentialFree).toEqual([
				{ service: "messaging", tools: ["messaging_status"] },
				{ service: "mail", tools: ["mail_status"] },
			]);
			expect(registration.withheld).toEqual([]);
			expect(registration.services).toEqual([]);
			expect(
				registration.skipped.find((entry) => entry.service === "messaging")
					?.reason
			).toContain(
				"only messaging_status is registered, which needs no credentials and sends none"
			);
			const skipped = registration.skipped.map((entry) => entry.service).sort();
			expect(skipped).toEqual([
				"box",
				"connect",
				"gateway",
				"mail",
				"managedAgents",
				"messaging",
				"notify",
				"passport",
				"sites",
			]);
			expect(lines).toHaveLength(skipped.length);
			expect(lines.find((line) => line.includes("gateway"))).toContain(
				"RYU_GATEWAY_URL"
			);
			const connectLine = lines.find((line) => line.includes("connect"));
			expect(connectLine).toContain("/mcp");
			expect(connectLine).toEndWith('$RYU_CONNECT_API_KEY".');
		} finally {
			await close();
		}
	});

	test("registers tool modules only for configured services", async () => {
		const { client, registration, close } = await connect(
			{ env: NOTIFY_ENV },
			{ readOnly: false }
		);
		try {
			const tools = (await client.listTools()).tools;
			expect(tools.map((tool) => tool.name).sort()).toEqual([
				"notify_echo",
				"notify_publish",
			]);
			expect(registration.skipped.map((entry) => entry.service)).toContain(
				"box"
			);
			const publish = tools.find((tool) => tool.name === "notify_publish");
			expect(publish?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			});
			expect(publish?.inputSchema.properties).toHaveProperty("title");
		} finally {
			await close();
		}
	});

	test("read-only is the default: only readOnlyHint tools, annotations kept", async () => {
		const byDefault = await connect({ env: NOTIFY_ENV });
		try {
			const tools = (await byDefault.client.listTools()).tools;
			expect(tools.map((tool) => tool.name)).toEqual(["notify_echo"]);
			expect(tools[0]?.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});
			expect(byDefault.registration.readOnly).toBe(true);
		} finally {
			await byDefault.close();
		}
		const writes = await connect({ env: NOTIFY_ENV }, { readOnly: false });
		try {
			expect(writes.registration.readOnly).toBe(false);
			expect(writes.registration.tools.sort()).toEqual([
				"notify_echo",
				"notify_publish",
			]);
		} finally {
			await writes.close();
		}
	});

	test("mcpModeLine names the mode and the tool count", () => {
		const readOnlyLine = mcpModeLine({ readOnly: true, tools: ["a"] });
		expect(readOnlyLine).toContain("read-only mode, 1 tool registered");
		expect(readOnlyLine).toContain("--allow-writes");
		const writesLine = mcpModeLine({ readOnly: false, tools: ["a", "b"] });
		expect(writesLine).toContain("writes allowed (--allow-writes), 2 tools");
		expect(writesLine).toContain("approval prompt");
	});

	test("mcpModeLine leaves out the --allow-writes hint when 0 tools are registered", () => {
		const emptyLine = mcpModeLine({ readOnly: true, tools: [] });
		expect(emptyLine).toBe(
			"ryu-services mcp: read-only mode, 0 tools registered."
		);
		expect(emptyLine).not.toContain("--allow-writes");
	});

	test("initialize sends instructions naming the mode, the registered and the skipped services", async () => {
		const readOnly = await connect({ env: NOTIFY_ENV });
		try {
			const text = readOnly.client.getInstructions() ?? "";
			expect(text).toContain("Mode: read-only. 1 tool registered");
			expect(text).toContain("1 withheld");
			expect(text).toContain("--allow-writes");
			expect(text).toContain("Registered services: notify.");
			expect(text).toContain("- box: not configured (set RYU_BOX_");
			expect(text).toContain("ryu-services doctor");
			expect(text).not.toContain("notify-mcp-secret");
			// Skips are still logged once, not once per planning pass.
			expect(
				readOnly.lines.filter((line) => line.includes("skipping box"))
			).toHaveLength(1);
		} finally {
			await readOnly.close();
		}
		const writes = await connect({ env: NOTIFY_ENV }, { readOnly: false });
		try {
			expect(writes.client.getInstructions()).toContain(
				"Mode: writes allowed (--allow-writes). 2 tools registered"
			);
		} finally {
			await writes.close();
		}
	});

	test("with nothing configured, the instructions say why no tools are listed", async () => {
		const empty = await connect({ env: {} });
		try {
			const text = empty.client.getInstructions() ?? "";
			expect(text).toContain(
				"No service is configured, so no tools are registered."
			);
			expect(text).toContain("- notify: not configured (set RYU_NOTIFY_");
			expect(text).toContain("ryu-services doctor");
			expect(text).not.toContain("withheld");
			// Connect's skip tells the model where to point instead, by env var name.
			expect(text).toContain(
				'- connect: no tools (Connect is an MCP server itself). Point your MCP client at $RYU_CONNECT_URL/mcp with the header "Authorization: Bearer $RYU_CONNECT_API_KEY".'
			);
			expect((await empty.client.listTools()).tools).toEqual([]);
		} finally {
			await empty.close();
		}
	});

	test("the connect hint in the instructions names env vars, never the configured URL", async () => {
		const session = await connect({
			env: {
				RYU_CONNECT_URL: "https://connect.internal.example.com",
				RYU_CONNECT_API_KEY: "connect-mcp-secret",
			},
		});
		try {
			const text = session.client.getInstructions() ?? "";
			expect(text).toContain("$RYU_CONNECT_URL/mcp");
			expect(text).not.toContain("connect.internal.example.com");
			expect(text).not.toContain("connect-mcp-secret");
			expect(
				session.lines.some((line) =>
					line.includes("https://connect.internal.example.com/mcp")
				)
			).toBe(true);
		} finally {
			await session.close();
		}
	});

	test("readOnly: true keeps only read-only tools; --services filters services", async () => {
		const readOnly = await connect(
			{
				env: {
					...NOTIFY_ENV,
					RYU_BOX_URL: "https://box.example.com",
					RYU_BOX_API_KEY: "b",
				},
			},
			{ readOnly: true }
		);
		try {
			expect(
				(await readOnly.client.listTools()).tools
					.map((tool) => tool.name)
					.sort()
			).toEqual(["box_list", "notify_echo"]);
		} finally {
			await readOnly.close();
		}
		const onlyBox = await connect({ env: NOTIFY_ENV }, { services: ["box"] });
		try {
			expect((await onlyBox.client.listTools()).tools).toEqual([]);
			expect(
				onlyBox.registration.skipped.map((entry) => entry.service)
			).toEqual(["box"]);
		} finally {
			await onlyBox.close();
		}
	});

	test("success results carry structuredContent { data, meta } and the same JSON text", async () => {
		const { client, close } = await connect({ env: NOTIFY_ENV });
		try {
			const result = await client.callTool({
				name: "notify_echo",
				arguments: { text: "hi" },
			});
			expect(result.isError).toBeFalsy();
			expect(result.structuredContent).toMatchObject({
				data: { echoed: "hi" },
				meta: { status: 0 },
			});
			const [content] = result.content as { type: string; text: string }[];
			expect(JSON.parse(content?.text ?? "")).toEqual(result.structuredContent);
		} finally {
			await close();
		}
	});

	test("error results carry isError and the RyuError code, never the key", async () => {
		const { client, close } = await connect(
			{
				env: NOTIFY_ENV,
				fetch: notifyUnauthorized(),
				maxRetries: 0,
			},
			{ readOnly: false }
		);
		try {
			const result = await client.callTool({
				name: "notify_publish",
				arguments: { title: "x" },
			});
			expect(result.isError).toBe(true);
			expect(result.structuredContent).toMatchObject({
				error: {
					code: "unauthorized",
					status: 401,
					service: "notify",
					requestId: "req_mcp",
				},
			});
			expect(JSON.stringify(result)).not.toContain("notify-mcp-secret");
		} finally {
			await close();
		}
	});

	test("error results keep the hint in its own field, not in the message", () => {
		const error = createRyuError({
			service: "notify",
			status: 401,
			code: "unauthorized",
			message: "bad key",
			hint: "Check RYU_NOTIFY_API_KEY.",
		});
		expect(error.message).toBe("bad key. Hint: Check RYU_NOTIFY_API_KEY.");
		const result = toolFailure(error);
		expect(result.structuredContent).toMatchObject({
			error: {
				message: "bad key",
				hint: "Check RYU_NOTIFY_API_KEY.",
				code: "unauthorized",
			},
		});
		const text = result.content[0];
		expect(text?.type === "text" ? text.text : "").not.toContain("Hint:");
	});

	test("a connection error's hint says to set the env var in the server entry, not a new Ryu() option", async () => {
		const { client, close } = await connect(
			{
				env: NOTIFY_ENV,
				fetch: () => Promise.reject(new TypeError("fetch failed")),
				maxRetries: 0,
			},
			{ readOnly: false }
		);
		try {
			const result = await client.callTool({
				name: "notify_publish",
				arguments: { title: "x" },
			});
			expect(result.isError).toBe(true);
			const { error } = result.structuredContent as {
				error: { code: string; hint: string };
			};
			expect(error.code).toBe("connection_error");
			expect(error.hint).toBe(
				`Could not reach Ryu Notify at https://notify.example.com. Check RYU_NOTIFY_URL. ${MCP_ENV_ADVICE} Run \`ryu-services doctor --check\` to test the connection.`
			);
			expect(error.hint).not.toContain("notify.baseUrl");
		} finally {
			await close();
		}
	});

	test("a missing-credential hint drops the SDK option and names the server entry's env", () => {
		const result = toolFailure(
			createRyuError({
				service: "box",
				status: 401,
				code: "unauthorized",
				message: "no key",
				hint: "Ryu Box requires a credential and none was sent. Set RYU_BOX_API_KEY (or box.apiKey).",
			})
		);
		expect(result.structuredContent).toMatchObject({
			error: {
				message: "no key",
				hint: `Ryu Box requires a credential and none was sent. Set RYU_BOX_API_KEY. ${MCP_ENV_ADVICE}`,
			},
		});
	});

	test("configuration messages and timeout hints are worded for an MCP server entry", () => {
		const result = toolFailure(
			new RyuConfigurationError({
				service: "managedAgents",
				status: 0,
				message:
					"Ryu Managed Agents needs a ryu_ key: set RYU_API_KEY or pass apiKey.",
				hint: "Set RYU_API_KEY (or pass apiKey to new Ryu()). See the docs.",
			})
		);
		expect(result.structuredContent).toMatchObject({
			error: {
				message: "Ryu Managed Agents needs a ryu_ key: set RYU_API_KEY.",
				hint: `Set RYU_API_KEY. ${MCP_ENV_ADVICE} See the docs.`,
			},
		});
		expect(
			mcpHintText(
				"box",
				"Ryu Box at http://127.0.0.1:1 did not respond in time (raise timeoutMs if the call is slow). Check RYU_BOX_URL (or box.baseUrl)."
			)
		).toBe(
			`Ryu Box at http://127.0.0.1:1 did not respond in time (raise --timeout in the MCP server entry's args if the call is slow). Check RYU_BOX_URL. ${MCP_ENV_ADVICE}`
		);
		// A hint naming no constructor option is left as it is.
		expect(mcpHintText("notify", "Check RYU_NOTIFY_API_KEY.")).toBe(
			"Check RYU_NOTIFY_API_KEY."
		);
	});

	test("a configuration error with no hint carries the MCP env advice in its message", () => {
		const result = toolFailure(
			new RyuConfigurationError({
				service: "managedAgents",
				status: 0,
				message:
					"Ryu Managed Agents needs a ryu_ key: set RYU_API_KEY or pass apiKey.",
			})
		);
		const { error } = result.structuredContent as {
			error: Record<string, unknown>;
		};
		expect(error.message).toBe(
			`Ryu Managed Agents needs a ryu_ key: set RYU_API_KEY. ${MCP_ENV_ADVICE}`
		);
		expect(error.hint ?? null).toBeNull();
		expect(String(error.message)).not.toContain("apiKey");
	});

	test("tool error hints name the host's command line when one delegates", () => {
		const error = createRyuError({
			service: "notify",
			status: 0,
			code: "connection_error",
			message: "fetch failed",
			hint: "Could not reach Ryu Notify. Run `ryu-services doctor --check` to test the connection.",
		});
		const result = toolFailure(error, { program: "ryu-cli services" });
		expect(JSON.stringify(result.structuredContent)).toContain(
			"Run `ryu-cli services doctor --check`"
		);
		expect(JSON.stringify(result.structuredContent)).not.toContain(
			"ryu-services doctor"
		);
	});

	test("the instructions keep the server name and name the host's doctor command", async () => {
		const { server } = createServicesMcpServer({
			config: { env: {} },
			log: () => undefined,
			modules: FAKE_MODULES,
			program: "ryu-cli services",
		});
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client({ name: "ryu-services-test", version: "1.0.0" });
		await client.connect(clientTransport);
		try {
			const instructions = client.getInstructions() ?? "";
			expect(instructions.startsWith("ryu-services: tools for")).toBe(true);
			expect(instructions).toContain(
				"Run `ryu-cli services doctor` in a terminal"
			);
			expect(instructions).not.toContain("`ryu-services doctor`");
		} finally {
			await client.close();
		}
	});

	test("tool names must carry the service prefix", () => {
		const { server } = createServicesMcpServer({
			config: { env: {} },
			log: () => undefined,
			modules: [],
		});
		expect(() =>
			registerServiceTools(server, new Ryu({ env: NOTIFY_ENV }), {
				config: { env: NOTIFY_ENV },
				log: () => undefined,
				modules: [
					{
						service: "notify",
						register(registrar) {
							registrar.tool({
								name: "publish",
								title: "Bad",
								description: "Missing prefix.",
								inputSchema: z.object({}),
								annotations: {
									readOnlyHint: true,
									destructiveHint: false,
									idempotentHint: true,
									openWorldHint: false,
								},
								run: () => null,
							});
						},
					},
				],
			})
		).toThrow("must be snake_case and start with notify_");
	});

	test("decides from the Ryu instance alone when no config is passed", async () => {
		const ryuOnly = new Ryu({
			env: {},
			notify: {
				baseUrl: "https://notify.example.com",
				apiKey: "notify-mcp-secret",
			},
		});
		const { server } = createServicesMcpServer({
			config: { env: {} },
			log: () => undefined,
			modules: [],
		});
		const lines: string[] = [];
		const registration = registerServiceTools(server, ryuOnly, {
			services: ["notify", "box", "gateway"],
			readOnly: false,
			log: (line) => lines.push(line),
			modules: [
				...FAKE_MODULES,
				{
					service: "gateway",
					register: FAKE_MODULES[1]?.register ?? (() => undefined),
				},
			],
		});
		expect(registration.services).toEqual(["notify"]);
		expect(registration.tools.sort()).toEqual([
			"notify_echo",
			"notify_publish",
		]);
		expect(registration.skipped.map((entry) => entry.service).sort()).toEqual([
			"box",
			"gateway",
		]);
		expect(lines.join("\n")).toContain("RYU_BOX_URL");
		expect(lines.join("\n")).toContain("RYU_GATEWAY_URL");

		// The reverse: env says Box is set, but the Ryu instance cannot reach it.
		const envBox = registerServiceTools(server, new Ryu({ env: {} }), {
			services: ["box"],
			log: () => undefined,
			modules: FAKE_MODULES,
			config: {
				env: { RYU_BOX_URL: "https://box.example.com", RYU_BOX_API_KEY: "b" },
			},
		});
		expect(envBox.services).toEqual([]);
		expect(envBox.skipped.map((entry) => entry.service)).toEqual(["box"]);
	});

	test("Ryu#isConfigured ignores defaults and honours env and options", () => {
		expect(new Ryu({ env: {} }).isConfigured("gateway")).toBe(false);
		expect(
			new Ryu({ env: { RYU_GATEWAY_TOKEN: "t" } }).isConfigured("gateway")
		).toBe(true);
		expect(new Ryu({ env: NOTIFY_ENV }).isConfigured("notify")).toBe(true);
		expect(
			new Ryu({
				env: { RYU_NOTIFY_URL: "https://n.example.com" },
			}).isConfigured("notify")
		).toBe(false);
		expect(
			new Ryu({ env: {}, apiKey: "ryu_x" }).isConfigured("managedAgents")
		).toBe(true);
	});

	test("a default alone does not count as configured", () => {
		expect(configurationProblem("gateway", { env: {} })).toContain(
			"RYU_GATEWAY_URL"
		);
		expect(
			configurationProblem("gateway", { env: { RYU_GATEWAY_TOKEN: "t" } })
		).toBeNull();
		expect(
			configurationProblem("gateway", {
				env: {},
				gateway: { baseUrl: "http://127.0.0.1:7981" },
			})
		).toBeNull();
		expect(
			configurationProblem("managedAgents", { env: {}, apiKey: "ryu_x" })
		).toBeNull();
		expect(
			configurationProblem("notify", {
				env: { RYU_NOTIFY_URL: "https://n.example.com" },
			})
		).toContain("RYU_NOTIFY_API_KEY");
	});

	test("hosted Mail counts as configured with only the ryu_ key", () => {
		expect(
			configurationProblem("mail", { env: { RYU_API_KEY: "ryu_mail" } })
		).toBeNull();
		expect(configurationProblem("mail", { env: {}, apiKey: "ryu_x" })).toBe(
			null
		);
		expect(configurationProblem("mail", { env: {} })).toContain("RYU_API_KEY");
	});

	test("skip reasons never carry the SDK's `Hint:` suffix", () => {
		const services = [
			"mail",
			"messaging",
			"notify",
			"box",
			"sites",
			"passport",
			"gateway",
			"managedAgents",
		] as const;
		for (const env of [
			{},
			{ RYU_BOX_URL: "nope", RYU_BOX_API_KEY: "k" },
			{ RYU_NOTIFY_URL: "nope", RYU_NOTIFY_API_KEY: "k" },
			{ RYU_API_KEY: "ryu_x" },
		]) {
			for (const service of services) {
				expect(configurationProblem(service, { env }) ?? "").not.toContain(
					"Hint:"
				);
			}
		}
	});

	test("skip reasons name alternative keys as alternatives", () => {
		expect(configurationProblem("mail", { env: {} })).toBe(
			"not configured (set one of: RYU_API_KEY or RYU_MAIL_GATEWAY_KEY for hosted Mail, or RYU_MAIL_URL and RYU_MAIL_API_KEY for a self-hosted server)"
		);
		const passport = configurationProblem("passport", { env: {} });
		expect(passport).toContain("set RYU_PASSPORT_URL and one of");
		expect(passport).toContain("RYU_PASSPORT_RUNTIME_KEY");
		expect(passport).not.toContain("RYU_PASSPORT_URL and RYU_PASSPORT_API_KEY");
		expect(configurationProblem("sites", { env: {} })).toBe(
			"not configured (set RYU_SITES_URL and RYU_SITES_API_KEY)"
		);
	});
});

describe("result helpers", () => {
	test("runTool turns unexpected throws into client_error results", async () => {
		const result = await runTool("box", () => {
			throw new Error("boom");
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			error: { code: "client_error", message: "boom", service: "box" },
		});
	});

	test("collectEvents stops at maxEvents, at the end, or at the time bound", async () => {
		async function* numbers(count: number) {
			for (let n = 0; n < count; n += 1) {
				yield n;
			}
		}
		expect(
			await collectEvents(numbers(10), { maxEvents: 3, timeoutMs: 1000 })
		).toEqual({
			events: [0, 1, 2],
			done: false,
			timedOut: false,
		});
		expect(
			await collectEvents(numbers(2), { maxEvents: 5, timeoutMs: 1000 })
		).toEqual({
			events: [0, 1],
			done: true,
			timedOut: false,
		});
		const never: AsyncIterable<number> = {
			[Symbol.asyncIterator]: () => ({
				next: () => new Promise<IteratorResult<number>>(() => undefined),
			}),
		};
		expect(await collectEvents(never, { maxEvents: 5, timeoutMs: 20 })).toEqual(
			{
				events: [],
				done: false,
				timedOut: true,
			}
		);
	});
});

interface StdioSession {
	readonly exitCode: number;
	/** Every stdout line, including anything written after the last reply. */
	readonly lines: string[];
	readonly replies: Map<number, { result?: unknown; error?: unknown }>;
	readonly stderr: string;
}

/**
 * Runs one MCP stdio session: initialize, then `requests`, then closes stdin
 * and drains stdout to the end so late writes (shutdown, logs) are seen too.
 */
async function stdioSession(
	command: string[],
	env: Record<string, string>,
	requests: { method: string; params: object }[]
): Promise<StdioSession> {
	const child = Bun.spawn(command, {
		cwd: PACKAGE_DIR,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			...env,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const send = (message: object) => {
		child.stdin.write(`${JSON.stringify(message)}\n`);
		child.stdin.flush();
	};
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const lines: string[] = [];
	const replies = new Map<number, { result?: unknown; error?: unknown }>();
	const readReply = async (id: number) => {
		while (!replies.has(id)) {
			while (!buffer.includes("\n")) {
				const chunk = await reader.read();
				if (chunk.done) {
					throw new Error(`stdout closed early: ${buffer}`);
				}
				buffer += decoder.decode(chunk.value, { stream: true });
			}
			const index = buffer.indexOf("\n");
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			lines.push(line);
			const message = JSON.parse(line) as {
				id?: number;
				result?: unknown;
				error?: unknown;
			};
			if (typeof message.id === "number") {
				replies.set(message.id, message);
			}
		}
	};
	send({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "stdio-test", version: "1.0.0" },
		},
	});
	await readReply(1);
	send({ jsonrpc: "2.0", method: "notifications/initialized" });
	let id = 2;
	for (const request of requests) {
		send({ jsonrpc: "2.0", id, ...request });
		await readReply(id);
		id += 1;
	}
	child.stdin.end();
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		buffer += decoder.decode(chunk.value, { stream: true });
	}
	buffer += decoder.decode();
	lines.push(...buffer.split("\n").filter((line) => line.trim() !== ""));
	const exitCode = await child.exited;
	const stderr = await new Response(child.stderr).text();
	return { exitCode, lines, replies, stderr };
}

/** The `jsonrpc` member of every stdout line (a non-JSON line throws). */
function jsonRpcVersions(lines: readonly string[]): unknown[] {
	return lines.map(
		(line) => (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc
	);
}

/** A spawned server with a fake tool module, so registration and tool calls run end to end. */
const FAKE_SERVER_SCRIPT = `
import * as z from "zod";
import { serveServicesMcp } from "./src/mcp/server.ts";
await serveServicesMcp({
	config: { env: { ...process.env } },
	modules: [{
		service: "notify",
		register(server) {
			server.tool({
				name: "notify_echo",
				title: "Echo",
				description: "Returns its input.",
				inputSchema: z.object({ text: z.string() }),
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
				run: (input) => ({ echoed: input.text }),
			});
		},
	}],
});
`;

describe("ryu-services mcp over stdio", () => {
	test("a workspace build's tool-error hint names its bun launch line for doctor", async () => {
		const session = await stdioSession(
			["bun", "src/bin.ts", "mcp"],
			{ ...NOTIFY_ENV, RYU_NOTIFY_URL: "http://127.0.0.1:1" },
			[
				{
					method: "tools/call",
					params: { name: "notify_usage", arguments: {} },
				},
			]
		);
		const reply = JSON.stringify(session.replies.get(2)?.result);
		expect(reply).toContain(`\`${workspaceProgram()} doctor --check\``);
		expect(reply).not.toMatch(BARE_PROGRAM);
		expect(session.stderr).not.toMatch(BARE_PROGRAM);
	}, 20_000);

	test("the bin's stdout carries only JSON-RPC; skipped services are logged to stderr", async () => {
		const session = await stdioSession(
			["bun", "src/bin.ts", "mcp"],
			NOTIFY_ENV,
			[{ method: "tools/list", params: {} }]
		);
		expect(session.replies.get(1)?.result).toMatchObject({
			serverInfo: { name: "ryu-services", version: CLI_VERSION },
		});
		const { instructions } = session.replies.get(1)?.result as {
			instructions?: string;
		};
		expect(instructions).toContain("Registered services: notify.");
		expect(instructions).toContain("Mode: read-only.");
		const listed = session.replies.get(2)?.result as {
			tools: { name: string; annotations?: { readOnlyHint?: boolean } }[];
		};
		// Only Notify is configured, and read-only is the default: its read
		// tools are listed, plus the credential-free status tools of Messaging
		// and Mail, which need no configuration.
		expect(listed.tools.length).toBeGreaterThan(0);
		for (const tool of listed.tools) {
			if (!["mail_status", "messaging_status"].includes(tool.name)) {
				expect(tool.name).toStartWith("notify_");
			}
			expect(tool.annotations?.readOnlyHint).toBe(true);
		}
		expect(instructions).toContain(
			"Without configuration, messaging_status, mail_status still run: they report whether each service is available on its server, need no credentials and send none."
		);
		// The bin run from this checkout is a workspace build: its log lines
		// name the `bun <bin.ts>` launch line, never an uninstalled ryu-services.
		expect(session.stderr).toContain(
			`${workspaceProgram()} mcp: read-only mode`
		);
		expect(session.stderr).not.toMatch(BARE_PROGRAM);
		expect(session.lines.length).toBeGreaterThan(0);
		expect(jsonRpcVersions(session.lines)).toEqual(
			session.lines.map(() => "2.0")
		);
		expect(session.stderr).toContain("skipping box");
		expect(session.stderr).not.toContain("notify-mcp-secret");
		expect(session.exitCode).toBe(0);
	}, 20_000);

	test("registering and calling a tool writes nothing but JSON-RPC to stdout", async () => {
		const session = await stdioSession(
			["bun", "-e", FAKE_SERVER_SCRIPT],
			NOTIFY_ENV,
			[
				{ method: "tools/list", params: {} },
				{
					method: "tools/call",
					params: { name: "notify_echo", arguments: { text: "hi" } },
				},
			]
		);
		expect(session.replies.get(2)?.result).toMatchObject({
			tools: [{ name: "notify_echo" }],
		});
		expect(session.replies.get(3)?.result).toMatchObject({
			structuredContent: { data: { echoed: "hi" } },
		});
		expect(session.lines.length).toBeGreaterThan(0);
		expect(jsonRpcVersions(session.lines)).toEqual(
			session.lines.map(() => "2.0")
		);
		expect(session.lines).toHaveLength(3);
		expect(session.stderr).toContain("skipping connect");
		expect(session.exitCode).toBe(0);
	}, 20_000);
});

/** An installed (published) CLI, which names itself `ryu-services`. */
const INSTALLED_VERSION = "1.2.3";

/** A command-line `ryu-services` (not a package name or a path). */
const BARE_PROGRAM = /(?<![\w"@/.-])ryu-services(?![\w"-])/u;

/** Runs `ryu-services <argv>` against an empty stdin; returns its exit code and stderr. */
async function runMcpCli(
	argv: string[],
	env: Record<string, string>,
	npmPublishedVersion: string | null = INSTALLED_VERSION
) {
	const input = new PassThrough();
	let stderr = "";
	const running = runCli(argv, {
		env,
		npmPublishedVersion,
		mcpStdio: { input, output: new PassThrough() },
		stderr: { write: (chunk: string) => (stderr += chunk) },
		stdout: { write: () => true },
	});
	input.end();
	const exitCode = await running;
	return { exitCode, stderr };
}

describe("ryu-services mcp modes", () => {
	const notifyTools = RYU_TOOLS.filter((tool) => tool.service === "notify");
	const notifyReads = notifyTools.filter(
		(tool) => tool.annotations.readOnlyHint
	);

	test("defaults to read-only and says so on stderr", async () => {
		const run = await runMcpCli(["mcp", "--services", "notify"], NOTIFY_ENV);
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toContain(
			`ryu-services mcp: read-only mode, ${notifyReads.length} tool`
		);
		expect(run.stderr).toContain("Pass --allow-writes");
	});

	test("--read-only is an accepted no-op alias for the default", async () => {
		const run = await runMcpCli(
			["mcp", "--services", "notify", "--read-only"],
			NOTIFY_ENV
		);
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toContain(
			`ryu-services mcp: read-only mode, ${notifyReads.length} tool`
		);
	});

	test("--allow-writes registers the write tools and says so on stderr", async () => {
		expect(notifyTools.length).toBeGreaterThan(notifyReads.length);
		const run = await runMcpCli(
			["mcp", "--services", "notify", "--allow-writes"],
			NOTIFY_ENV
		);
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toContain(
			`ryu-services mcp: writes allowed (--allow-writes), ${notifyTools.length} tools registered`
		);
	});

	test("--allow-writes with --read-only is a usage error", async () => {
		const run = await runMcpCli(
			["mcp", "--allow-writes", "--read-only"],
			NOTIFY_ENV
		);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("not both");
		expect(run.stderr).not.toContain("ryu-services mcp: read-only mode");
	});

	test("a workspace build's log lines name its bun launch line", async () => {
		const launch = workspaceProgram();
		const run = await runMcpCli(["mcp", "--services", "notify"], {}, null);
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toContain(
			`${launch} mcp: no service is configured, so 0 tools are registered. Run \`${launch} doctor\``
		);
		expect(run.stderr).not.toMatch(BARE_PROGRAM);
	});
});

describe("ryu-services mcp with nothing configured", () => {
	test("says on stderr that 0 tools are registered and points at doctor", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let stderr = "";
		let stdout = "";
		output.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		const running = runCli(["mcp", "--services", "notify,passport"], {
			env: {},
			npmPublishedVersion: INSTALLED_VERSION,
			mcpStdio: { input, output },
			stderr: { write: (chunk: string) => (stderr += chunk) },
			stdout: { write: () => true },
		});
		input.end();
		expect(await running).toBe(0);
		expect(stderr).toContain("skipping notify");
		expect(stderr).toContain(
			"no service is configured, so 0 tools are registered. Run `ryu-services doctor`"
		);
		// The configuration hint comes first, and nothing suggests widening
		// the agent's powers to fix an empty tool list.
		expect(stderr.indexOf("no service is configured")).toBeLessThan(
			stderr.indexOf("read-only mode, 0 tools registered")
		);
		expect(stderr).not.toContain("Pass --allow-writes");
		expect(stdout).toBe("");
	});

	test("under ryu-cli services, every stderr line names that command", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let stderr = "";
		const running = runCli(["mcp", "--services", "notify,passport"], {
			env: {},
			program: "ryu-cli services",
			mcpStdio: { input, output },
			stderr: { write: (chunk: string) => (stderr += chunk) },
			stdout: { write: () => true },
		});
		input.end();
		expect(await running).toBe(0);
		expect(stderr).toContain("ryu-cli services mcp: skipping notify");
		expect(stderr).toContain("Run `ryu-cli services doctor`");
		expect(stderr).not.toMatch(/(?<![\w"@/.-])ryu-services /u);
	});
});

describe("credential-free status tools", () => {
	interface Seen {
		headers: Headers;
		url: string;
	}
	function recordingFetch(seen: Seen[]): RyuFetch {
		return async (input, init) => {
			const request = new Request(input, init);
			seen.push({ headers: request.headers, url: request.url });
			const path = new URL(request.url).pathname;
			return Response.json(
				path === "/api/messaging/status"
					? {
							apiVersion: "v1",
							configured: true,
							channels: { sms: true, mms: false, voice: true, whatsapp: false },
						}
					: {
							apiVersion: "v1",
							configured: true,
							domain: "mail.example.com",
							domainMode: "managed",
							inbound: "sns",
							sendConfigured: true,
						}
			);
		};
	}

	async function serve(env: Record<string, string>, services?: string[]) {
		const seen: Seen[] = [];
		const lines: string[] = [];
		const { server, registration } = createServicesMcpServer({
			config: { env, fetch: recordingFetch(seen), maxRetries: 0 },
			log: (line) => lines.push(line),
			...(services === undefined
				? {}
				: { services: services as ("mail" | "messaging" | "notify")[] }),
		});
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		const client = new Client({ name: "status-test", version: "1.0.0" });
		await client.connect(clientTransport);
		return { client, lines, registration, seen };
	}

	test("run without keys on the default control plane and send none", async () => {
		const { client, registration, seen } = await serve({});
		try {
			const messaging = await client.callTool({
				name: "messaging_status",
				arguments: {},
			});
			expect(messaging.isError).toBeFalsy();
			expect(messaging.structuredContent).toMatchObject({
				data: { configured: true, channels: { sms: true } },
			});
			const mail = await client.callTool({
				name: "mail_status",
				arguments: {},
			});
			expect(mail.isError).toBeFalsy();
			expect(mail.structuredContent).toMatchObject({
				data: { configured: true, sendConfigured: true, domainMode: "managed" },
			});
			expect(seen.map((call) => call.url)).toEqual([
				"https://api.ryuhq.com/api/messaging/status",
				"https://api.ryuhq.com/api/mail/status",
			]);
			for (const call of seen) {
				for (const header of [
					"authorization",
					"x-api-key",
					"x-gateway-key",
					"x-ryu-organization",
				]) {
					expect({
						url: call.url,
						header,
						sent: call.headers.has(header),
					}).toEqual({ url: call.url, header, sent: false });
				}
			}
			expect(registration.services).toEqual([]);
		} finally {
			await client.close();
		}
	});

	test("a ryu_ key without its organization is never sent by the status tools", async () => {
		const { client, registration, seen } = await serve(
			{
				RYU_API_KEY: "ryu_status_secret",
				RYU_MAIL_URL: "https://mail.self.example",
			},
			["messaging", "mail"]
		);
		try {
			// Messaging needs the organization too, so it is not configured;
			// the self-hosted Mail URL has no bearer, and its status route is
			// guarded, so mail_status is not registered at all.
			expect(registration.tools).toEqual(["messaging_status"]);
			await client.callTool({ name: "messaging_status", arguments: {} });
			expect(seen).toHaveLength(1);
			expect(seen[0]?.headers.has("x-api-key")).toBe(false);
			expect(seen[0]?.headers.has("x-ryu-organization")).toBe(false);
			expect(
				registration.skipped.find((entry) => entry.service === "mail")?.reason
			).not.toContain("mail_status");
		} finally {
			await client.close();
		}
	});

	test("follow RYU_API_URL and a control-plane RYU_MAIL_URL", async () => {
		const { client, seen } = await serve({
			RYU_API_URL: "https://cp.example.com",
			RYU_MAIL_URL: "https://cp.example.com/",
		});
		try {
			await client.callTool({ name: "messaging_status", arguments: {} });
			await client.callTool({ name: "mail_status", arguments: {} });
			expect(seen.map((call) => call.url)).toEqual([
				"https://cp.example.com/api/messaging/status",
				"https://cp.example.com/api/mail/status",
			]);
		} finally {
			await client.close();
		}
	});

	test("a control-plane RYU_MAIL_URL without a key asks for a hosted key, not the self-hosted bearer", async () => {
		const { client, lines, registration, seen } = await serve(
			{ RYU_MAIL_URL: "https://api.ryuhq.com" },
			["mail"]
		);
		try {
			expect(registration.tools).toEqual(["mail_status"]);
			const reason = registration.skipped.find(
				(entry) => entry.service === "mail"
			)?.reason;
			expect(reason).toBe(
				"not configured (set one of: RYU_API_KEY or RYU_MAIL_GATEWAY_KEY for hosted Mail); only mail_status is registered, which needs no credentials and sends none"
			);
			expect(reason).not.toContain("RYU_MAIL_API_KEY");
			expect(lines.join("\n")).not.toContain("RYU_MAIL_API_KEY");
			await client.callTool({ name: "mail_status", arguments: {} });
			expect(seen.map((call) => call.url)).toEqual([
				"https://api.ryuhq.com/api/mail/status",
			]);
			expect(seen[0]?.headers.has("x-api-key")).toBe(false);
			expect(seen[0]?.headers.has("authorization")).toBe(false);
		} finally {
			await client.close();
		}
	});

	test("a configured service registers them like its other tools, keys included", async () => {
		const { client, registration, seen } = await serve({
			RYU_API_KEY: "ryu_status_secret",
			RYU_ORGANIZATION_ID: "org_1",
		});
		try {
			expect(registration.services).toEqual([
				"managedAgents",
				"messaging",
				"mail",
			]);
			expect(registration.credentialFree).toEqual([]);
			expect(registration.tools).toContain("messaging_status");
			expect(registration.tools).toContain("mail_status");
			await client.callTool({ name: "mail_status", arguments: {} });
			expect(seen[0]?.headers.get("x-api-key")).toBe("ryu_status_secret");
		} finally {
			await client.close();
		}
	});

	test("--services limits them, and --allow-writes adds no other tool of an unconfigured service", async () => {
		const notifyOnly = await serve(NOTIFY_ENV, ["notify"]);
		expect(notifyOnly.registration.tools).not.toContain("messaging_status");
		expect(notifyOnly.registration.tools).not.toContain("mail_status");
		await notifyOnly.client.close();

		const seen: Seen[] = [];
		const writes = registerServiceTools(
			createServicesMcpServer({
				config: { env: {} },
				log: () => undefined,
				modules: [],
			}).server,
			new Ryu({ env: {}, fetch: recordingFetch(seen) }),
			{ services: ["messaging"], readOnly: false, log: () => undefined }
		);
		expect(writes.tools).toEqual(["messaging_status"]);
		expect(writes.withheld).toEqual([]);
		expect(writes.skipped.map((entry) => entry.service)).toEqual(["messaging"]);
	});

	test("the startup lines and instructions say only status tools are registered", async () => {
		const { client, registration } = await serve({}, ["messaging", "notify"]);
		try {
			const text = client.getInstructions() ?? "";
			expect(text).toContain(
				"No service is configured, so only the credential-free status tool messaging_status is registered"
			);
			expect(text).toContain("- messaging: not configured");
			expect(emptyToolsLine(registration, {})).toBe(
				"ryu-services mcp: no service is configured, so only the credential-free status tool messaging_status is registered. Run `ryu-services doctor` to see what resolves."
			);
			expect(mcpModeLine(registration)).toBe(
				"ryu-services mcp: read-only mode, 1 tool registered."
			);
		} finally {
			await client.close();
		}
	});

	test("every credential-free registry tool is read-only and takes no arguments", () => {
		const free = RYU_TOOLS.filter((tool) => tool.credentialFree === true);
		expect(free.map((tool) => tool.name)).toEqual([
			"messaging_status",
			"mail_status",
		]);
		for (const tool of free) {
			expect(tool.annotations.readOnlyHint).toBe(true);
			expect(Object.keys(tool.inputSchema.shape)).toEqual([]);
		}
	});
});

describe("ryu-services mcp with only Connect selected", () => {
	test("says no tool-bearing service is selected, not that configuration is missing", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let stderr = "";
		const running = runCli(["mcp", "--services", "connect"], {
			env: {
				RYU_CONNECT_URL: "https://connect.example.com",
				RYU_CONNECT_API_KEY: "connect-mcp-secret",
			},
			mcpStdio: { input, output },
			stderr: { write: (chunk: string) => (stderr += chunk) },
			stdout: { write: () => true },
		});
		input.end();
		expect(await running).toBe(0);
		expect(stderr).toContain("skipping connect");
		expect(stderr).not.toContain("no service is configured");
		expect(stderr).toContain(
			"no tool-bearing service is selected, so 0 tools are registered. Connect has no tools here because it is an MCP server itself; point your MCP client at https://connect.example.com/mcp"
		);
		expect(stderr).not.toContain("connect-mcp-secret");
	});

	test("with Connect unconfigured, nothing claims it is configured", async () => {
		const session = await connect({ env: {} }, { services: ["connect"] });
		try {
			const text = session.client.getInstructions() ?? "";
			expect(text).toContain("No tool-bearing service is selected");
			expect(text).not.toContain("No env var is missing");
			expect(text).toContain("$RYU_CONNECT_URL/mcp");
		} finally {
			await session.close();
		}
		const line =
			emptyToolsLine(
				{
					services: [],
					skipped: [{ service: "connect", reason: "no tools" }],
					tools: [],
				},
				{}
			) ?? "";
		expect(line).toContain(
			"itself; point your MCP client at $RYU_CONNECT_URL/mcp"
		);
		expect(line).not.toContain(": Point");
	});

	test("the instructions do not send the person to set env vars", async () => {
		const session = await connect(
			{
				env: {
					RYU_CONNECT_URL: "https://connect.example.com",
					RYU_CONNECT_API_KEY: "connect-mcp-secret",
				},
			},
			{ services: ["connect"] }
		);
		try {
			const text = session.client.getInstructions() ?? "";
			expect(text).toContain("No tool-bearing service is selected");
			expect(text).not.toContain("No service is configured");
			expect(text).not.toContain("sets the env vars listed below");
			expect(text).not.toContain("No env var is missing");
			expect(text).toContain("$RYU_CONNECT_URL/mcp");
			expect(text).not.toContain("connect.example.com");
		} finally {
			await session.close();
		}
	});

	test("emptyToolsLine stays quiet when selected services registered", () => {
		expect(
			emptyToolsLine({ services: ["notify"], skipped: [], tools: [] }, {})
		).toBeNull();
		expect(
			emptyToolsLine({ services: [], skipped: [], tools: [] }, {})
		).toContain("no service is configured");
	});
});

describe("unregistered-tool reasons", () => {
	test("a hinted configuration error without missing settings drops the hint", () => {
		const error = new RyuConfigurationError({
			service: "notify",
			status: 0,
			code: "configuration_error",
			message: "RYU_NOTIFY_URL is not a valid URL.",
			details: null,
			hint: "Use an absolute http(s) URL.",
		});
		expect(error.message).toContain("Hint:");
		const reason = configurationErrorReason("notify", error);
		expect(reason).toBe("RYU_NOTIFY_URL is not a valid URL.");
		expect(reason).not.toContain("Hint:");
		expect(reason).not.toContain("absolute http(s)");
	});

	test("missing settings are spelled out instead of the message", () => {
		const reason = configurationErrorReason("notify", {
			details: { missing: ["RYU_NOTIFY_URL"] },
			hint: "Set RYU_NOTIFY_URL.",
			message: "Notify is not configured. Hint: Set RYU_NOTIFY_URL.",
		});
		expect(reason.startsWith("not configured (")).toBe(true);
		expect(reason).not.toContain("Hint:");
	});
});

describe("mcpInstructions credential-free wording", () => {
	const base = {
		readOnly: true,
		services: ["notify"] as const,
		skipped: [],
		tools: ["notify_events_list"],
		withheld: [],
	};

	test("one free status tool reads in the singular", () => {
		const text = mcpInstructions({
			...base,
			services: [...base.services],
			credentialFree: [{ service: "mail", tools: ["mail_status"] }],
		});
		expect(text).toContain(
			"Without configuration, mail_status still runs: it reports whether the service is available on its server, needs no credentials and sends none."
		);
	});

	test("two free status tools agree in the plural", () => {
		const text = mcpInstructions({
			...base,
			services: [...base.services],
			credentialFree: [
				{ service: "messaging", tools: ["messaging_status"] },
				{ service: "mail", tools: ["mail_status"] },
			],
		});
		expect(text).toContain(
			"Without configuration, messaging_status, mail_status still run: they report whether each service is available on its server, need no credentials and send none."
		);
		expect(text).not.toContain("needs no credentials");
	});
});
