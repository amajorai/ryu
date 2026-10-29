import { afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register before React and isolate this file from non-browser Bun suites.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";

const node = {
	name: "Synthetic node",
	token: "synthetic-access-node",
	url: "http://127.0.0.1:7981",
	userJwt: null,
};
const realActiveNode = await import("@/src/hooks/useActiveNode.ts");
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	...realActiveNode,
	useActiveNode: () => node,
}));
const realComposio = await import("@/src/hooks/useComposioCatalog.ts");
mock.module("@/src/hooks/useComposioCatalog.ts", () => ({
	...realComposio,
	useComposioConnections: () => ({
		data: [
			{
				accessLevel: "risk_based",
				active: true,
				id: "ca_gmail",
				status: "ACTIVE",
				toolkit: "gmail",
			},
			{
				accessLevel: "risk_based",
				active: false,
				id: "ca_slack",
				status: "EXPIRED",
				toolkit: "slack",
			},
		],
		isLoading: false,
	}),
	useComposioStatus: () => ({ data: { configured: true } }),
	useComposioToolkits: () => ({
		data: [{ description: null, logo: null, name: "Notion", slug: "notion" }],
		isLoading: false,
	}),
}));
const realBridge = await import("@/lib/tauri-bridge.ts");
/** Links the panel opened in the browser. */
const opened: string[] = [];
mock.module("@/lib/tauri-bridge.ts", () => ({
	...realBridge,
	openExternal: (url: string) => {
		opened.push(url);
		return Promise.resolve();
	},
}));
const realApps = await import("@/src/hooks/useApps.ts");
mock.module("@/src/hooks/useApps.ts", () => ({
	...realApps,
	useApps: () => ({ apps: [], loading: false }),
}));
const realIdentities = await import("@/src/hooks/useIdentities.ts");
mock.module("@/src/hooks/useIdentities.ts", () => ({
	...realIdentities,
	useIdentities: () => ({ loading: false, profileIds: ["work"] }),
}));
/** A redacted Gateway config with an OpenAI key, a Gemini key and Core sign-ins. */
const gatewayProviders = {
	anthropic: null,
	core: { base_url: "http://127.0.0.1:7980", has_token: true },
	genai: { gemini_account_count: 1, keys: ["gemini"], sdk_providers: [] },
	local: { base_url: "http://127.0.0.1:8080" },
	openai: { api_key: "sk-***", api_key_count: 1, base_url: "" },
	openrouter: null,
	// A chat provider configured outside the key editor, and an embedding-only
	// one whose row would change nothing.
	compatible: {
		chutes: { api_key: "***", api_key_count: 1, base_url: "" },
		voyage: { api_key: "***", api_key_count: 1, base_url: "" },
	},
	deepgram: { api_key: "***", api_key_count: 1, base_url: "" },
};
/** How many times the panel loaded the Gateway config. */
let gatewayConfigLoads = 0;
const realGateway = await import("@/src/lib/api/gateway.ts");
mock.module("@/src/lib/api/gateway.ts", () => ({
	...realGateway,
	fetchGatewayConfig: () => {
		gatewayConfigLoads += 1;
		return Promise.resolve({ providers: gatewayProviders });
	},
}));
/** How many times the panel listed MCP servers. */
let mcpServerLoads = 0;
const realMcp = await import("@/src/lib/api/mcp.ts");
mock.module("@/src/lib/api/mcp.ts", () => ({
	...realMcp,
	fetchMcpServers: () => {
		mcpServerLoads += 1;
		// One server you added that uses a saved key, and one that uses none.
		return Promise.resolve([
			{ name: "keyed", ownerPluginId: null, savedKeyAccount: "keyed" },
			{ name: "plain", ownerPluginId: null, savedKeyAccount: null },
		]);
	},
}));
const realTabs = await import("@/src/contexts/TabsContext.tsx");
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	...realTabs,
	useTabSelector: () => () => undefined,
}));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const {
	AgentAccountAccessPanel,
	accountKey,
	appUsesSavedKeys,
	engineProviderRows,
	savedKeyRows,
	sourceReferencesSavedKey,
	startAccountLimit,
	toggleAccountKey,
} = await import("./AgentAccountAccessPanel.tsx");
const {
	agentEngineModelProvider,
	agentModelProviders,
	engineRefusedWhenLimited,
	byokProviderRegistryId,
} = await import("./agent-provider-access.ts");

const realFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	globalThis.fetch = realFetch;
	document.body.replaceChildren();
});

describe("account keys", () => {
	test("follow Core's grammar", () => {
		expect(accountKey.composio("ca_1")).toBe("composio:ca_1");
		expect(accountKey.mcp("default", "@ryu/notion", "notion")).toBe(
			"mcp:default:@ryu/notion:notion"
		);
		expect(accountKey.agent("acct_1")).toBe("agent:acct_1");
		expect(accountKey.agentComposio("own_notion")).toBe(
			"agent-composio:own_notion"
		);
		expect(accountKey.provider("openai")).toBe("provider:openai");
		expect(accountKey.treg).toBe("platform:treg");
		expect(accountKey.desktop).toBe("platform:desktop");
		expect(accountKey.savedKey("@ryu/exa")).toBe("mcp-secret:@ryu/exa");
	});

	test("saved keys follow Core's detection", () => {
		expect(sourceReferencesSavedKey("Bearer env:RYU_EXA_API_KEY")).toBe(true);
		expect(sourceReferencesSavedKey("secret:MY_KEY")).toBe(true);
		expect(sourceReferencesSavedKey("vault:github.com")).toBe(true);
		// Ryu's own agent token is not one of your keys.
		expect(sourceReferencesSavedKey("Bearer env:RYU_TOKEN")).toBe(false);
		expect(sourceReferencesSavedKey("application/json")).toBe(false);

		const exa = {
			enabled: true,
			id: "@ryu/exa",
			name: "Exa",
			runnables: [
				{
					config: { secret_headers: { "x-api-key": "env:RYU_EXA_API_KEY" } },
					id: "search",
					kind: "tool",
					name: "Search",
				},
			],
		};
		const shadow = {
			enabled: true,
			id: "@ryu/shadow",
			name: "Shadow",
			runnables: [
				{
					config: { secret_headers: { Authorization: "Bearer env:RYU_TOKEN" } },
					id: "search",
					kind: "tool",
					name: "Search",
				},
			],
		};
		const steel = {
			enabled: true,
			id: "@ryu/steel",
			name: "Steel",
			runnables: [],
		};
		expect(appUsesSavedKeys(exa.runnables)).toBe(true);
		expect(appUsesSavedKeys(shadow.runnables)).toBe(false);
		expect(
			savedKeyRows(
				[
					{
						name: "steel",
						ownerPluginId: "@ryu/steel",
						savedKeyAccount: "@ryu/steel",
					},
					{ name: "mine", ownerPluginId: null, savedKeyAccount: "mine" },
					{ name: "plain", ownerPluginId: null, savedKeyAccount: null },
				],
				[exa, shadow, steel, { ...exa, enabled: false, id: "@ryu/off" }]
			)
		).toEqual([
			{ detail: "App", key: "mcp-secret:@ryu/exa", title: "Exa" },
			{ detail: "MCP server you added", key: "mcp-secret:mine", title: "mine" },
			{ detail: "App", key: "mcp-secret:@ryu/steel", title: "Steel" },
		]);
	});

	test("model providers use Gateway registry ids", () => {
		expect(byokProviderRegistryId("gemini")).toBe("genai");
		expect(byokProviderRegistryId("openai")).toBe("openai");
		expect(agentModelProviders(null)).toEqual([]);
		expect(
			agentModelProviders(
				gatewayProviders as unknown as Parameters<typeof agentModelProviders>[0]
			)
		).toEqual([
			{ id: "openai", label: "OpenAI" },
			{ id: "genai", label: "Gemini" },
			{ id: "chutes", label: "Chutes" },
			{
				id: "core",
				label: "Subscriptions you signed in to through Ryu, if any",
			},
			{ id: "kiro", label: "Kiro sign-in, if any" },
		]);
	});

	test("engine rows use Core's vendor ids", () => {
		expect(agentEngineModelProvider("acp:claude")?.id).toBe("anthropic");
		expect(agentEngineModelProvider("acp:codex")?.id).toBe("openai");
		expect(agentEngineModelProvider("acp:gemini")?.id).toBe("genai");
		expect(agentEngineModelProvider("acp:kiro")?.id).toBe("kiro");
		expect(
			agentEngineModelProvider(
				"acp-exec:npx -y @agentclientprotocol/claude-agent-acp"
			)?.id
		).toBe("anthropic");
		expect(agentEngineModelProvider("acp:pi")).toBeNull();
		for (const gemini of [
			"acp-exec:gemini --experimental-acp",
			"acp-exec:/usr/local/bin/gemini --experimental-acp",
			"acp-exec:npx -y @google/gemini-cli --experimental-acp",
			"acp-exec:node /usr/local/bin/gemini --experimental-acp",
		]) {
			expect(agentEngineModelProvider(gemini)?.id).toBe("genai");
		}
		expect(agentEngineModelProvider("acp-exec:kiro-cli acp")?.id).toBe("kiro");
		expect(
			agentEngineModelProvider("acp-exec:/opt/agents/kiro-cli acp")?.id
		).toBe("kiro");
		expect(agentEngineModelProvider("acp-exec:goose acp")).toBeNull();
		expect(
			agentEngineModelProvider("acp-exec:goose acp --provider gemini")
		).toBeNull();
		expect(agentEngineModelProvider(null)).toBeNull();
		// The engine list's "Ryu" choice is saved as `acp:pi`. A limited agent
		// on it runs on Ryu's managed, Gateway-routed Pi, which Core refuses
		// only while that Pi calls its provider directly.
		expect(engineRefusedWhenLimited("acp:pi", "gateway")).toBeNull();
		expect(engineRefusedWhenLimited("acp:pi", null)).toBeNull();
		expect(engineRefusedWhenLimited("acp:pi", "direct")).toContain(
			"won't start"
		);
		expect(engineRefusedWhenLimited("acp:claude", "direct")).toBeNull();
		expect(engineRefusedWhenLimited(null, "direct")).toBeNull();

		const providers = gatewayProviders as unknown as Parameters<
			typeof engineProviderRows
		>[0];
		// A vendor with no Gateway key still gets its row, first.
		const claude = engineProviderRows(providers, "acp:claude");
		expect(claude[0]).toEqual({
			key: "provider:anthropic",
			title: "Anthropic (Claude Code's own sign-in or key)",
		});
		expect(
			claude.filter((row) => row.key === "provider:anthropic")
		).toHaveLength(1);
		// A vendor that already has a BYOK row is not listed twice.
		const codex = engineProviderRows(providers, "acp:codex");
		const openai = codex.filter((row) => row.key === "provider:openai");
		expect(openai).toHaveLength(1);
		expect(openai[0]?.title).toBe("OpenAI");
		expect(openai[0]?.detail).toContain("Codex");
		// Engines Ryu routes add nothing.
		expect(engineProviderRows(providers, "acp:pi")).toEqual(
			engineProviderRows(providers, null)
		);
		// Once Core's launch check answers, the engine's row follows it: Codex
		// off its ChatGPT passthrough calls nothing itself, so it has no row.
		const routedCodex = engineProviderRows(providers, "acp:codex", null);
		expect(routedCodex).toEqual(engineProviderRows(providers, null));
		expect(
			engineProviderRows(providers, "acp:codex", "openai").find(
				(row) => row.key === "provider:openai"
			)?.detail
		).toContain("Codex");
		expect(engineProviderRows(providers, "acp:claude", "anthropic")[0]).toEqual(
			claude[0]
		);
	});

	test("toggling keeps keys the panel cannot see", () => {
		const start = ["provider:openai", "composio:a"];
		expect(toggleAccountKey(start, "composio:a", false)).toEqual([
			"provider:openai",
		]);
		expect(toggleAccountKey(start, "composio:b", true)).toEqual([
			"provider:openai",
			"composio:a",
			"composio:b",
		]);
		expect(toggleAccountKey(start, "composio:a", true)).toEqual(start);
	});

	test("a new limit starts from what is visible", () => {
		expect(startAccountLimit(["a", "b", "a"])).toEqual(["a", "b"]);
	});
});

interface Mounted {
	changes: (string[] | null)[];
	/** Every request the panel made, as `METHOD url` (the vault and own-app lists are the real ones). */
	fetched: string[];
}

function json(body: unknown, status = 200): Promise<Response> {
	return Promise.resolve(
		new Response(JSON.stringify(body), {
			headers: { "Content-Type": "application/json" },
			status,
		})
	);
}

/** The node's answer for `POST /api/agents/launch-check`. */
let launchCheckResponse: () => Promise<Response> = () =>
	json({
		launchable: true,
		runs_on_managed_pi: false,
		sandbox_supported: true,
	});
/** The bodies the panel sent to the launch check. */
const launchCheckBodies: unknown[] = [];

/** The node's answer for the agent's own Composio routes. */
let ownComposioResponse: () => Promise<Response> = () =>
	json({
		configured: true,
		data: [
			{
				access_level: "risk_based",
				active: true,
				id: "own_notion",
				key: "agent-composio:own_notion",
				status: "ACTIVE",
				toolkit: "notion",
			},
		],
		object: "list",
	});

async function mount(
	identityMode: AgentIdentityMode,
	accountAccess: string[] | null,
	agentId: string | null = "support",
	engine: string | null = null,
	savedIdentityMode?: AgentIdentityMode | null,
	launchNoticesShownElsewhere = false
): Promise<Mounted> {
	const fetched: string[] = [];
	const mounted: Mounted = { changes: [], fetched };
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		fetched.push(`${method} ${url}`);
		if (url.endsWith("/api/agents/launch-check")) {
			launchCheckBodies.push(JSON.parse(String(init?.body ?? "null")));
			return launchCheckResponse();
		}
		if (url.includes("/composio/connections/initiate")) {
			return json({
				access_level: "risk_based",
				connection_id: "own_new",
				redirect_url: "https://connect.composio.dev/link/own_new",
				status: "INITIATED",
			});
		}
		if (
			url.includes("/composio/connections/own_notion") &&
			method === "DELETE"
		) {
			return json({ id: "own_notion", ok: true });
		}
		if (url.includes("/composio/connections")) {
			return ownComposioResponse();
		}
		return Promise.resolve(
			new Response(
				JSON.stringify({
					accounts: [
						{
							created_at: 1,
							has_password: true,
							has_totp: true,
							host: "example.com",
							id: "acct_1",
							site: "https://example.com",
							updated_at: 1,
							username: "helper-bot",
						},
					],
				}),
				{ headers: { "Content-Type": "application/json" }, status: 200 }
			)
		);
	}) as typeof fetch;
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(AgentAccountAccessPanel, {
					accountAccess,
					agentId,
					disabled: false,
					engine,
					identityMode,
					launchNoticesShownElsewhere,
					onAccountAccessChange: (next: string[] | null) => {
						mounted.changes.push(next);
					},
					onToggleIdentity: () => undefined,
					savedIdentityMode,
					selectedIdentities: new Set<string>(),
				})
			)
		);
	});
	// Let the vault and Gateway config queries resolve.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return mounted;
}

function limitSwitch(): HTMLElement {
	const control = document.querySelector<HTMLElement>(
		'[aria-label="Limit to selected accounts"]'
	);
	if (!control) {
		throw new Error("Missing limit switch");
	}
	return control;
}

describe("AgentAccountAccessPanel", () => {
	test("acts as you: lists your accounts with status and hides its own", async () => {
		gatewayConfigLoads = 0;
		const mounted = await mount("managed", null);
		expect(mounted.fetched).toEqual([]);
		expect(gatewayConfigLoads).toBe(1);
		const text = document.body.textContent ?? "";

		expect(text).toContain("Your accounts");
		expect(text).toContain("Model providers");
		expect(text).toContain("OpenAI");
		expect(text).toContain("Gemini");
		expect(text).toContain("Ryu credits and local models are always available");
		expect(text).toContain("gmail");
		expect(text).toContain("Active");
		expect(text).toContain("Expired");
		expect(text).toContain("Treg");
		expect(text).toContain("Identities");
		expect(text).toContain("Services using your saved keys");
		expect(text).toContain("MCP server you added");
		expect(text).toContain("Control of your desktop");
		expect(text).toContain("it has no accounts of its own");
		expect(text).not.toContain("helper-bot");
		expect(text).not.toContain("Connect app");
	});

	test("its own identity: lists its vault accounts and hides yours", async () => {
		gatewayConfigLoads = 0;
		mcpServerLoads = 0;
		const mounted = await mount("individual", null);
		expect(
			mounted.fetched.some((request) =>
				request.includes("/api/vault/agent-accounts?agent_id=support")
			)
		).toBe(true);
		const text = document.body.textContent ?? "";

		expect(text).toContain("example.com");
		expect(text).toContain("helper-bot");
		expect(text).toContain("notion");
		expect(text).toContain("Connect app");
		expect(text).toContain("it never uses your accounts");
		expect(text).toContain("Ryu credits");
		expect(text).not.toContain("gmail");
		expect(text).not.toContain("Model providers");
		expect(text).not.toContain("Control of your desktop");
		expect(text).not.toContain("Services using your saved keys");
		expect(text).toContain("control your desktop");
		expect(gatewayConfigLoads).toBe(0);
		expect(mcpServerLoads).toBe(0);
	});

	test("turning the limit on starts from every visible account", async () => {
		const mounted = await mount("mixed", null);
		await act(async () => limitSwitch().click());

		expect(mounted.changes).toEqual([
			[
				"composio:ca_gmail",
				"composio:ca_slack",
				"provider:openai",
				"provider:genai",
				"provider:chutes",
				"provider:core",
				"provider:kiro",
				"mcp-secret:keyed",
				"platform:desktop",
				"platform:treg",
				"agent:acct_1",
				"agent-composio:own_notion",
			],
		]);
	});

	test("turning the limit off clears it back to unrestricted", async () => {
		const mounted = await mount("managed", ["composio:ca_gmail"]);
		await act(async () => limitSwitch().click());

		expect(mounted.changes).toEqual([null]);
	});

	test("unticking an account removes only that key", async () => {
		const mounted = await mount("managed", [
			"composio:ca_gmail",
			"platform:treg",
		]);
		const checkbox = document.getElementById(
			"account-access-composio:ca_gmail"
		);
		await act(async () => checkbox?.click());

		expect(mounted.changes).toEqual([["platform:treg"]]);
	});

	test("unticking a model provider removes only its key", async () => {
		const mounted = await mount("managed", [
			"provider:openai",
			"provider:genai",
		]);
		const checkbox = document.getElementById("account-access-provider:openai");
		expect(checkbox).not.toBeNull();
		await act(async () => checkbox?.click());

		expect(mounted.changes).toEqual([["provider:genai"]]);
	});

	test("the Treg switch is shown even for an agent with its own identity", async () => {
		await mount("individual", []);
		expect(document.querySelector('[aria-label="Allow Treg"]')).not.toBeNull();
	});

	test("a limited Both agent can tick an own account not on its list", async () => {
		const mounted = await mount("mixed", ["composio:ca_gmail"]);
		const checkbox = document.getElementById("account-access-agent:acct_1");
		expect(checkbox).not.toBeNull();
		await act(async () => checkbox?.click());

		expect(mounted.changes).toEqual([["composio:ca_gmail", "agent:acct_1"]]);
	});
	test("an unsaved agent asks to be saved before connecting apps", async () => {
		const mounted = await mount("individual", null, null);
		const text = document.body.textContent ?? "";
		expect(text).toContain("You can then connect apps to its own identity");
		expect(text).not.toContain("Connect app");
		expect(
			mounted.fetched.some((request) => request.includes("/composio/"))
		).toBe(false);
	});

	test("ticking an own connected app edits its agent-composio key", async () => {
		const mounted = await mount("individual", ["platform:treg"]);
		const checkbox = document.getElementById(
			"account-access-agent-composio:own_notion"
		);
		expect(checkbox).not.toBeNull();
		await act(async () => checkbox?.click());

		expect(mounted.changes).toEqual([
			["platform:treg", "agent-composio:own_notion"],
		]);
	});

	test("disconnect removes the app and its key", async () => {
		const mounted = await mount("individual", [
			"agent-composio:own_notion",
			"platform:treg",
		]);
		const button = document.querySelector<HTMLElement>(
			'[aria-label="Disconnect notion"]'
		);
		expect(button).not.toBeNull();
		await act(async () => button?.click());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(mounted.fetched).toContain(
			`DELETE ${node.url}/api/agents/support/composio/connections/own_notion`
		);
		expect(mounted.changes).toEqual([["platform:treg"]]);
	});

	test("connect app starts a connection for the agent and allows it", async () => {
		opened.length = 0;
		const mounted = await mount("mixed", ["platform:treg"]);
		const buttonWithText = (text: string) =>
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent?.trim() === text
			);
		await act(async () => buttonWithText("Connect app")?.click());
		const select = document.querySelector<HTMLSelectElement>(
			'select[aria-label="App to connect"]'
		);
		expect(select).not.toBeNull();
		await act(async () => {
			if (select) {
				select.value = "notion";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		await act(async () => buttonWithText("Continue")?.click());
		await act(async () => buttonWithText("Continue to connect")?.click());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(mounted.fetched).toContain(
			`POST ${node.url}/api/agents/support/composio/connections/initiate`
		);
		expect(opened).toEqual(["https://connect.composio.dev/link/own_new"]);
		expect(mounted.changes).toEqual([
			["platform:treg", "agent-composio:own_new"],
		]);
	});

	test("an unsaved switch from acting as you asks for a save before loading apps", async () => {
		const mounted = await mount("individual", null, "support", null, "managed");
		const text = document.body.textContent ?? "";
		expect(text).toContain("Save to connect apps for this agent.");
		expect(text).not.toContain("Connect app");
		expect(text).not.toContain("Couldn't load this agent's connected apps.");
		expect(
			mounted.fetched.some((request) => request.includes("/composio/"))
		).toBe(false);
		// Its vault accounts are still listed.
		expect(
			document.getElementById("account-access-agent:acct_1")
		).not.toBeNull();
	});

	test("a switch between its own identity and Both keeps its apps", async () => {
		await mount("mixed", null, "support", null, "individual");
		const text = document.body.textContent ?? "";
		expect(text).not.toContain("Save to connect apps for this agent.");
		expect(text).toContain("Connect app");
	});

	test("a 409 for the agent's apps shows Core's reason", async () => {
		const previous = ownComposioResponse;
		ownComposioResponse = () =>
			json(
				{
					error:
						"this agent acts as you; choose Its own identity or Both to connect apps for it",
				},
				409
			);
		try {
			await mount("mixed", null);
			const text = document.body.textContent ?? "";
			expect(text).toContain(
				"this agent acts as you; choose Its own identity or Both to connect apps for it"
			);
			expect(text).not.toContain("Couldn't load this agent's connected apps.");
		} finally {
			ownComposioResponse = previous;
		}
	});

	test("a Connect service without agent accounts says connecting is not available", async () => {
		const previous = ownComposioResponse;
		ownComposioResponse = () =>
			json(
				{
					code: "agent_entity_unsupported",
					error:
						"the Connect service on this node does not enable apps for agents",
				},
				501
			);
		try {
			await mount("mixed", null);
			const text = document.body.textContent ?? "";
			expect(text).toContain(
				"The Connect service on this node doesn't allow apps for agents."
			);
			expect(text).not.toContain("Connect app");
		} finally {
			ownComposioResponse = previous;
		}
	});
});

describe("AgentAccountAccessPanel launch check", () => {
	const reason =
		"This custom agent calls Anthropic itself, using your own sign-in or key, and this agent's account access doesn't allow Anthropic.";

	test("shows Core's reason when the engine would not start", async () => {
		launchCheckBodies.length = 0;
		launchCheckResponse = () =>
			json({
				code: "provider_access_refused",
				launchable: false,
				reason,
				runs_on_managed_pi: false,
				sandbox_supported: true,
				vendor_provider: "anthropic",
			});
		await mount("individual", null, "support", "acp:claude");

		expect(launchCheckBodies).toEqual([
			{
				account_access: null,
				agent_id: "support",
				engine: "acp:claude",
				identity_mode: "individual",
			},
		]);
		const alert = document.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain(reason);
	});

	test("says only Ryu can run it here when there is no sandbox", async () => {
		launchCheckResponse = () =>
			json({
				launchable: true,
				runs_on_managed_pi: true,
				sandbox_supported: false,
			});
		await mount("managed", ["provider:openai"], "support", "acp:pi");

		const text = document.body.textContent ?? "";
		expect(text).toContain(
			"On this computer, an agent with its own identity or limited accounts can run only on Ryu (without shell or file tools)."
		);
		expect(document.querySelector('[role="alert"]')).toBe(null);
	});

	test("leaves Core's refusal and the sandbox note to a page that shows them", async () => {
		launchCheckResponse = () =>
			json({
				code: "provider_access_refused",
				launchable: false,
				reason,
				runs_on_managed_pi: false,
				sandbox_supported: false,
				vendor_provider: "anthropic",
			});
		await mount("individual", null, "support", "acp:claude", undefined, true);

		const text = document.body.textContent ?? "";
		expect(text).not.toContain(reason);
		expect(text).not.toContain("can run only on Ryu");
	});

	test("an agent acting as you with no limit gets no sandbox note", async () => {
		launchCheckResponse = () =>
			json({
				launchable: true,
				runs_on_managed_pi: false,
				sandbox_supported: false,
			});
		await mount("managed", null, "support", "acp:claude");

		expect(document.body.textContent ?? "").not.toContain(
			"can run only on Ryu"
		);
	});
});
