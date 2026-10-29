/**
 * Explicit empty-node contracts for the real Layout tab proof. This fixture
 * exercises browser host behavior, not a live Core, provider or native bridge.
 * Unknown methods/paths remain undefined so the owning spec rejects them.
 */
import type { CloudEnvironmentState } from "@ryuhq/protocol/cloud-environments";
import { z } from "zod";
import type { PluginValue } from "../../src/lib/api/plugin-wire-values.ts";
import type { PresenceSnapshot } from "../../src/lib/api/presence.ts";

// usePresenceSync -> reportPresence sends exactly this heartbeat body.
const presenceReportSchema = z
	.object({
		clientId: z.string().min(1),
		status: z.enum(["online", "away", "do-not-disturb", "gaming", "streaming"]),
	})
	.strict();
const emptyCloudEnvironments: CloudEnvironmentState = {
	schemaVersion: 1,
	revision: 0,
	environments: [],
	vault: [],
};

export type ScrollableTabsFixtureResponse =
	| {
			status?: number;
			json: PluginValue | CloudEnvironmentState | PresenceSnapshot;
	  }
	| { status?: number; contentType: string; body: string };

const preferencePaths = new Set([
	"/api/preferences/support-access-local-enabled",
	"/api/preferences/support-access-local-expiry",
	"/api/preferences/voice-input",
	"/api/preferences/default-local-agent-selection",
	"/api/preferences/default-cloud-agent-selection",
	"/api/preferences/default-agent-selection",
	"/api/preferences/editor-ai",
	"/api/preferences/keybindings",
	"/api/preferences/auto-updates",
	"/api/preferences/voice-mode-readback",
	"/api/preferences/entitlement-active",
	"/api/preferences/managed-inference-entitled",
]);

const entitlementPreferenceSchema = z.object({
	value: z.enum(["true", "false"]),
});

export function createScrollableTabsCoreFixture() {
	// Explicitly stored fixture selections, rather than pretending an unset
	// local/global selection returns null (Core supplies a built-in default).
	const selection = JSON.stringify({
		agent_id: "ryu",
		provider: "local",
		model: "gemma-4-E2B-it-Q4_K_M",
		thinking_level: "",
		effort: "",
		access_mode: "",
	});
	const preferences = new Map<string, string>([
		["/api/preferences/default-local-agent-selection", selection],
		["/api/preferences/default-agent-selection", selection],
	]);

	// Each key names an observed GET caller. See the referenced production
	// decoders: api/{agents,engines,plugins,identities,mcp,skills,spaces}.ts.
	const reads = new Map<string, PluginValue | CloudEnvironmentState>(
		Object.entries<PluginValue | CloudEnvironmentState>({
			"/api/cloud-environments": emptyCloudEnvironments, // api/cloud-environments.ts: parseCloudEnvironmentState
			"/api/catalog": { sidecars: [] }, // services-api.ts: fetchCatalog
			"/api/sidecar/status": { sidecars: [] }, // api/system.ts
			"/api/billing/subscription-status": {
				entitlement: null,
				plan: null,
				subscription: null,
				features: {},
				hostedAgents: null,
				organizationId: null,
				scope: "user",
			}, // api/billing.ts: signed-out entitlement snapshot
			"/api/teams": { teams: [] }, // @ryuhq/core-client/teams
			"/api/system/status": {
				engine: { active: null, running: false },
				gateway: { reachable: false },
				mesh: null,
				sidecars: [],
			},
			"/api/agents": { agents: [] },
			"/api/agents/ryu": {
				agent: {
					id: "ryu",
					name: "Ryu",
					built_in: true,
					engine: "pi",
					model: "gemma-4-e2b-it",
					tools: [],
					memory: { space_ids: [], read_levels: [], write_enabled: false },
				},
			}, // api/agents.ts: fetchAgent -> toAgent(json.agent)
			"/api/agents/ryu/acp-config": {
				configOptions: null,
				models: null,
				modes: null,
				agentCapabilities: null,
				authMethods: [],
			}, // api/acp.ts: direct AcpConfig; no advertised session options
			"/api/agents/ryu/capabilities": {
				detected: { reasoning: false, tools: false, vision: false },
				overrides: { reasoning: null, tools: null, vision: null },
				reasoning: false,
				tools: false,
				vision: false,
				source: "default",
			}, // api/capabilities.ts: direct CapabilityReport -> toReport
			"/api/engines": { engines: [] },
			"/api/engine/active": {
				active: null,
				running: false,
				available: [],
				llamacpp_variant: null,
			},
			"/api/plugins": { apps: [] },
			"/api/identities": { profiles: [] },
			"/api/mcp/servers": { servers: [] },
			"/api/mcp/tools": { tools: [] },
			"/api/sandbox/backend": { active: "wasmtime", available: [] },
			"/api/composio/status": { configured: false, base_url: "" },
			"/api/plugins/contributions": {
				agent_edit_panels: [],
				composer_controls: [],
				chat_features: [],
				chat_widget_templates: [],
				settings_tabs: [],
				message_actions: [],
				selection_actions: [],
				output_styles: [],
				context_menu_items: [],
				create_actions: [],
				slash_commands: [],
				turn_hooks: [],
				hook_events: [],
				views: [],
				sidebar_sections: [],
				sidebar_modes: [],
				sidebar_buttons: [],
				themes: [],
				dock_panels: [],
				live_activities: [],
				store_tabs: [],
				channels: [],
				companions: [],
				widget_apps: [],
			},
			"/api/skills": { skills: [] },
			"/api/safe-mode": {
				enabled: false,
				preference_enabled: false,
				source: "off",
				user_clearable: true,
				suppressed: {
					kernel_plugins: 0,
					mcp_servers: 0,
					plugins: 0,
					skills: 0,
				},
			},
			"/api/meetings": { meetings: [] },
			"/api/output-styles": { styles: [], selected: null, forced: null },
			"/api/catalog/sources": { sources: [], active: "" },
			"/api/skills/catalog": { skills: [], next_cursor: null, total: 0 },
			"/api/engines/models": { models: {} },
			"/api/pi-config": {
				config: {
					configDir: "fixture-pi",
					provider: "gateway",
					model: null,
					routing: "gateway",
					thinkingLevel: null,
				},
			},
			"/api/pi-config/catalog": {
				apiTypes: [],
				providers: [],
				thinkingLevels: [],
			},
			"/api/drafts/list": { drafts: [] },
			"/api/models/auto/launch-config": {}, // inference.ts: direct LaunchConfig
			"/api/models/gemma-4-e2b-it/launch-config": {},
			"/api/agents/catalog": { agents: [] },
			"/api/models/installed": { models: [] },
			"/api/models/active": {
				active: "",
				default: "",
				engine: null,
				format: "gguf",
				ref: null,
				repo_id: null,
			},
			"/api/approvals": { approvals: [] },
			"/api/spaces": { spaces: [] },
			"/api/conversations": { conversations: [] },
			"/api/auth/get-session": null, // Better Auth signed-out session
			"/api/version": {
				components: [],
				platform: "fixture",
				ryu_version: "0.0.0",
			},
			"/api/update/check": {
				asset: null,
				channel: "stable",
				current: "0.0.0",
				latest: "0.0.0",
				html_url: null,
				notes: null,
				update_available: false,
				error: null,
			},
			"/api/connections": {
				data: [],
				client_count: 0,
				user_count: 0,
				ttl_secs: 90,
			},
			"/api/webhook-ingress/status": {
				kind: "ryu-relay",
				public_url: null,
				up: false,
			},
			"/api/models/context-window": { contextLength: null },
			"/api/voice/tts-engines": { data: [] },
			"/api/voice/tts-models": { data: [] },
			"/api/embeddings/model": {
				dims: 768,
				model_id: "fixture-embedding",
			},
			"/api/embeddings/reindex/status": {
				current_model: "fixture-embedding",
				current_dims: 768,
				total_chunks: 0,
				pending_chunks: 0,
				running: false,
			},
			"/api/a2a/settings": {
				description: "",
				displayName: "Tabs fixture",
				enabled: false,
				exposeExtendedCard: false,
				maxConcurrentTasks: 1,
				maxPayloadBytes: 1_048_576,
				publicBaseUrl: null,
				tenantId: "fixture",
				updatedAt: "2026-10-04T00:00:00Z",
			},
			"/api/a2a/peers": [],
			"/api/a2a/principals": [],
			"/api/a2a/published-agents": [],
			"/api/a2a/tasks": [], // api/a2a.ts returns these arrays directly
		})
	);

	return (
		method: string,
		pathname: string,
		body?: PluginValue,
		search = ""
	): ScrollableTabsFixtureResponse | undefined => {
		if (method === "PUT" && pathname === "/api/presence") {
			const report = presenceReportSchema.safeParse(body);
			if (!report.success) {
				return {
					status: 400,
					json: { error: "Presence requires clientId and a supported status" },
				};
			}
			// Core returns its effective snapshot directly, not a data envelope.
			const snapshot: PresenceSnapshot = {
				status: report.data.status,
				source: "reported",
				questionsDeferred: report.data.status !== "online",
				gaming: {
					active: false,
					detectedGame: null,
					modelsPaused: false,
					settings: {
						detectionEnabled: false,
						extraProcesses: [],
						ignoredProcesses: [],
						freeLocalModels: false,
					},
				},
				streaming: {
					active: false,
					detectedApp: null,
					settings: { detectionEnabled: false, apps: [], schemaVersion: 1 },
				},
			};
			return { json: snapshot };
		}
		if (method === "GET" && preferencePaths.has(pathname)) {
			return {
				json: {
					key: pathname.slice("/api/preferences/".length),
					value: preferences.get(pathname) ?? null,
				},
			};
		}
		if (
			method === "PUT" &&
			(pathname === "/api/preferences/entitlement-active" ||
				pathname === "/api/preferences/managed-inference-entitled")
		) {
			const preference = entitlementPreferenceSchema.safeParse(body);
			if (!preference.success) {
				return {
					status: 400,
					json: { error: "Entitlement preference value must be true or false" },
				};
			}
			preferences.set(pathname, preference.data.value);
			return {
				json: { ok: true, key: pathname.slice("/api/preferences/".length) },
			};
		}
		if (method === "POST" && pathname === "/api/ws/ticket") {
			// realtime.ts catches ticket refusal before constructing a WebSocket.
			// This host proof does not simulate a successful realtime connection.
			return {
				status: 503,
				json: { error: "Realtime is unavailable in this tab fixture" },
			};
		}
		if (method !== "GET") {
			return undefined;
		}
		if (pathname === "/api/routing/advice") {
			// api/routing.ts: a no-rule result preserves the requested target.
			const params = new URLSearchParams(search);
			const agentId = params.get("agent_id");
			const model = params.get("model");
			if (agentId === null || model === null) {
				return {
					status: 400,
					json: { error: "Routing advice requires agent_id and model" },
				};
			}
			const target = { agent_id: agentId, model };
			return {
				json: { original: target, effective: target, severity: "continue" },
			};
		}
		if (
			pathname === "/api/events/all" ||
			pathname === "/api/credits/alert/stream"
		) {
			// Valid SSE comments: no invented user event, bounded body/reconnect.
			return {
				contentType: "text/event-stream",
				body: ": fixture keepalive\n\n",
			};
		}
		if (pathname === "/api/runs/stream") {
			return {
				contentType: "text/event-stream",
				body: 'data: {"type":"snapshot","runs":[]}\n\n',
			};
		}
		return reads.has(pathname)
			? { json: reads.get(pathname) ?? null }
			: undefined;
	};
}
