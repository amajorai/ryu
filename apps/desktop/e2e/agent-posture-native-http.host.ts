import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";
import type {
	CapabilityReport,
	DetectedCaps,
} from "@/src/lib/api/capabilities.ts";
import type { PiCatalog, PiConfig } from "@/src/lib/api/pi-config.ts";
import type { RoutingAdvice } from "@/src/lib/api/routing.ts";
import { createVersionEntitlementPreferences } from "./agent-version-entitlement-fixture.ts";

const AGENT = "version-proof";
export const POSTURE_PATH = `/api/agents/${AGENT}`;
const baseline = {
	id: AGENT,
	name: "Checkpoint agent",
	title: "Saved badge",
	description: "Saved description",
	system_prompt: "Use the immutable checkpoint instructions.",
	engine: "acp:pi",
	model: "checkpoint-model",
	chat_model: { engine: "fixture-provider", model_id: "checkpoint-model" },
	tools: ["web.search"],
	skills: ["checkpoint-skill"],
	composio_actions: [],
	identity_profile_ids: [],
	memory: {
		space_ids: ["saved-space"],
		read_levels: ["user"],
		write_enabled: true,
	},
	persona: {
		display_name: "Checkpoint persona",
		tone: "technical",
		output_style_id: null,
	},
	inference: { temperature: 0.27 },
	orchestrator: false,
	can_create_agents: true,
	safety_profile: "approval_required",
	built_in: false,
	locked: false,
	version: "1.2.3",
	lifecycle_status: "active",
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};
const initial = {
	...baseline,
	name: "Current agent",
	description: "Current description",
	system_prompt: "Current instructions.",
	model: "current-model",
	chat_model: { engine: "fixture-provider", model_id: "current-model" },
	tools: ["terminal.execute"],
	skills: ["current-skill"],
	persona: {
		display_name: "Current persona",
		tone: "neutral",
		output_style_id: null,
	},
	version: "2.0.0",
};

export function startAgentPostureProofHost(port = 5731) {
	type Scope = "a" | "b";
	interface Call {
		authorization: string | null;
		body: unknown;
		id: number;
		jwt: string | null;
		method: string;
		path: string;
		query: string;
		scope: Scope | null;
		status: number | null;
		url: string;
	}
	const calls: Call[] = [];
	const unexpected: Call[] = [];
	let records = {
		a: structuredClone(initial),
		b: {
			...structuredClone(initial),
			name: "Scope B agent",
			safety_profile: "read_only",
			lifecycle_status: "trial",
		},
	};
	let preferences = createVersionEntitlementPreferences();
	let refuseNextRead: "a" | "b" | null = null;
	let next: { hold: boolean; status: 200 | 403 } | null = null;
	const holds = new Map<
		number,
		{ promise: Promise<void>; release: () => void }
	>();
	const headers = {
		"access-control-allow-origin": "http://127.0.0.1:5730",
		"access-control-allow-methods": "GET, PUT, POST, OPTIONS",
		"access-control-allow-headers":
			"authorization,content-type,x-ryu-user-jwt,x-ryu-client-id,x-ryu-client-label,x-ryu-surface,x-proof-control",
		"access-control-allow-credentials": "true",
		vary: "Origin",
	};
	const corsKeys = new Set(headers["access-control-allow-headers"].split(","));
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			const reply = (body: unknown, status = 200) =>
				Response.json(body, { status, headers });
			if (url.pathname === "/__state" && request.method === "GET") {
				return reply({ calls, unexpected, records, held: [...holds.keys()] });
			}
			if (
				url.pathname === "/__control" &&
				request.method === "POST" &&
				request.headers.get("x-proof-control") === "owned-posture-proof"
			) {
				const command = await request.json();
				if (command.action === "reset" && holds.size === 0) {
					calls.length = 0;
					unexpected.length = 0;
					records = {
						a: structuredClone(initial),
						b: {
							...structuredClone(initial),
							name: "Scope B agent",
							safety_profile: "read_only",
							lifecycle_status: "trial",
						},
					};
					preferences = createVersionEntitlementPreferences();
					next = null;
					refuseNextRead = null;
					return reply({ ok: true });
				}
				if (
					command.action === "refuse-next-read" &&
					["a", "b"].includes(command.scope)
				) {
					refuseNextRead = command.scope;
					return reply({ ok: true });
				}

				if (
					command.action === "next" &&
					typeof command.hold === "boolean" &&
					[200, 403].includes(command.status)
				) {
					next = { hold: command.hold, status: command.status };
					return reply({ ok: true });
				}
				if (
					command.action === "release" &&
					Number.isInteger(command.id) &&
					holds.has(command.id)
				) {
					holds.get(command.id)!.release();
					return reply({ ok: true });
				}
				return reply(
					{ error: "Unknown owned control or reset with pending requests" },
					400
				);
			}
			const match = /^\/scope-([ab])(\/api\/.*)$/.exec(url.pathname);
			if (request.method === "OPTIONS") {
				const origin = request.headers.get("origin");
				const method = request.headers.get("access-control-request-method");
				const requested = (
					request.headers.get("access-control-request-headers") ?? ""
				)
					.toLowerCase()
					.split(",")
					.map((x) => x.trim())
					.filter(Boolean);
				return new Response(null, {
					status:
						(match || url.pathname === "/api/auth/get-session") &&
						origin === headers["access-control-allow-origin"] &&
						["GET", "PUT"].includes(method ?? "") &&
						requested.every((x) => corsKeys.has(x))
							? 204
							: 403,
					headers,
				});
			}
			if (
				url.pathname === "/api/auth/get-session" &&
				request.method === "GET"
			) {
				return reply(null);
			}
			const scope = match?.[1] as Scope | undefined;
			const path = match?.[2] ?? url.pathname;
			let body: unknown = null;
			try {
				if (request.method !== "GET") {
					body = await request.json();
				}
			} catch {}
			const call: Call = {
				id: calls.length + 1,
				scope: scope ?? null,
				method: request.method,
				path,
				url: request.url,
				query: url.search,
				body,
				authorization: request.headers.get("authorization"),
				jwt: request.headers.get("x-ryu-user-jwt"),
				status: null,
			};
			calls.push(call);
			const respond = (value: unknown, status = 200) => {
				call.status = status;
				return reply(value, status);
			};
			const reject = (message: string, status = 503) => {
				unexpected.push(call);
				return respond({ error: message }, status);
			};
			if (
				!scope ||
				call.authorization !== `Bearer version-bearer-${scope}` ||
				call.jwt !== `version-user-${scope}`
			) {
				return reject("Unknown fixture authority", 403);
			}
			// Only the exact queries issued by this real editor are admitted.
			const expectedQuery =
				path === `${POSTURE_PATH}/capabilities`
					? "?model=current-model"
					: path === "/api/routing/advice"
						? "?agent_id=version-proof&model=current-model&at_conversation_start=false"
						: "";
			if (url.search !== expectedQuery) {
				return reject("Unknown actual editor query");
			}
			const pref = preferences.handle(scope, request.method, path, body);
			if (pref) {
				return respond(pref.body, pref.status);
			}
			if (path === POSTURE_PATH && request.method === "PUT") {
				if (!body || typeof body !== "object" || Array.isArray(body)) {
					return reject("Invalid sparse posture DTO", 400);
				}
				const dto = body as Record<string, unknown>;
				const keys = Object.keys(dto);
				const fullKeys = [
					"name",
					"title",
					"description",
					"model",
					"chat_model",
					"system_prompt",
					"engine",
					"tools",
					"composio_actions",
					"skills",
					"identity_profile_ids",
					"version",
					"persona",
					"inference",
					"orchestrator",
					"can_create_agents",
					"safety_profile",
					"memory",
				];
				const fullUpdate =
					keys.length === fullKeys.length &&
					fullKeys.every((key) => Object.hasOwn(dto, key)) &&
					typeof dto.name === "string" &&
					dto.name.trim().length > 0 &&
					dto.engine === "acp:pi" &&
					typeof dto.title === "string" &&
					typeof dto.version === "string" &&
					[dto.description, dto.model, dto.system_prompt].every(
						(value) => value === null || typeof value === "string"
					) &&
					[
						dto.tools,
						dto.skills,
						dto.composio_actions,
						dto.identity_profile_ids,
					].every(
						(value) =>
							Array.isArray(value) &&
							value.every((item) => typeof item === "string")
					) &&
					[dto.orchestrator, dto.can_create_agents].every(
						(value) => value === null || typeof value === "boolean"
					) &&
					[dto.chat_model, dto.persona, dto.inference, dto.memory].every(
						(value) =>
							value !== null &&
							typeof value === "object" &&
							!Array.isArray(value)
					) &&
					typeof dto.safety_profile === "string" &&
					[
						"read_only",
						"approval_required",
						"verified_plan_only",
						"autonomous",
					].includes(dto.safety_profile);
				if (
					!fullUpdate &&
					(keys.length !== 1 ||
						!(
							(keys[0] === "lifecycle_status" &&
								typeof dto.lifecycle_status === "string" &&
								["draft", "trial", "active"].includes(
									String(dto.lifecycle_status)
								)) ||
							(keys[0] === "safety_profile" &&
								typeof dto.safety_profile === "string" &&
								[
									"read_only",
									"approval_required",
									"verified_plan_only",
									"autonomous",
								].includes(String(dto.safety_profile)))
						))
				) {
					return reject(
						"Expected one valid sparse policy field or the exact source-backed full agent DTO",
						400
					);
				}
				const outcome = next ?? { hold: false, status: 200 };
				next = null;
				if (outcome.hold) {
					let release = () => {};
					const promise = new Promise<void>((resolve) => {
						release = resolve;
					});
					holds.set(call.id, { promise, release });
					await promise;
					holds.delete(call.id);
				}
				if (outcome.status === 403) {
					return respond({ error: "Posture write refused" }, 403);
				}
				records[scope] = { ...records[scope], ...dto };
				return respond({
					agent: records[scope],
					source: JSON.stringify(records[scope]),
				});
			}
			if (request.method !== "GET") {
				return reject("Unknown fixture mutation");
			}
			if (path === POSTURE_PATH && refuseNextRead === scope) {
				refuseNextRead = null;
				return respond(
					{ error: "Current authority cannot read this agent" },
					403
				);
			}
			if (path === POSTURE_PATH) {
				return respond({
					agent: records[scope],
					source: JSON.stringify(records[scope]),
				});
			}
			if (path === "/api/agents") {
				return respond({
					agents: [
						records[scope],
						{
							id: "ryu",
							name: "Ryu",
							engine: "ryu",
							transport: "acp",
							installed: true,
							lifecycle_status: "active",
						},
					],
				});
			}
			// Finite idle dependencies of the actual editor. Unknown routes never get {}.
			const capabilities = {
				detected: {
					tools: true,
					reasoning: false,
					vision: false,
					diffusion: false,
				},
				overrides: { tools: null, reasoning: null, vision: null },
				tools: true,
				reasoning: false,
				vision: false,
				source: "default",
				diffusion: false,
			} satisfies CapabilityReport & {
				detected: DetectedCaps & { diffusion: boolean };
				diffusion: boolean;
			};
			const config = {
				configDir: "/tmp/owned-posture-pi",
				provider: "gateway",
				routing: "gateway",
				model: null,
				thinkingLevel: null,
			} satisfies PiConfig;
			const catalog = {
				providers: [],
				apiTypes: ["openai-completions"],
				thinkingLevels: [],
			} satisfies PiCatalog;
			const advice = {
				original: { agent_id: AGENT, model: "current-model" },
				effective: { agent_id: AGENT, model: "current-model" },
				severity: "continue",
			} satisfies RoutingAdvice;
			const reads: Record<string, unknown> = {
				"/api/agents/catalog": { agents: [] satisfies AgentCatalogEntry[] },
				"/api/models/installed": { models: [] },
				"/api/models/active": {
					active: "",
					default: "",
					engine: null,
					format: "gguf",
					ref: null,
					repo_id: null,
				},
				"/api/pi-config": { config },
				"/api/pi-config/catalog": catalog,
				[`${POSTURE_PATH}/capabilities`]: capabilities,
				"/api/routing/advice": advice,
				[`${POSTURE_PATH}/tools`]: {
					tools: [],
					mcpTools: [{ name: "terminal.execute" }],
				},
				[`${POSTURE_PATH}/versions`]: { versions: [] },
				[`${POSTURE_PATH}/prompt-versions`]: { versions: [] },
				[`${POSTURE_PATH}/accounts`]: { accounts: [] },
				[`${POSTURE_PATH}/sessions`]: { sessions: [], unsupported: true },
				[`${POSTURE_PATH}/acp-config`]: {
					models: null,
					modes: null,
					configOptions: [],
					authMethods: [],
				},
				"/api/engines": { engines: [] },
				"/api/engine/active": { active: null },
				"/api/engines/models": { engines: [] },
				"/api/mcp/tools": {
					tools: [{ name: "terminal.execute" }, { name: "web.search" }],
				},
				"/api/skills": {
					skills: [
						{ id: "current-skill", name: "Current skill", enabled: true },
					],
				},
				"/api/spaces": { spaces: [{ id: "saved-space", name: "Saved space" }] },
				"/api/identities": { profiles: [] },
				"/api/output-styles": { styles: [], selected: null, forced: null },
				"/api/gateway/evaluators": { evaluators: [] },
				"/api/gateway/audit": { reachable: false, entries: [], count: 0 },
				"/api/plugins/contributions": {
					agent_edit_panels: [],
					backgrounds: [],
				},
				"/api/composio/status": { configured: false, base_url: "" },
				"/api/composio/trigger-subscriptions": { subscriptions: [] },
				"/api/gateway/config": {
					providers: [],
					routing: {},
					auth: { api_keys: [] },
				},
				"/api/preferences/ryu.agent-banner.v1%3Aversion-proof": {
					key: "ryu.agent-banner.v1:version-proof",
					value: null,
				},
			};
			if (Object.hasOwn(reads, path)) {
				return respond(reads[path]);
			}
			return reject("Unknown actual editor prerequisite");
		},
	});
	return {
		server,
		close: () => {
			for (const h of holds.values()) {
				h.release();
			}
			server.stop(true);
		},
	};
}
if (import.meta.main) {
	const host = startAgentPostureProofHost();
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			host.close();
			process.exit(0);
		});
	}
}
