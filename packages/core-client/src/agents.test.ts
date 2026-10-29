import { afterEach, describe, expect, test } from "bun:test";
import { createAgent, fetchAgent, launchCheck, updateAgent } from "./agents.ts";
import type { ApiTarget } from "./client.ts";
import {
	createFetchFixture,
	parseJsonRequestBody,
} from "./test-support/http-fixture.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const TARGET: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: "node-token",
	userJwt: null,
};

interface CapturedRequest {
	body?: RequestInit["body"];
	method?: string;
	url?: string;
}

function stubAgentResponse(): CapturedRequest {
	const captured: CapturedRequest = {};
	globalThis.fetch = createFetchFixture(
		(input: RequestInfo | URL, init?: RequestInit) => {
			captured.url = String(input);
			captured.method = init?.method;
			captured.body = init?.body;
			return Promise.resolve(
				Response.json({
					agent: {
						built_in: false,
						id: "agent-1",
						model: "claude-sonnet-4",
						name: "Coverage agent",
						tools: [],
					},
				})
			);
		}
	);
	return captured;
}

const input = {
	description: null,
	engine: "acp:claude",
	name: "Coverage agent",
	systemPrompt: "Help with test coverage.",
	tools: [],
};

describe("agent model persistence", () => {
	test("PUTs the model override using the Core wire field", async () => {
		const captured = stubAgentResponse();

		const agent = await updateAgent(TARGET, "agent-1", {
			...input,
			model: "claude-sonnet-4",
		});

		expect(captured.url).toBe("http://127.0.0.1:7980/api/agents/agent-1");
		expect(captured.method).toBe("PUT");
		expect(parseJsonRequestBody(captured.body)).toMatchObject({
			engine: "acp:claude",
			model: "claude-sonnet-4",
		});
		expect(agent.model).toBe("claude-sonnet-4");
	});

	test("POSTs null when an agent is created without a model override", async () => {
		const captured = stubAgentResponse();

		await createAgent(TARGET, { ...input, model: null });

		expect(captured.url).toBe("http://127.0.0.1:7980/api/agents");
		expect(captured.method).toBe("POST");
		expect(parseJsonRequestBody(captured.body)).toMatchObject({
			model: null,
		});
	});
});

describe("agent persona wire shape", () => {
	test("PUTs a costumed ghost persona unchanged", async () => {
		const captured = stubAgentResponse();
		const persona = {
			display_name: null,
			tone: null,
			expressive: {
				expression: "happy",
				variant: "costume",
				costume: { palette: "green", headwear: "witch", accessory: "wand" },
			},
		};

		await updateAgent(TARGET, "agent-1", { ...input, model: null, persona });

		expect(JSON.parse(`${captured.body ?? "{}"}`).persona).toEqual(persona);
	});
});

function stubAgentRecord(fields: Record<string, unknown>): CapturedRequest {
	const captured: CapturedRequest = {};
	globalThis.fetch = createFetchFixture(
		(input: RequestInfo | URL, init?: RequestInit) => {
			captured.url = String(input);
			captured.method = init?.method;
			captured.body = init?.body;
			return Promise.resolve(
				Response.json({
					agent: {
						built_in: false,
						id: "agent-1",
						name: "Coverage agent",
						tools: [],
						...fields,
					},
				})
			);
		}
	);
	return captured;
}

describe("agent identity mode and account access", () => {
	test("a legacy record reads as managed with no allowlist", async () => {
		stubAgentRecord({});
		const agent = await fetchAgent(TARGET, "agent-1");
		expect(agent.identityMode).toBe("managed");
		expect(agent.accountAccess).toBeNull();
	});

	test("an unknown mode fails closed to individual; [] stays distinct from null", async () => {
		stubAgentRecord({ identity_mode: "delegated", account_access: [] });
		const agent = await fetchAgent(TARGET, "agent-1");
		expect(agent.identityMode).toBe("individual");
		expect(agent.accountAccess).toEqual([]);
	});

	test("PUTs both fields and reads them back", async () => {
		const captured = stubAgentRecord({
			identity_mode: "mixed",
			account_access: [
				"composio:ca_1",
				"agent:vault_1",
				"agent-composio:own_1",
			],
		});
		const agent = await updateAgent(TARGET, "agent-1", {
			...input,
			model: null,
			identityMode: "mixed",
			accountAccess: ["composio:ca_1", "agent:vault_1", "agent-composio:own_1"],
		});
		expect(parseJsonRequestBody(captured.body)).toMatchObject({
			identity_mode: "mixed",
			account_access: [
				"composio:ca_1",
				"agent:vault_1",
				"agent-composio:own_1",
			],
		});
		expect(agent.identityMode).toBe("mixed");
		expect(agent.accountAccess).toEqual([
			"composio:ca_1",
			"agent:vault_1",
			"agent-composio:own_1",
		]);
	});

	test("sends null to clear the allowlist and omits untouched fields", async () => {
		const captured = stubAgentRecord({});
		await updateAgent(TARGET, "agent-1", {
			...input,
			model: null,
			accountAccess: null,
		});
		const body = parseJsonRequestBody(captured.body);
		expect(body).toHaveProperty("account_access", null);
		expect(body).not.toHaveProperty("identity_mode");
	});
});

describe("agent launch check", () => {
	test("posts the mode and allowlist and reads Core's refusal", async () => {
		const captured: CapturedRequest = {};
		globalThis.fetch = createFetchFixture(
			(url: RequestInfo | URL, init?: RequestInit) => {
				captured.url = String(url);
				captured.method = init?.method;
				captured.body = init?.body;
				return Promise.resolve(
					Response.json({
						launchable: false,
						reason: "Claude Code calls Anthropic itself.",
						code: "provider_access_refused",
						sandbox_supported: true,
						runs_on_managed_pi: false,
						vendor_provider: "anthropic",
					})
				);
			}
		);
		const check = await launchCheck(TARGET, {
			engine: "acp:claude",
			identityMode: "individual",
		});
		expect(captured.url).toBe(`${TARGET.url}/api/agents/launch-check`);
		expect(captured.method).toBe("POST");
		expect(parseJsonRequestBody(captured.body)).toEqual({
			engine: "acp:claude",
			identity_mode: "individual",
			account_access: null,
		});
		expect(check).toEqual({
			launchable: false,
			reason: "Claude Code calls Anthropic itself.",
			code: "provider_access_refused",
			sandboxSupported: true,
			runsOnManagedPi: false,
			vendorProvider: "anthropic",
			limitedModelSource: null,
			modelWarning: null,
		});
	});

	test("names a saved agent and reads a launchable answer", async () => {
		const captured: CapturedRequest = {};
		globalThis.fetch = createFetchFixture(
			(_url: RequestInfo | URL, init?: RequestInit) => {
				captured.body = init?.body;
				return Promise.resolve(
					Response.json({
						launchable: true,
						sandbox_supported: false,
						runs_on_managed_pi: true,
						limited_model_source: "local",
						model_warning: "This agent has no model it can use.",
					})
				);
			}
		);
		const check = await launchCheck(TARGET, {
			agentId: "agent-1",
			engine: "acp:pi",
			identityMode: "managed",
			accountAccess: [],
		});
		expect(parseJsonRequestBody(captured.body)).toEqual({
			agent_id: "agent-1",
			engine: "acp:pi",
			identity_mode: "managed",
			account_access: [],
		});
		expect(check).toEqual({
			launchable: true,
			reason: null,
			code: null,
			sandboxSupported: false,
			runsOnManagedPi: true,
			vendorProvider: null,
			limitedModelSource: "local",
			modelWarning: "This agent has no model it can use.",
		});
	});
});

describe("an app's identity request", () => {
	test("fetchAgent reads app_identity; unknown modes read as individual", async () => {
		globalThis.fetch = createFetchFixture(() =>
			Promise.resolve(
				Response.json({
					agent: { id: "app__a", name: "A", identity_mode: "individual" },
					app_identity: { app_mode: "individual", pending_mode: "someday" },
				})
			)
		);
		const agent = await fetchAgent(TARGET, "app__a");
		expect(agent.appIdentity).toEqual({
			appMode: "individual",
			pendingMode: "individual",
		});
	});

	test("an agent no app made has none", async () => {
		stubAgentResponse();
		expect((await fetchAgent(TARGET, "agent-1")).appIdentity).toBeNull();
	});

	test("updateAgent sends the dismissal only when asked", async () => {
		const captured = stubAgentResponse();
		await updateAgent(TARGET, "agent-1", {
			...input,
			dismissPendingIdentityMode: true,
		});
		expect(parseJsonRequestBody(captured.body)).toMatchObject({
			dismiss_pending_identity_mode: true,
		});
		await updateAgent(TARGET, "agent-1", input);
		expect(parseJsonRequestBody(captured.body)).not.toHaveProperty(
			"dismiss_pending_identity_mode"
		);
	});
});
