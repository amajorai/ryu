import { describe, expect, test } from "bun:test";
import {
	type AvailableAccounts,
	accountCatalogLoadFailed,
	accountLimitStartBlocked,
	accountPickerRows,
	appUsesSavedKeys,
	engineModelProvider,
	keysNotListed,
	loadAvailableAccounts,
	modelProviderRows,
	parsePickCommand,
	sameAccountAccess,
	savedKeyRows,
	toggleAccountAccess,
} from "./agentAccountCatalog.ts";

function accounts(keys: string[]): AvailableAccounts {
	return {
		hiddenGroups: [],
		sections: [
			{
				empty: "",
				error: null,
				id: "connected-apps",
				owner: "yours",
				rows: keys.map((key) => ({
					detail: null,
					key,
					section: "connected-apps",
					status: null,
					title: key,
				})),
				title: "Connected apps",
			},
		],
	};
}

describe("picking", () => {
	test("toggling under no limit starts a limit from every listed account", () => {
		const listed = accounts(["platform:treg", "composio:a", "composio:b"]);
		expect(toggleAccountAccess(null, listed, "composio:a")).toEqual([
			"platform:treg",
			"composio:b",
		]);
	});

	test("toggling keeps keys the list cannot show", () => {
		const listed = accounts(["composio:a"]);
		expect(
			toggleAccountAccess(["composio:gone"], listed, "composio:a")
		).toEqual(["composio:gone", "composio:a"]);
		expect(keysNotListed(["composio:gone", "composio:a"], listed)).toEqual([
			"composio:gone",
		]);
		expect(
			accountPickerRows(listed, ["composio:gone"]).map((row) => row.key)
		).toEqual(["composio:a", "composio:gone"]);
	});

	test("parsePickCommand reads rows, ranges and words", () => {
		expect(parsePickCommand("1 3-4, 2", 5)).toEqual({
			kind: "toggle",
			indexes: [0, 2, 3, 1],
		});
		expect(parsePickCommand(" SAVE ", 5)).toEqual({ kind: "save" });
		expect(parsePickCommand("unlimited", 5)).toEqual({ kind: "no-limit" });
		expect(parsePickCommand("", 5)).toEqual({ kind: "show" });
		expect(parsePickCommand("6", 5).kind).toBe("invalid");
		expect(parsePickCommand("0", 5).kind).toBe("invalid");
		expect(parsePickCommand("4-2", 5).kind).toBe("invalid");
		expect(parsePickCommand("x", 5).kind).toBe("invalid");
	});

	test("sameAccountAccess ignores order but not no-limit vs none", () => {
		expect(sameAccountAccess(["a", "b"], ["b", "a"])).toBe(true);
		expect(sameAccountAccess(null, [])).toBe(false);
		expect(sameAccountAccess(null, null)).toBe(true);
	});
});

describe("row builders mirror desktop", () => {
	test("the engine's own vendor is listed unless Core names another", () => {
		const providers = { openai: { api_key: "***", api_key_count: 1 } };
		expect(
			modelProviderRows(providers, "acp:claude").map((row) => row.key)
		).toEqual(["provider:anthropic", "provider:openai"]);
		expect(
			modelProviderRows(providers, "acp:claude", null).map((row) => row.key)
		).toEqual(["provider:openai"]);
		const codex = modelProviderRows(providers, "acp:codex", "openai");
		expect(codex).toHaveLength(1);
		expect(codex[0]?.detail).toContain("Codex");
		expect(engineModelProvider("acp-exec:node /x/kiro-cli.js")?.id).toBe(
			"kiro"
		);
		expect(engineModelProvider("acp:pi")).toBeNull();
	});

	test("Gemini is listed under its registry id", () => {
		expect(
			modelProviderRows({ genai: { keys: ["gemini"] } }, null).map(
				(row) => row.key
			)
		).toEqual(["provider:genai"]);
	});

	test("saved-key services: MCP servers Core flags and apps whose tools use a key", () => {
		expect(
			appUsesSavedKeys([
				{ kind: "tool", config: { env: { TOKEN: "env:RYU_TOKEN" } } },
			])
		).toBe(false);
		const rows = savedKeyRows(
			[{ name: "gh", saved_key_account: "gh", owner_plugin_id: null }],
			[
				{
					enabled: true,
					id: "@ryu/x",
					name: "X",
					runnables: [
						{ kind: "tool", config: { secret_headers: { a: "secret:X_KEY" } } },
					],
				},
				{
					enabled: false,
					id: "@ryu/off",
					name: "Off",
					runnables: [{ kind: "tool", config: { env: { a: "vault:k" } } }],
				},
			]
		);
		expect(rows.map((row) => [row.key, row.title, row.detail])).toEqual([
			["mcp-secret:gh", "gh", "MCP server you added"],
			["mcp-secret:@ryu/x", "X", "App"],
		]);
	});
});

describe("loadAvailableAccounts", () => {
	test("never throws: each failed source says so on its section", async () => {
		const result = await loadAvailableAccounts(
			{
				get: () => Promise.reject(new Error("offline")),
				post: () => Promise.reject(new Error("offline")),
			},
			{ agentId: "a", engine: null, identityMode: "mixed" }
		);
		const errors = result.sections
			.filter((entry) => entry.error)
			.map((entry) => entry.id);
		expect(errors).toEqual([
			"connected-apps",
			"model-providers",
			"mcp-sign-ins",
			"saved-keys",
			"own-logins",
			"own-connected-apps",
		]);
		expect(result.sections[0]?.rows[0]?.key).toBe("platform:treg");
	});

	test("a body that does not parse is that section's error, not a throw", async () => {
		const malformed: Record<string, unknown> = {
			"/api/composio/status": { configured: true },
			"/api/composio/connections": { data: "not a list" },
			"/api/plugins": { apps: [{ id: 7 }] },
			"/api/mcp/servers": { servers: {} },
			"/api/gateway/config": { providers: "nope" },
		};
		const result = await loadAvailableAccounts(
			{
				get: (path) =>
					Promise.resolve(
						path.startsWith("/api/vault/") ? { accounts: 3 } : malformed[path]
					),
				post: () => Promise.resolve({}),
			},
			{ agentId: "a", engine: null, identityMode: "mixed" }
		);
		const errors = result.sections
			.filter((entry) => entry.error)
			.map((entry) => entry.id);
		expect(errors).toEqual([
			"connected-apps",
			"model-providers",
			"mcp-sign-ins",
			"saved-keys",
			"own-logins",
			"own-connected-apps",
		]);
	});

	test("an agent saved as Acts as you is not asked for apps of its own", async () => {
		const paths: string[] = [];
		const result = await loadAvailableAccounts(
			{
				get: (path) => {
					paths.push(path);
					return Promise.resolve(
						path === "/api/composio/status" ? { configured: true } : {}
					);
				},
				post: () => Promise.resolve({}),
			},
			{
				agentId: "a",
				engine: null,
				identityMode: "mixed",
				savedIdentityMode: "managed",
			}
		);
		expect(paths.some((path) => path.includes("/api/agents/"))).toBe(false);
		expect(
			result.sections.find((entry) => entry.id === "own-connected-apps")?.empty
		).toContain("Save the agent");
	});
});

describe("starting a limit", () => {
	test("is refused while a section failed to load, naming it", () => {
		const loaded = accounts(["platform:treg", "composio:a"]);
		expect(accountLimitStartBlocked(loaded)).toBeNull();
		const failed: AvailableAccounts = {
			...loaded,
			sections: [
				...loaded.sections,
				{
					empty: "",
					error: "Couldn't load your model providers.",
					id: "model-providers",
					owner: "yours",
					rows: [],
					title: "Model providers",
				},
			],
		};
		expect(accountLimitStartBlocked(failed)).toContain("Model providers");
		expect(
			accountLimitStartBlocked(accountCatalogLoadFailed(new Error("x")))
		).not.toBeNull();
	});
});
