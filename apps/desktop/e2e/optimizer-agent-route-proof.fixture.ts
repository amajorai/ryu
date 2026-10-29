import type { Page, Request as PlaywrightRequest } from "@playwright/test";
import {
	type PluginValue,
	pluginValueSchema,
} from "../src/lib/api/plugin-wire-values.ts";

export const agentId = "optimizer-browser-agent";
export const agentPath = `/api/agents/${agentId}`;
export const optimizerPath = `${agentPath}/optimizations`;
export const originalId = "original/suggestion";
const recommendation = {
	id: originalId,
	agentId,
	title: "Use the less expensive model",
	kind: "model",
	status: "pending",
	createdAt: "2026-10-05T00:00:00Z",
	summary: "The replay preserved quality.",
	change: { type: "set_model", from: "original-model", to: "cheaper-model" },
	evidence: { cases: 3, sessions: 12, verified: true, savings: 0.5 },
};
/** Stateful finite HTTP adapter shared by actual-browser suites. It replaces
 * only transport responses; consumers drive the production AgentEditPage. */
type OptimizerRouteOutcome =
	| { kind: "response"; response: Response }
	| { kind: "continue" };

export async function installOptimizerAgentRouteFixture(page: Page) {
	const fixture = createOptimizerAgentCoreFixture();
	await page.route("**/*", async (route) => {
		const original = route.request();
		const body =
			original.postData() === null
				? undefined
				: pluginValueSchema.parse(original.postDataJSON());
		const request = new Request(original.url(), {
			method: original.method(),
			headers: original.headers(),
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const outcome = await fixture.handle(request, original.resourceType());
		if (outcome.kind === "continue") {
			return route.continue();
		}
		return route.fulfill({
			status: outcome.response.status,
			headers: Object.fromEntries(outcome.response.headers),
			body: await outcome.response.text(),
		});
	});
	return fixture;
}

export function createOptimizerAgentCoreFixture() {
	const calls: {
		method: string;
		path: string;
		body: PluginValue;
		status: number;
	}[] = [];
	const unknown: string[] = [];
	let model = "original-model";
	let name = "Optimizer proof agent";
	let revision = 0;
	let applyAttempts = 0;
	let acknowledged = false;
	let analyzed = false;
	let agentReads = 0;
	let optimizerWrites = 0;
	let newerWrites = 0;
	const agent = () => ({
		id: agentId,
		name,
		built_in: false,
		installed: true,
		recommended: false,
		engine: "claude",
		transport: "acp",
		model,
		chat_model: { engine: "claude", model_id: model },
		locked: false,
		lifecycle_status: "active",
		safety_profile: "read_only",
		version: "1.0.0",
		system_prompt: "Follow the saved instructions.",
		description: "Receipt recovery proof",
		title: "",
		tools: [],
		skills: [],
		composio_actions: [],
		identity_profile_ids: [],
		persona: null,
		memory: { space_ids: [], read_levels: [], write_enabled: false },
		orchestrator: true,
		can_create_agents: false,
		updated_at: `2026-10-05T00:00:0${revision}Z`,
	});
	const state = () => ({
		readiness: { ready: true, required: 10, sessions: 12 },
		lastAnalysis: analyzed
			? {
					at: "2026-10-05T01:00:00Z",
					candidates: [],
					cases: 3,
					sessions: 12,
					notes: [],
				}
			: null,
		recommendations: [
			{
				...recommendation,
				status: acknowledged ? "applied" : analyzed ? "superseded" : "pending",
			},
		],
		recoveryRecommendations:
			revision > 0 && !acknowledged ? [recommendation] : [],
	});
	const handle = async (
		request: Request,
		resourceType: ReturnType<PlaywrightRequest["resourceType"]>
	): Promise<OptimizerRouteOutcome> => {
		const url = new URL(request.url);
		const method = request.method;
		const body =
			request.body === null
				? null
				: pluginValueSchema.parse(await request.json());
		const isOrigin = url.origin === "http://127.0.0.1:5496";
		if (
			isOrigin &&
			method === "GET" &&
			!url.pathname.startsWith("/api/") &&
			(!["fetch", "xhr", "eventsource"].includes(resourceType) ||
				/^\/assets\/card-[A-Za-z0-9_-]+\.glb$/.test(url.pathname))
		) {
			return { kind: "continue" };
		}
		const headers = Object.fromEntries(request.headers);
		let value: PluginValue | undefined;
		let status = 200;
		let known = false;
		if (
			isOrigin &&
			headers.authorization === "Bearer synthetic-optimizer-node" &&
			headers["x-ryu-user-jwt"] === "synthetic-optimizer-user"
		) {
			if (method === "GET" && body === null && !url.search) {
				const reads = new Map<string, PluginValue>(
					Object.entries<PluginValue>({
						"/api/engines": {
							engines: [{ id: "claude", name: "Claude", installed: true }],
						},
						"/api/engine/active": {
							active: "claude",
							available: ["claude"],
							running: false,
						},
						"/api/engines/models": {
							models: {
								claude: [
									{ id: "original-model", name: "Original model" },
									{ id: "cheaper-model", name: "Cheaper model" },
								],
							},
						},
						"/api/agents": {
							agents: [
								{
									id: "claude",
									name: "Claude",
									built_in: true,
									installed: true,
									engine: "claude",
									transport: "acp",
									locked: false,
									lifecycle_status: "active",
									safety_profile: "read_only",
									version: "1.0.0",
								},
								agent(),
							],
						},
						[agentPath]: { agent: agent() },
						[`${agentPath}/tools`]: { tools: [], mcpTools: [] },
						"/api/mcp/tools": { tools: [] },
						"/api/skills": { skills: [] },
						"/api/spaces": { spaces: [] },
						"/api/output-styles": { styles: [], selected: null, forced: null },
						"/api/plugins/contributions": {
							agent_edit_panels: [],
							backgrounds: [],
						},
						"/api/composio/trigger-subscriptions": { subscriptions: [] },
						// Canonical ancillary clients mounted by the actual AgentEditPage.
						"/api/composio/status": { configured: false, base_url: "" },
						"/api/pi-config": {
							config: {
								configDir: "/tmp/optimizer-proof-pi",
								provider: "gateway",
								model: null,
								routing: "gateway",
								thinkingLevel: null,
								providerRouting: {},
							},
						},
						"/api/pi-config/catalog": {
							apiTypes: [],
							providers: [],
							thinkingLevels: [],
							agentModelOverrides: {},
						},
						"/api/agents/catalog": {
							agents: [
								{
									id: "claude",
									name: "Claude",
									engine: "claude",
									transport: "acp",
									added: true,
									detected: true,
									available: true,
									recommended: false,
									installed_version: "1.0.0",
									latest_version: "1.0.0",
									version_status: "current",
								},
							],
						},
						"/api/models/installed": { models: [] },
						"/api/models/active": {
							active: "",
							default: "",
							engine: null,
							format: "gguf",
							ref: null,
							repo_id: null,
						},
						"/api/gateway/config": { auth: { api_keys: [] }, providers: {} },
						[`${agentPath}/optimizations`]: state(),
						[`/api/preferences/ryu.agent-banner.v1%3A${agentId}`]: {
							value: null,
						},
					})
				);
				if (reads.has(url.pathname)) {
					known = true;
					value = reads.get(url.pathname);
				}
				if (url.pathname === agentPath) {
					agentReads += 1;
				}
			}
			if (
				method === "PUT" &&
				!url.search &&
				url.pathname === "/api/preferences/entitlement-active" &&
				JSON.stringify(body) === JSON.stringify({ value: "true" })
			) {
				known = true;
				value = { ok: true, key: "entitlement-active" };
			}
			if (
				method === "PUT" &&
				!url.search &&
				url.pathname === "/api/preferences/managed-inference-entitled" &&
				JSON.stringify(body) === JSON.stringify({ value: "false" })
			) {
				known = true;
				value = { ok: true, key: "managed-inference-entitled" };
			}
			const selectedModel = url.searchParams.get("model");
			const isProofModel =
				selectedModel === "original-model" || selectedModel === "cheaper-model";
			if (
				method === "GET" &&
				body === null &&
				isProofModel &&
				(url.pathname === `${agentPath}/capabilities` ||
					url.pathname === "/api/agents/claude/capabilities") &&
				[...url.searchParams].length === 1
			) {
				known = true;
				value = {
					detected: { reasoning: false, tools: true, vision: false },
					overrides: { reasoning: null, tools: null, vision: null },
					reasoning: false,
					tools: true,
					vision: false,
					source: "default",
				};
			}
			const routingAgent = url.searchParams.get("agent_id");
			if (
				method === "GET" &&
				body === null &&
				isProofModel &&
				url.pathname === "/api/routing/advice" &&
				(routingAgent === agentId || routingAgent === "claude") &&
				url.searchParams.get("at_conversation_start") === "false" &&
				[...url.searchParams].length === 3
			) {
				known = true;
				value = {
					severity: "continue",
					original: { agent_id: routingAgent, model: selectedModel },
					effective: { agent_id: routingAgent, model: selectedModel },
				};
			}
			if (
				method === "GET" &&
				body === null &&
				url.pathname === "/api/gateway/audit" &&
				url.searchParams.get("agent_id") === agentId &&
				url.searchParams.get("limit") === "200" &&
				[...url.searchParams].length === 2
			) {
				known = true;
				value = { entries: [], total: 0 };
			}
			if (
				method === "POST" &&
				body === null &&
				!url.search &&
				url.pathname === `${optimizerPath}/original%2Fsuggestion/apply`
			) {
				applyAttempts += 1;
				if (applyAttempts === 1) {
					model = "cheaper-model";
					revision += 1;
					optimizerWrites += 1;
					status = 500;
					value = {
						error: "Agent saved; acknowledgement unavailable",
						agentUpdated: true,
						recoveryRequired: true,
						recommendationId: originalId,
						agent: agent(),
						appliedAgent: agent(),
					};
					known = true;
				} else if (applyAttempts === 2) {
					status = 503;
					value = { error: "Recording temporarily unavailable" };
					known = true;
				} else if (applyAttempts === 3) {
					acknowledged = true;
					value = {
						recommendation: { ...recommendation, status: "applied" },
						agent: agent(),
						appliedAgent: {
							...agent(),
							name: "Optimizer proof agent",
							updated_at: "2026-10-05T00:00:01Z",
						},
					};
					known = true;
				}
			}
			if (
				method === "POST" &&
				url.pathname === `${optimizerPath}/analyze` &&
				!url.search &&
				JSON.stringify(body) === JSON.stringify({ candidateModels: [] })
			) {
				analyzed = true;
				known = true;
				value = state();
			}
			// A finite second client's canonical save, followed by the production
			// editor's own reload. This is not a claimed UI Save or real SQL proof.
			if (
				method === "PUT" &&
				url.pathname === agentPath &&
				!url.search &&
				JSON.stringify(body) ===
					JSON.stringify({ name: "Newer independently saved agent" }) &&
				newerWrites === 0 &&
				analyzed
			) {
				name = "Newer independently saved agent";
				revision += 1;
				newerWrites += 1;
				known = true;
				value = { agent: agent() };
			}
		}
		if (!known) {
			status = 500;
			unknown.push(`${method} ${url.href}`);
			value = { error: "Unexpected finite optimizer proof request" };
		}
		calls.push({ method, path: url.pathname, body, status });
		return {
			kind: "response",
			response: new Response(JSON.stringify(value), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		};
	};
	return {
		handle,
		snapshot: () =>
			structuredClone({
				calls,
				unknown,
				currentAgent: agent(),
				model,
				revision,
				applyAttempts,
				agentReads,
				optimizerWrites,
				newerWrites,
			}),
	};
}
