import { expect, test } from "bun:test";
import { fetchAgent, updateAgent, type AgentInput } from "./agents.ts";
const input: AgentInput = {
	name: "Capability proof",
	description: null,
	systemPrompt: "Saved instructions",
	engine: "acp:pi",
	tools: ["web.search"],
};
async function exercise(
	capabilities: Pick<AgentInput, "orchestrator" | "canCreateAgents">,
	expected: { orchestrator: boolean | null; can_create_agents: boolean | null },
	omitted = false
) {
	let record = {
		id: "capability-proof",
		name: "Before",
		engine: "acp:pi",
		tools: ["web.search"],
		orchestrator: true as boolean | null,
		can_create_agents: false as boolean | null,
		version: "1.0.0",
		built_in: false,
		locked: false,
	};
	const writes: Record<string, unknown>[] = [];
	const requests: {
		method: string;
		authorization: string | null;
		jwt: string | null;
	}[] = [];
	const unexpected: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				authorization: request.headers.get("authorization"),
				jwt: request.headers.get("x-ryu-user-jwt"),
			});
			if (
				url.pathname !== "/api/agents/capability-proof" ||
				request.headers.get("authorization") !== "Bearer capability-token" ||
				request.headers.get("x-ryu-user-jwt") !== "capability-user"
			) {
				unexpected.push(request.url);
				return new Response("Unexpected authority or path", { status: 403 });
			}
			if (request.method === "PUT")
				return request.json().then((body) => {
					writes.push(body as Record<string, unknown>);
					record = { ...record, ...body };
					return Response.json({ agent: record });
				});
			if (request.method === "GET") return Response.json({ agent: record });
			unexpected.push(request.method);
			return new Response("Unexpected method", { status: 405 });
		},
	});
	try {
		const target = {
			url: server.url.origin,
			token: "capability-token",
			userJwt: "capability-user",
		};
		await updateAgent(target, "capability-proof", {
			...input,
			...capabilities,
		});
		expect(writes).toHaveLength(1);
		if (omitted) {
			expect(writes[0]).not.toHaveProperty("orchestrator");
			expect(writes[0]).not.toHaveProperty("can_create_agents");
		} else expect(writes[0]).toMatchObject(expected);
		const saved = await fetchAgent(target, "capability-proof");
		expect(saved.orchestrator).toBe(expected.orchestrator);
		expect(saved.canCreateAgents).toBe(expected.can_create_agents);
		expect(requests).toEqual([
			{
				method: "PUT",
				authorization: "Bearer capability-token",
				jwt: "capability-user",
			},
			{
				method: "GET",
				authorization: "Bearer capability-token",
				jwt: "capability-user",
			},
		]);
		expect(unexpected).toEqual([]);
	} finally {
		await server.stop(true);
	}
}
test("actual SDK HTTP save persists explicit delegation off and creation on", async () =>
	exercise(
		{ orchestrator: false, canCreateAgents: true },
		{ orchestrator: false, can_create_agents: true }
	));
test("actual SDK HTTP save persists the opposite explicit capabilities", async () =>
	exercise(
		{ orchestrator: true, canCreateAgents: false },
		{ orchestrator: true, can_create_agents: false }
	));
test("actual SDK HTTP save transmits null to restore the Core defaults", async () =>
	exercise(
		{ orchestrator: null, canCreateAgents: null },
		{ orchestrator: null, can_create_agents: null }
	));
test("omitted capability fields remain absent and preserve existing server values", async () =>
	exercise({}, { orchestrator: true, can_create_agents: false }, true));
