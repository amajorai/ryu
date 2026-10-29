import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { RyuFetch } from "@ryuhq/services";
import { type CliIo, runCli } from "../cli.ts";
import { chatBody, gatewayCommands } from "../commands/gateway.ts";
import { createServicesMcpServer } from "../mcp/server.ts";
import { commandLine } from "../registry.ts";

interface Recorded {
	body: string | null;
	headers: Headers;
	method: string;
	url: string;
}

function stubFetch(respond: (request: Recorded) => Response) {
	const calls: Recorded[] = [];
	const fetch: RyuFetch = async (input, init) => {
		const request = new Request(input, init);
		const recorded: Recorded = {
			body: request.body === null ? null : await request.text(),
			headers: request.headers,
			method: request.method,
			url: request.url,
		};
		calls.push(recorded);
		return respond(recorded);
	};
	return { calls, fetch };
}

const TOKEN = "gw_cli_secret_0123456789";
const ENV = {
	RYU_GATEWAY_TOKEN: TOKEN,
	RYU_GATEWAY_URL: "http://127.0.0.1:7981",
};

const COMPLETION = {
	choices: [
		{
			finish_reason: "stop",
			index: 0,
			message: { content: "Four.", role: "assistant" },
		},
	],
	id: "chatcmpl-cli",
	model: "openai/gpt-4o-mini",
	object: "chat.completion",
};

function sse(chunks: readonly unknown[]): Response {
	const text = `${chunks
		.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
		.join("")}data: [DONE]\n\n`;
	return new Response(text, {
		headers: { "content-type": "text/event-stream" },
	});
}

/** A Gateway stub routed by `METHOD /path`. */
function gatewayServer(): (request: Recorded) => Response {
	return (request) => {
		const url = new URL(request.url);
		switch (`${request.method} ${url.pathname}`) {
			case "GET /v1/models":
				return Response.json({
					data: [{ id: "openai/gpt-4o-mini", object: "model" }],
					object: "list",
				});
			case "POST /v1/chat/completions": {
				const body = JSON.parse(request.body ?? "{}") as { stream?: boolean };
				return body.stream
					? sse([
							{ choices: [{ delta: { content: "Fo" }, index: 0 }] },
							{ choices: [{ delta: { content: "ur." }, index: 0 }] },
						])
					: Response.json(COMPLETION);
			}
			default:
				return Response.json(
					{
						error: {
							code: "model_not_found",
							message: "unknown",
							type: "model_not_found",
						},
					},
					{ status: 404 }
				);
		}
	};
}

interface Run {
	code: number;
	stderr: string;
	stdout: string;
}

async function run(
	argv: string[],
	io: Partial<CliIo> & { env: Record<string, string> }
): Promise<Run> {
	let stdout = "";
	let stderr = "";
	const code = await runCli(argv, {
		stdin: "",
		fetch: () => Promise.reject(new Error("unexpected network call")),
		stdout: { write: (chunk: string) => (stdout += chunk) },
		stderr: { write: (chunk: string) => (stderr += chunk) },
		...io,
	});
	return { code, stdout, stderr };
}

describe("ryu-services gateway", () => {
	test("registers the design §10 commands", () => {
		expect(
			gatewayCommands.map((command) => commandLine("gateway", command))
		).toEqual(["ryu-services gateway models", "ryu-services gateway chat"]);
		expect(
			gatewayCommands
				.filter((command) => command.readOnly)
				.map((command) => command.path.join(" "))
		).toEqual(["models"]);
	});

	test("models lists with the bearer token", async () => {
		const { calls, fetch } = stubFetch(gatewayServer());
		const result = await run(["gateway", "models", "--json"], {
			env: ENV,
			fetch,
		});
		expect(result.code).toBe(0);
		expect(calls[0]?.url).toBe("http://127.0.0.1:7981/v1/models");
		expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		const printed = JSON.parse(result.stdout) as {
			data: { data: { id: string }[] };
			meta: { status: number };
		};
		expect(printed.data.data[0]?.id).toBe("openai/gpt-4o-mini");
		expect(printed.meta.status).toBe(200);
		expect(result.stdout).not.toContain(TOKEN);
	});

	test("models prints one model per line in human mode (the list convention)", async () => {
		const { fetch } = stubFetch(gatewayServer());
		const result = await run(["gateway", "models"], { env: ENV, fetch });
		expect(result.code).toBe(0);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({
			id: "openai/gpt-4o-mini",
		});
		expect(result.stderr).toBe("");
	});

	test("chat prints the assistant text; --json prints the completion and meta", async () => {
		const { calls, fetch } = stubFetch(gatewayServer());
		const human = await run(
			[
				"gateway",
				"chat",
				"What is 2+2?",
				"--model",
				"openai/gpt-4o-mini",
				"--system",
				"Answer in one word.",
				"--max-tokens",
				"16",
				"--temperature",
				"0",
			],
			{ env: ENV, fetch }
		);
		expect(human.code).toBe(0);
		expect(human.stdout).toBe("Four.\n");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			max_tokens: 16,
			messages: [
				{ content: "Answer in one word.", role: "system" },
				{ content: "What is 2+2?", role: "user" },
			],
			model: "openai/gpt-4o-mini",
			stream: false,
			temperature: 0,
		});
		expect(calls[0]?.headers.get("idempotency-key")).toBeNull();
		const json = await run(
			["gateway", "chat", "hi", "--model", "openai/gpt-4o-mini", "--json"],
			{ env: ENV, fetch }
		);
		const printed = JSON.parse(json.stdout) as {
			data: { id: string };
			meta: { attempts: number };
		};
		expect(printed.data.id).toBe("chatcmpl-cli");
		expect(printed.meta.attempts).toBe(1);
	});

	test("chat --stream prints one JSON chunk per line", async () => {
		const { calls, fetch } = stubFetch(gatewayServer());
		const result = await run(
			["gateway", "chat", "hi", "--model", "m", "--stream"],
			{ env: ENV, fetch }
		);
		expect(result.code).toBe(0);
		const lines = result.stdout.trim().split("\n");
		expect(
			lines.map(
				(line) =>
					(JSON.parse(line) as { choices: { delta: { content: string } }[] })
						.choices[0]?.delta.content
			)
		).toEqual(["Fo", "ur."]);
		expect(calls[0]?.headers.get("accept")).toBe("text/event-stream");
	});

	test("usage errors exit 2 without a request", async () => {
		const { calls, fetch } = stubFetch(gatewayServer());
		for (const argv of [
			["gateway", "chat", "--model", "m"],
			["gateway", "chat", "hi"],
			["gateway", "chat", "a", "b", "--model", "m"],
			["gateway", "chat", "hi", "--model", "m", "--max-tokens", "0"],
			["gateway", "chat", "hi", "--model", "m", "--temperature", "3"],
			["gateway", "models", "extra"],
		]) {
			const result = await run(argv, { env: ENV, fetch });
			expect(`${argv.join(" ")} -> ${result.code}`).toBe(
				`${argv.join(" ")} -> 2`
			);
		}
		expect(calls).toHaveLength(0);
	});

	test("a Gateway error exits 1 with its code", async () => {
		const { fetch } = stubFetch(() =>
			Response.json(
				{
					error: {
						code: "provider_error",
						message: "Upstream provider request failed.",
						type: "provider_error",
					},
				},
				{ status: 502 }
			)
		);
		const result = await run(["gateway", "chat", "hi", "--model", "m"], {
			env: ENV,
			fetch,
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("provider_error");
	});

	test("--dry-run prints curl with $RYU_GATEWAY_TOKEN and sends nothing", async () => {
		const { calls, fetch } = stubFetch(gatewayServer());
		const result = await run(
			["gateway", "chat", "hi", "--model", "m", "--dry-run"],
			{ env: ENV, fetch }
		);
		expect(result.code).toBe(0);
		expect(calls).toHaveLength(0);
		expect(result.stdout).toContain("curl");
		expect(result.stdout).toContain(
			"http://127.0.0.1:7981/v1/chat/completions"
		);
		expect(result.stdout).toContain("$RYU_GATEWAY_TOKEN");
		expect(result.stdout).not.toContain(TOKEN);
	});

	test("chatBody omits unset options", () => {
		expect(chatBody({ model: "m", prompt: "hi" })).toEqual({
			messages: [{ content: "hi", role: "user" }],
			model: "m",
		});
	});
});

async function connectMcp(
	env: Record<string, string>,
	fetch: RyuFetch,
	readOnly = false
) {
	const { server, registration } = createServicesMcpServer({
		config: { env, fetch },
		log: () => undefined,
		services: ["gateway"],
		readOnly,
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "gateway-test", version: "1.0.0" });
	await client.connect(clientTransport);
	return { client, registration };
}

describe("gateway MCP tools", () => {
	test("registers the two design §9 tools with honest annotations", async () => {
		const { fetch } = stubFetch(gatewayServer());
		const { client, registration } = await connectMcp(ENV, fetch);
		try {
			expect(registration.tools).toEqual([
				"gateway_list_models",
				"gateway_chat",
			]);
			const { tools } = await client.listTools();
			const byName = new Map(tools.map((tool) => [tool.name, tool]));
			expect(byName.get("gateway_list_models")?.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
			});
			expect(byName.get("gateway_chat")?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			});
		} finally {
			await client.close();
		}
	});

	test("read-only mode keeps only gateway_list_models", async () => {
		const { fetch } = stubFetch(gatewayServer());
		const { client, registration } = await connectMcp(ENV, fetch, true);
		try {
			expect(registration.tools).toEqual(["gateway_list_models"]);
		} finally {
			await client.close();
		}
	});

	test("the local default alone registers no Gateway tools", async () => {
		const { fetch } = stubFetch(gatewayServer());
		const { client, registration } = await connectMcp({}, fetch);
		try {
			expect(registration.tools).toEqual([]);
			expect(registration.skipped.map((entry) => entry.service)).toEqual([
				"gateway",
			]);
		} finally {
			await client.close();
		}
	});

	test("list_models and chat answer { data, meta }; errors are tool errors", async () => {
		const { calls, fetch } = stubFetch(gatewayServer());
		const { client } = await connectMcp(ENV, fetch);
		try {
			const models = await client.callTool({
				name: "gateway_list_models",
				arguments: {},
			});
			expect(models.isError).toBeFalsy();
			expect(
				(models.structuredContent as { data: { data: { id: string }[] } }).data
					.data[0]?.id
			).toBe("openai/gpt-4o-mini");
			const chat = await client.callTool({
				name: "gateway_chat",
				arguments: {
					maxTokens: 8,
					model: "openai/gpt-4o-mini",
					prompt: "What is 2+2?",
				},
			});
			expect(chat.isError).toBeFalsy();
			expect(
				(
					chat.structuredContent as {
						data: { choices: { message: { content: string } }[] };
					}
				).data.choices[0]?.message.content
			).toBe("Four.");
			expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
				max_tokens: 8,
				messages: [{ content: "What is 2+2?", role: "user" }],
				model: "openai/gpt-4o-mini",
				stream: false,
			});
			const failing = stubFetch(() =>
				Response.json(
					{
						error: {
							code: "invalid_api_key",
							message: "bad key",
							type: "invalid_api_key",
						},
					},
					{ status: 401 }
				)
			);
			const other = await connectMcp(ENV, failing.fetch);
			try {
				const denied = await other.client.callTool({
					name: "gateway_list_models",
					arguments: {},
				});
				expect(denied.isError).toBe(true);
				expect(JSON.stringify(denied)).toContain("invalid_api_key");
				expect(JSON.stringify(denied)).not.toContain(TOKEN);
			} finally {
				await other.client.close();
			}
		} finally {
			await client.close();
		}
	});
});
