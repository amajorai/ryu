import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	type AgentInput,
	createAgentVersion,
	fetchAgent,
	getAgentVersionSource,
	listAgentVersions,
	removeAgentAccount,
	restoreAgentVersion,
	switchAgentAccount,
	toAgentBody,
} from "./agents.ts";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";

describe("ACP account request bodies", () => {
	test("returns a required native login without claiming a credential switch", async () => {
		const originalFetch = globalThis.fetch;
		Reflect.set(globalThis, "fetch", async () =>
			Response.json({ switched: false, reauthenticate: true })
		);
		try {
			const result = await switchAgentAccount(
				{ token: "test-node", url: "http://127.0.0.1:7980", userJwt: null },
				"acp:kiro",
				{ accountId: "saved-account" }
			);
			expect(result).toEqual({ reauthenticate: true });
		} finally {
			Reflect.set(globalThis, "fetch", originalFetch);
		}
	});
	test("switch and removal transmit JSON objects rather than encoded strings", async () => {
		const originalFetch = globalThis.fetch;
		const bodies: GatewayJsonValue[] = [];
		Reflect.set(
			globalThis,
			"fetch",
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = z.string().parse(init?.body);
				bodies.push(gatewayJsonValueSchema.parse(JSON.parse(body)));
				return Response.json({ switched: true, removed: true });
			}
		);
		try {
			const target = {
				token: "test-node",
				url: "http://127.0.0.1:7980",
				userJwt: null,
			};
			await switchAgentAccount(target, "acp:pi", {
				accountId: "account-a",
				provider: "claude-pro-max",
			});
			await removeAgentAccount(target, "acp:pi", "account-a");
			expect(bodies).toEqual([
				{ accountId: "account-a", provider: "claude-pro-max" },
				{ accountId: "account-a" },
			]);
		} finally {
			Reflect.set(globalThis, "fetch", originalFetch);
		}
	});
});

describe("agent setup model slot wire format", () => {
	test("sends the legacy fields and the authoritative chat model slot", () => {
		const input: AgentInput = {
			chatModel: {
				engine: "openrouter",
				modelId: "anthropic/claude-sonnet",
			},
			description: null,
			engine: "acp:pi",
			model: "anthropic/claude-sonnet",
			name: "Researcher",
			systemPrompt: "Be precise.",
			tools: ["*"],
		};

		expect(toAgentBody(input)).toMatchObject({
			chat_model: {
				engine: "openrouter",
				model_id: "anthropic/claude-sonnet",
			},
			engine: "acp:pi",
			model: "anthropic/claude-sonnet",
		});
	});

	test("sends a personality profile inside the agent persona slot", () => {
		const input: AgentInput = {
			description: null,
			engine: "acp:pi",
			name: "ELI5 helper",
			persona: {
				display_name: "Aria",
				output_style_id: "eli5",
				tone: null,
			},
			systemPrompt: "Explain things clearly.",
			tools: ["*"],
		};

		expect(toAgentBody(input).persona).toMatchObject({
			output_style_id: "eli5",
		});
	});

	test("keeps the runtime engine separate from the chat provider slot", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async (..._args: Parameters<typeof originalFetch>) =>
				Response.json({
					agent: {
						chat_model: {
							engine: "openrouter",
							model_id: "openai/gpt-5-mini",
						},
						engine: "acp:pi",
						id: "researcher",
						name: "Researcher",
						persona: {
							display_name: null,
							output_style_id: "eli5",
							tone: null,
						},
					},
					source: '{"id":"researcher"}',
				}),
			{ preconnect: originalFetch.preconnect }
		);
		try {
			const agent = await fetchAgent(
				{ token: null, url: "http://127.0.0.1:7980", userJwt: null },
				"researcher"
			);
			expect(agent.engine).toBe("acp:pi");
			expect(agent.chatModel).toEqual({
				engine: "openrouter",
				modelId: "openai/gpt-5-mini",
			});
			expect(agent.persona?.output_style_id).toBe("eli5");
			expect(agent.source).toBe('{"id":"researcher"}');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("maps complete agent version history and keeps the canonical diff source", async () => {
		const originalFetch = globalThis.fetch;
		const requests: string[] = [];
		globalThis.fetch = Object.assign(
			async (...[input, init]: Parameters<typeof originalFetch>) => {
				requests.push(`${init?.method ?? "GET"} ${String(input)}`);
				const url = String(input);
				if (url.endsWith("/versions")) {
					if (init?.method === "POST") {
						return Response.json({
							version: {
								agent_id: "agent_1",
								created_at: 10,
								id: "abcdef1",
								label: "baseline",
								name: "Regression agent",
								version: "1.0.0",
							},
						});
					}
					return Response.json({
						versions: [
							{
								agent_id: "agent_1",
								created_at: 10,
								id: "abcdef1",
								label: "baseline",
								name: "Regression agent",
								version: "1.0.0",
							},
						],
					});
				}
				if (url.includes("/versions/abcdef1/restore")) {
					return Response.json({
						agent: {
							id: "agent_1",
							name: "Regression agent",
						},
						source: '{"name":"Regression agent"}',
					});
				}
				if (url.endsWith("/versions/abcdef1")) {
					return Response.json({
						version: { source: '{"name":"Regression agent"}' },
					});
				}
				return Response.json({
					agent: {
						id: "agent_1",
						name: "Regression agent",
					},
					source: '{"name":"Regression agent"}',
				});
			},
			{ preconnect: originalFetch.preconnect }
		);
		try {
			const target = {
				token: null,
				url: "http://127.0.0.1:7980",
				userJwt: null,
			};
			await expect(listAgentVersions(target, "agent_1")).resolves.toEqual([
				{
					agentId: "agent_1",
					createdAt: 10,
					id: "abcdef1",
					label: "baseline",
					name: "Regression agent",
					version: "1.0.0",
				},
			]);
			await expect(
				getAgentVersionSource(target, "agent_1", "abcdef1")
			).resolves.toBe('{"name":"Regression agent"}');
			await expect(
				createAgentVersion(target, "agent_1", "baseline")
			).resolves.toMatchObject({ id: "abcdef1", label: "baseline" });
			await expect(
				restoreAgentVersion(target, "agent_1", "abcdef1")
			).resolves.toMatchObject({ id: "agent_1", name: "Regression agent" });
			expect(
				requests.some((request) =>
					request.includes("/versions/abcdef1/restore")
				)
			).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
