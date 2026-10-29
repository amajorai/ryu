import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import type {
	GatewayGovernanceSnapshot,
	HookPolicyOverride,
} from "../../src/lib/api/governance.ts";
import { parseGatewayGovernanceSnapshot } from "../../src/lib/api/governance.ts";
import type {
	HookInventory,
	HookInventoryItem,
} from "../../src/lib/api/hooks.ts";
import { parseHookInventory } from "../../src/lib/api/hooks.ts";
import { parseProofJson } from "../fixture-json.ts";

interface RecordedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface GatewayHooksMcpProofState {
	calls: RecordedRequest[];
	failNextHookLoad: boolean;
	failNextHookWrite: boolean;
	failNextMcpLoad: boolean;
	governance: GatewayGovernanceSnapshot;
	hooks: HookInventory;
	servers: unknown[];
	tools: unknown[];
}

const STORAGE_KEY = "ryu.gateway-hooks-mcp-proof.state";

const initialState = (): GatewayHooksMcpProofState => ({
	calls: [],
	failNextHookLoad: false,
	failNextHookWrite: false,
	failNextMcpLoad: false,
	governance: {
		layers: [
			{ revision: 2, scope: "node", values: {}, writable: true },
			{ revision: 4, scope: "organization", values: {}, writable: false },
			{ revision: 4, scope: "team", values: {}, writable: false },
			{ revision: 2, scope: "user", values: {}, writable: true },
		],
		schemaVersion: 1,
	},
	hooks: {
		hooks: [
			{
				effectiveEnabled: false,
				enabled: true,
				handler: {
					display: "Sandboxed JavaScript",
					kind: "sandbox_js",
					path: "hooks/review.js",
				},
				hookKey: "com.example.security::review",
				id: "review",
				localOverrides: {},
				matcher: { flag: "io.example.review" },
				ownerId: "com.example.security",
				ownerName: "Security Guidance",
				phase: "post_assistant_turn",
				pluginEnabled: true,
				priority: 4,
				reviewRequired: true,
				source: "plugin",
				trusted: false,
			},
			{
				effectiveEnabled: true,
				enabled: true,
				handler: {
					display: "Command",
					kind: "command",
					path: "~/.ryu/hooks/lint.sh",
				},
				hookKey: "user-config::lint",
				id: "lint",
				localOverrides: { user: { enabled: true, trusted: true } },
				matcher: { commands: ["/review"] },
				ownerId: "user-config",
				ownerName: "User config",
				phase: "user_prompt_submit",
				pluginEnabled: true,
				priority: 1,
				reviewRequired: false,
				source: "config",
				trusted: true,
			},
			{
				effectiveEnabled: false,
				enabled: true,
				handler: {
					display: "Sandboxed JavaScript",
					kind: "sandbox_js",
					path: "hooks/disabled.js",
				},
				hookKey: "com.example.disabled::cleanup",
				id: "cleanup",
				localOverrides: {},
				ownerId: "com.example.disabled",
				ownerName: "Disabled Plugin",
				phase: "session_start",
				pluginEnabled: false,
				priority: 0,
				reviewRequired: true,
				source: "plugin",
				trusted: false,
			},
		],
	},
	servers: [
		{
			name: "Docs Remote",
			command: "",
			args: [],
			url: "https://mcp.example.test/docs",
			description: "Searches the local proof documentation catalog.",
			enabled: true,
			available: true,
			transport: "streamable-http",
			auth_required: true,
			auth_configured: true,
			auth_type: "header",
			header_names: ["Authorization"],
			env_keys: [],
		},
		{
			name: "Desktop only",
			command: "bunx",
			args: ["proof-mcp-server"],
			url: null,
			description: "A registered but disabled local server.",
			enabled: false,
			available: true,
			transport: "stdio",
			auth_required: false,
			auth_configured: false,
			auth_type: null,
			header_names: [],
			env_keys: [],
		},
		{
			name: "Missing command",
			command: "proof-missing-mcp",
			args: ["--safe"],
			url: null,
			description: null,
			enabled: true,
			available: false,
			transport: "stdio",
			auth_required: true,
			auth_configured: false,
			auth_type: "env",
			header_names: [],
			env_keys: ["MISSING_MCP_TOKEN"],
		},
	],
	tools: [
		{
			id: "Docs Remote.search",
			server: "Docs Remote",
			name: "search",
			description: "Search documentation by phrase.",
			input_schema: { type: "object" },
		},
		{
			id: "Docs Remote.fetch",
			server: "Docs Remote",
			name: "fetch",
			description: "Fetch one documentation record.",
			input_schema: { type: "object" },
		},
		{
			id: "Desktop only.read",
			server: "Desktop only",
			name: "read",
			description: "Available only when the server is enabled.",
			input_schema: { type: "object" },
		},
	],
});

function readState(): GatewayHooksMcpProofState {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) {
		return z
			.object({
				calls: z.array(
					z.object({
						body: z.json(),
						method: z.string(),
						path: z.string(),
						status: z.number(),
					})
				),
				failNextHookLoad: z.boolean(),
				failNextHookWrite: z.boolean(),
				failNextMcpLoad: z.boolean(),
				governance: z.json().transform(parseGatewayGovernanceSnapshot),
				hooks: z.json().transform(parseHookInventory),
				servers: z.array(z.json()),
				tools: z.array(z.json()),
			})
			.parse(JSON.parse(stored));
	}
	const state = initialState();
	const query = new URLSearchParams(window.location.search);
	state.failNextHookLoad = query.has("hookLoadFailOnce");
	state.failNextHookWrite = query.has("hookWriteFailOnce");
	state.failNextMcpLoad = query.has("mcpLoadFailOnce");
	localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	return state;
}

function saveState(state: GatewayHooksMcpProofState): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function requestPath(input: RequestInfo | URL): string {
	const value = input instanceof Request ? input.url : String(input);
	return new URL(value, window.location.href).pathname;
}

function requestBody(body: BodyInit | null | undefined) {
	if (!isNativeText(body)) {
		return null;
	}
	try {
		return parseProofJson(body);
	} catch {
		return body;
	}
}

export function installGatewayHooksMcpProofFetch(): () => void {
	const originalFetch = window.fetch;
	const state = readState();
	window.fetch = async (input, init) => {
		const path = requestPath(input);
		const method = init?.method ?? "GET";
		const body = requestBody(init?.body);
		const addCall = (status: number) => {
			state.calls.push({ body, method, path, status });
			saveState(state);
		};

		if (path === "/api/hooks/management" && method === "GET") {
			if (state.failNextHookLoad) {
				state.failNextHookLoad = false;
				addCall(503);
				return jsonResponse({ error: "fixture temporarily unavailable" }, 503);
			}
			addCall(200);
			return jsonResponse(state.hooks);
		}
		if (path === "/api/gateway/governance" && method === "GET") {
			addCall(200);
			return jsonResponse(state.governance);
		}
		if (path === "/api/hooks/overrides" && method === "PUT") {
			if (state.failNextHookWrite) {
				state.failNextHookWrite = false;
				addCall(503);
				return jsonResponse({ error: "fixture temporarily unavailable" }, 503);
			}
			const update = z
				.object({
					hookKey: z.string(),
					scope: z.enum(["node", "user"]),
					policy: z.object({
						enabled: z.boolean().optional(),
						trusted: z.boolean().optional(),
					}),
				})
				.safeParse(body).data;
			const hook = state.hooks.hooks.find(
				(candidate) => candidate.hookKey === update?.hookKey
			);
			if (!(hook && update)) {
				addCall(404);
				return jsonResponse({ error: "hook not found" }, 404);
			}
			const localOverrides = {
				...hook.localOverrides,
				[update.scope]: {
					...hook.localOverrides[update.scope],
					...update.policy,
				},
			};
			hook.localOverrides = localOverrides;
			const effectiveOverride =
				localOverrides.user ?? localOverrides.node ?? {};
			hook.enabled = effectiveOverride.enabled ?? hook.enabled;
			hook.trusted = effectiveOverride.trusted ?? hook.trusted;
			hook.effectiveEnabled =
				hook.pluginEnabled && hook.enabled && hook.trusted;
			hook.reviewRequired = !hook.trusted;
			addCall(200);
			return jsonResponse(state.hooks);
		}
		if (path === "/api/mcp/servers" && method === "GET") {
			if (state.failNextMcpLoad) {
				state.failNextMcpLoad = false;
				addCall(503);
				return jsonResponse({ error: "fixture temporarily unavailable" }, 503);
			}
			addCall(200);
			return jsonResponse({ servers: state.servers });
		}
		if (path === "/api/mcp/tools" && method === "GET") {
			addCall(200);
			return jsonResponse({ tools: state.tools });
		}

		return originalFetch(input, init);
	};
	return () => {
		window.fetch = originalFetch;
	};
}

export function gatewayHooksMcpProofState(): GatewayHooksMcpProofState {
	return readState();
}

export type {
	GatewayHooksMcpProofState,
	HookInventoryItem,
	HookPolicyOverride,
};
