import { describe, expect, test } from "bun:test";
import * as agents from "./agents.ts";
import type { ApiTarget } from "./client.ts";

type AgentOperationResult = Awaited<
	ReturnType<(typeof agents)[keyof typeof agents]>
>;

const input: agents.AgentInput = {
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
	{ name: "fetch", method: "GET", suffix: "", call: agents.fetchAgent },
	{
		name: "update",
		method: "PUT",
		suffix: "",
		call: (target, id) => agents.updateAgent(target, id, input),
	},
	{
		name: "posture",
		method: "PUT",
		suffix: "",
		call: (target, id) => agents.updateAgentPosture(target, id, {}),
	},
	{
		name: "account settings",
		method: "PUT",
		suffix: "",
		call: (target, id) => agents.updateAgentAccountSettings(target, id, {}),
	},
	{ name: "delete", method: "DELETE", suffix: "", call: agents.deleteAgent },
	{
		name: "export",
		method: "GET",
		suffix: "/export",
		call: agents.exportAgent,
	},
	{
		name: "migrate",
		method: "POST",
		suffix: "/migrate-to-ryu",
		call: agents.migrateToRyu,
	},
	{
		name: "tools",
		method: "GET",
		suffix: "/tools",
		call: agents.fetchAgentTools,
	},
	{
		name: "accounts",
		method: "GET",
		suffix: "/accounts",
		call: agents.fetchAgentAccounts,
	},
	{
		name: "switch account",
		method: "POST",
		suffix: "/accounts/switch",
		call: (target, id) =>
			agents.switchAgentAccount(target, id, { accountId: "account-1" }),
	},
	{
		name: "remove account",
		method: "POST",
		suffix: "/accounts/remove",
		call: (target, id) => agents.removeAgentAccount(target, id, "account-1"),
	},
	{
		name: "update check",
		method: "GET",
		suffix: "/update-check",
		call: agents.fetchAgentUpdateCheck,
	},
	{
		name: "runtime update",
		method: "POST",
		suffix: "/update",
		call: agents.runAgentUpdate,
	},
	{
		name: "versions",
		method: "GET",
		suffix: "/versions",
		call: agents.listAgentVersions,
	},
	{
		name: "version source",
		method: "GET",
		suffix: "/versions/v1",
		call: (target, id) => agents.getAgentVersionSource(target, id, "v1"),
	},
	{
		name: "create version",
		method: "POST",
		suffix: "/versions",
		call: agents.createAgentVersion,
	},
	{
		name: "restore version",
		method: "POST",
		suffix: "/versions/v1/restore",
		call: (target, id) => agents.restoreAgentVersion(target, id, "v1"),
	},
	{
		name: "prompt versions",
		method: "GET",
		suffix: "/prompt-versions",
		call: agents.listAgentPromptVersions,
	},
	{
		name: "prompt source",
		method: "GET",
		suffix: "/prompt-versions/v1",
		call: (target, id) => agents.getAgentPromptVersion(target, id, "v1"),
	},
	{
		name: "create prompt",
		method: "POST",
		suffix: "/prompt-versions",
		call: (target, id) =>
			agents.createAgentPromptVersion(target, id, "fixture"),
	},
	{
		name: "restore prompt",
		method: "POST",
		suffix: "/prompt-versions/v1/restore",
		call: (target, id) => agents.restoreAgentPromptVersion(target, id, "v1"),
	},
];

describe("desktop agent route confinement", () => {
	test("all agent operations keep untrusted thread metadata within one segment", async () => {
		const originalFetch = globalThis.fetch;
		const requests: Request[] = [];
		Reflect.set(
			globalThis,
			"fetch",
			(url: RequestInfo | URL, init?: RequestInit) => {
				requests.push(new Request(url, init));
				const agent = { id: "fixture", name: "Fixture" };
				const request = requests.at(-1);
				if (!request) {
					throw new Error("Expected an agent request");
				}
				const path = new URL(request.url).pathname;
				const response = (() => {
					if (path.endsWith("/export")) {
						return {
							template: {
								agent_config: {
									title: "Fixture",
									description: null,
									system_prompt: null,
									tools: [],
									engine: null,
									model: null,
								},
								kind: "agent",
								name: "Fixture",
								version: "1.0.0",
							},
						};
					}
					if (path.endsWith("/migrate-to-ryu")) {
						return { ryu_agent: agent, carried: [], source_id: "fixture" };
					}
					if (path.endsWith("/tools")) {
						return { tools: [], mcpTools: [] };
					}
					if (path.endsWith("/accounts")) {
						return { accounts: [] };
					}
					if (path.endsWith("/accounts/switch")) {
						return { switched: true };
					}
					if (path.endsWith("/accounts/remove")) {
						return { removed: true };
					}
					if (path.endsWith("/update-check")) {
						return {
							id: "fixture",
							installedVersion: "1.0.0",
							latestVersion: "1.0.0",
							updateAvailable: false,
						};
					}
					if (path.endsWith("/update")) {
						return { updated: true, installedVersion: "1.0.0" };
					}
					if (path.endsWith("/prompt-versions/v1/restore")) {
						return { prompt: "fixture" };
					}
					if (path.endsWith("/prompt-versions/v1")) {
						return { version: { prompt: "fixture" } };
					}
					if (path.endsWith("/prompt-versions")) {
						return request.method === "POST"
							? { saved: true }
							: { versions: [] };
					}
					if (path.endsWith("/versions/v1")) {
						return { version: { source: "fixture" } };
					}
					if (path.endsWith("/versions")) {
						return request.method === "POST"
							? {
									version: {
										agent_id: "fixture",
										created_at: 1,
										id: "v1",
										name: "Fixture",
										version: "1.0.0",
										label: null,
									},
								}
							: { versions: [] };
					}
					return { agent, source: "fixture" };
				})();
				return Promise.resolve(Response.json(response));
			}
		);
		const target: ApiTarget = {
			url: "http://127.0.0.1:7980",
			token: "fixture-node-token",
			userJwt: "fixture-user-jwt",
		};
		try {
			for (const operation of operations) {
				for (const id of [
					"worker/../../conversations/victim/access",
					"acp:kiro",
				]) {
					requests.length = 0;
					await operation.call(target, id);
					expect(requests).toHaveLength(1);
					const request = requests[0];
					if (!request) {
						throw new Error("Expected an authenticated agent request");
					}
					expect(new URL(request.url).pathname).toBe(
						`/api/agents/${encodeURIComponent(id)}${operation.suffix}`
					);
					expect(request.method).toBe(operation.method);
					expect(request.headers.get("authorization")).toBe(
						"Bearer fixture-node-token"
					);
				}
				requests.length = 0;
				for (const id of [".", ".."]) {
					await expect(operation.call(target, id)).rejects.toThrow(
						"dot segment"
					);
				}
				expect(requests).toHaveLength(0);
			}
			await agents.removeParticipant(
				target,
				"conversation-1",
				"worker/../../access"
			);
			const request = requests[0];
			if (!request) {
				throw new Error("Expected a participant removal request");
			}
			expect(new URL(request.url).pathname).toBe(
				"/api/conversations/conversation-1/participants/worker%2F..%2F..%2Faccess"
			);
			for (const id of [".", ".."]) {
				await expect(
					agents.removeParticipant(target, "conversation-1", id)
				).rejects.toThrow("dot segment");
			}
			expect(requests).toHaveLength(1);
		} finally {
			Reflect.set(globalThis, "fetch", originalFetch);
		}
	});
});
