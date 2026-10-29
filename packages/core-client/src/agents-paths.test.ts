import { describe, expect, test } from "bun:test";
import type * as AgentApi from "./agents.ts";
import {
	deleteAgent,
	exportAgent,
	fetchAgent,
	fetchAgentTools,
	migrateToRyu,
	removeParticipant,
	updateAgent,
} from "./agents.ts";
import type { ApiTarget } from "./client.ts";

type AgentOperationResult = {
	[Name in keyof typeof AgentApi]: (typeof AgentApi)[Name] extends (
		...args: infer _Args
	) => infer Result
		? Awaited<Result>
		: never;
}[keyof typeof AgentApi];

const agent = { id: "fixture", name: "Fixture" };
const input = {
	description: null,
	engine: null,
	name: "Fixture",
	systemPrompt: null,
	tools: [],
};
const operations: {
	name: string;
	method: string;
	suffix: string;
	call: (target: ApiTarget, id: string) => Promise<AgentOperationResult>;
}[] = [
	{ name: "fetch", method: "GET", suffix: "", call: fetchAgent },
	{
		name: "update",
		method: "PUT",
		suffix: "",
		call: (target, id) => updateAgent(target, id, input),
	},
	{ name: "delete", method: "DELETE", suffix: "", call: deleteAgent },
	{ name: "export", method: "GET", suffix: "/export", call: exportAgent },
	{
		name: "migrate",
		method: "POST",
		suffix: "/migrate-to-ryu",
		call: migrateToRyu,
	},
	{ name: "tools", method: "GET", suffix: "/tools", call: fetchAgentTools },
];

function fixtureTarget(requests: Request[]): ApiTarget {
	return {
		url: "http://127.0.0.1:7980",
		token: "fixture-node-token",
		userJwt: "fixture-user-jwt",
		fetch: (url, init) => {
			requests.push(new Request(url, init));
			return Promise.resolve(
				Response.json({
					agent,
					template: {
						kind: "agent",
						name: "Fixture",
						version: "1.0.0",
						agent_config: {
							tools: [],
							description: null,
							system_prompt: null,
							engine: null,
							model: null,
						},
					},
					ryu_agent: agent,
					carried: [],
					source_id: "fixture",
				})
			);
		},
	};
}

describe("agent request path confinement", () => {
	for (const operation of operations) {
		test(`${operation.name} keeps credentials on the intended agent route`, async () => {
			for (const id of [
				"worker/../../conversations/victim/access",
				"worker\\..\\..\\conversations\\victim\\access",
				"worker?route=/api/conversations/victim/access#fragment",
				"%2e%2e%2fconversations",
				"acp:kiro",
				"acp-exec:custom",
				"worker-1",
			]) {
				const requests: Request[] = [];
				await operation.call(fixtureTarget(requests), id);
				expect(requests).toHaveLength(1);
				const request = requests[0];
				if (!request) {
					throw new Error("Expected an authenticated agent request");
				}
				const url = new URL(request.url);
				expect(url.pathname).toBe(
					`/api/agents/${encodeURIComponent(id)}${operation.suffix}`
				);
				expect(url.search).toBe("");
				expect(url.hash).toBe("");
				expect(request.method).toBe(operation.method);
				expect(request.headers.get("authorization")).toBe(
					"Bearer fixture-node-token"
				);
				expect(request.headers.get("x-ryu-user-jwt")).toBe("fixture-user-jwt");
			}
		});
		test(`${operation.name} rejects standalone dot segments before transport`, async () => {
			const requests: Request[] = [];
			for (const id of [".", ".."]) {
				await expect(
					operation.call(fixtureTarget(requests), id)
				).rejects.toThrow("dot segment");
			}
			expect(requests).toHaveLength(0);
		});
	}

	test("participant removal confines the agent ID and rejects dot segments", async () => {
		const requests: Request[] = [];
		const target = fixtureTarget(requests);
		const id = "worker/../../conversations/victim/access";
		await removeParticipant(target, "conversation-1", id);
		const request = requests[0];
		if (!request) {
			throw new Error("Expected a participant removal request");
		}
		expect(new URL(request.url).pathname).toBe(
			`/api/conversations/conversation-1/participants/${encodeURIComponent(id)}`
		);
		expect(request.method).toBe("DELETE");
		for (const dot of [".", ".."]) {
			await expect(
				removeParticipant(target, "conversation-1", dot)
			).rejects.toThrow("dot segment");
		}
		expect(requests).toHaveLength(1);
	});
});
