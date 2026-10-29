import { beforeEach, describe, expect, test } from "bun:test";
import { ApiError, type RequestOptions } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

// `ryu-cli agents access <id> available | pick`: the accounts an agent could be
// allowed, from the same Core endpoints the desktop editor reads.

const TARGET = { url: "http://127.0.0.1:7980", token: null };

interface StoredAgent {
	account_access?: string[] | null;
	engine: string | null;
	id: string;
	identity_mode?: string;
	locked?: boolean;
	name: string;
	/** A mode the agent's app asked for (`app_identity.pending_mode`). */
	pending_mode?: string;
	updated_at: string;
}

interface Call {
	body?: unknown;
	method: string;
	path: string;
}

let stored: StoredAgent;
let calls: Call[];
let routes: Record<string, unknown>;

beforeEach(() => {
	stored = {
		id: "agent-1",
		name: "Researcher",
		engine: "acp:claude",
		identity_mode: "mixed",
		updated_at: "2026-10-01T00:00:00Z",
	};
	calls = [];
	routes = {
		"/api/composio/status": { configured: true },
		"/api/composio/connections": {
			data: [
				{ id: "ca_gh", toolkit: "github", status: "ACTIVE", active: true },
				{ id: "ca_old", toolkit: "slack", status: "EXPIRED", active: false },
			],
		},
		"/api/gateway/config": {
			providers: {
				openai: { api_key: "***", base_url: "", api_key_count: 1 },
				core: { base_url: "", has_token: false },
			},
		},
		"/api/plugins": {
			apps: [
				{
					id: "@ryu/notion",
					name: "Notion",
					enabled: true,
					mcp_servers: {
						notion: {
							url: "https://mcp.notion.com",
							auth: { type: "oauth" },
						},
					},
					runnables: [],
				},
			],
		},
		"/api/plugins/%40ryu%2Fnotion/auth": {
			servers: [
				{
					server_name: "notion",
					connections: [
						{
							profile_id: "default",
							account_label: "me@example.com",
							status: "connected",
						},
					],
				},
			],
		},
		"/api/mcp/servers": {
			servers: [
				{ name: "github", saved_key_account: "github", owner_plugin_id: null },
			],
		},
		"/api/vault/agent-accounts?agent_id=agent-1": {
			accounts: [
				{
					id: "vault-1",
					host: "news.example",
					site: "news",
					username: "bot",
					has_totp: true,
				},
			],
		},
		"/api/agents/agent-1/composio/connections": {
			configured: true,
			data: [{ id: "ca_own", toolkit: "gmail", active: true }],
		},
	};
});

function fakeCall(
	_target: unknown,
	path: string,
	options: RequestOptions = {}
): Promise<unknown> {
	const method = options.method ?? "GET";
	calls.push({ method, path, body: options.body });
	if (path === "/api/agents/launch-check") {
		return Promise.resolve({
			launchable: true,
			reason: null,
			sandbox_supported: true,
			runs_on_managed_pi: false,
			vendor_provider: "anthropic",
		});
	}
	if (path === `/api/agents/${stored.id}` && method === "GET") {
		const { pending_mode: pending, ...agent } = stored;
		return Promise.resolve({
			agent,
			...(pending
				? { app_identity: { app_mode: "individual", pending_mode: pending } }
				: {}),
		});
	}
	if (path === `/api/agents/${stored.id}` && method === "PUT") {
		const patch = options.body as Record<string, unknown>;
		if (patch.expected_updated_at !== stored.updated_at) {
			return Promise.reject(
				new ApiError(path, 409, "agent revision conflict: changed")
			);
		}
		if (patch.dismiss_pending_identity_mode === true) {
			stored = { ...stored, pending_mode: undefined };
		}
		stored = {
			...stored,
			...(patch.account_access === undefined
				? {}
				: { account_access: patch.account_access as string[] | null }),
			updated_at: "2026-10-02T00:00:00Z",
		};
		const { pending_mode: _pending, ...agent } = stored;
		return Promise.resolve({ agent });
	}
	if (method === "GET" && routes[path] !== undefined) {
		return Promise.resolve(routes[path]);
	}
	return Promise.reject(new ApiError(path, 503, "Core is busy"));
}

function api(): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected Core API call"));
	return {
		call: fakeCall as CoreApi["call"],
		disableApp: notCalled,
		enableApp: notCalled,
		execAppCommand: notCalled,
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		streamChat: notCalled,
		uninstallApp: notCalled,
	};
}

async function run(argv: string[], answers: (string | null)[] = []) {
	let out = "";
	let err = "";
	const asked: string[] = [];
	const io: CliIO = {
		out: (chunk) => {
			out += chunk;
		},
		err: (chunk) => {
			err += chunk;
		},
	};
	const code = await runCli(argv, {
		api: api(),
		io,
		promptLine: (question) => {
			asked.push(question);
			return Promise.resolve(
				answers.length > 0 ? (answers.shift() ?? null) : null
			);
		},
		target: TARGET,
	});
	return { asked, code, err, out };
}

const puts = () => calls.filter((call) => call.method === "PUT");

describe("ryu-cli agents access <id> available", () => {
	test("lists every account it could be allowed with readable labels", async () => {
		const result = await run(["agents", "access", "agent-1", "available"]);
		expect(result.code).toBe(0);
		for (const expected of [
			"platform:treg",
			"composio:ca_gh",
			"github",
			"slack (Expired)",
			"provider:openai",
			"OpenAI",
			"provider:anthropic",
			"Anthropic (Claude Code's own sign-in or key)",
			"mcp:default:@ryu/notion:notion",
			"Notion · notion",
			"mcp-secret:github",
			"platform:desktop",
			"agent:vault-1",
			"news.example (2FA)",
			"agent-composio:ca_own",
			"gmail",
		]) {
			expect(result.out).toContain(expected);
		}
		expect(puts()).toEqual([]);
	});

	test("--json gives keys, labels, whether each is allowed and what is not listed", async () => {
		stored.account_access = ["platform:treg", "composio:gone"];
		const result = await run([
			"agents",
			"access",
			"agent-1",
			"available",
			"--json",
		]);
		expect(result.code).toBe(0);
		const json = JSON.parse(result.out) as {
			accounts: { allowed: boolean; key: string; title: string }[];
			errors: unknown[];
			not_listed: { key: string; kind: string; unused_reason: string | null }[];
		};
		expect(
			json.accounts.find((row) => row.key === "platform:treg")
		).toMatchObject({ allowed: true, title: "Treg" });
		expect(
			json.accounts.find((row) => row.key === "composio:ca_gh")
		).toMatchObject({ allowed: false, title: "github" });
		expect(json.not_listed).toEqual([
			{ key: "composio:gone", kind: "Connected apps", unused_reason: null },
		]);
		expect(json.errors).toEqual([]);
	});

	test("the mode decides which groups are listed", async () => {
		stored.identity_mode = "managed";
		const managed = await run(["agents", "access", "agent-1", "available"]);
		expect(managed.out).not.toContain("agent:vault-1");
		expect(managed.out).toContain("Its own accounts: not shown");
		expect(calls.some((call) => call.path.startsWith("/api/vault"))).toBe(
			false
		);

		calls = [];
		stored.identity_mode = "individual";
		const individual = await run(["agents", "access", "agent-1", "available"]);
		expect(individual.out).not.toContain("composio:ca_gh");
		expect(individual.out).toContain("Your accounts: not shown");
		expect(
			calls.some((call) => call.path.startsWith("/api/composio/connections"))
		).toBe(false);
	});

	test("a source that fails says so instead of looking empty", async () => {
		routes = { ...routes, "/api/gateway/config": undefined };
		const result = await run(["agents", "access", "agent-1", "available"]);
		expect(result.code).toBe(0);
		expect(result.out).toContain(
			"Model providers: Couldn't load your model providers. (Core is busy)"
		);
	});
});

describe("an app's identity request", () => {
	test("is shown, and dismissing it keeps the mode", async () => {
		stored.identity_mode = "individual";
		stored.pending_mode = "managed";
		const shown = await run(["agents", "show", "agent-1"]);
		expect(shown.out).toContain("App request:    Acts as you");
		expect(shown.out).toContain("ryu-cli agents identity agent-1 dismiss");

		const dismissed = await run(["agents", "identity", "agent-1", "dismiss"]);
		expect(dismissed.code).toBe(0);
		expect(puts()[0]?.body).toEqual({
			dismiss_pending_identity_mode: true,
			expected_updated_at: "2026-10-01T00:00:00Z",
		});
		expect(dismissed.out).not.toContain("App request");
		expect(stored.pending_mode).toBeUndefined();

		const nothing = await run(["agents", "identity", "agent-1", "dismiss"]);
		expect(nothing.code).not.toBe(0);
		expect(nothing.err).toContain("no identity request");
	});
});

describe("ryu-cli agents access <id> pick", () => {
	test("won't start a limit while a group failed to load", async () => {
		stored.identity_mode = "managed";
		routes = { ...routes, "/api/gateway/config": undefined };
		const result = await run(
			["agents", "access", "agent-1", "pick"],
			["3", "all", "save"]
		);
		expect(result.code).toBe(0);
		expect(result.err).toContain("Couldn't load Model providers");
		expect(result.out).toContain("Nothing changed, so nothing was saved.");
		expect(puts()).toEqual([]);
	});

	test("unticking under no limit starts a limit from every listed account", async () => {
		stored.identity_mode = "managed";
		// Rows: 1 Treg, 2 github, 3 slack, 4 Anthropic (engine), 5 OpenAI,
		// 6 Notion, 7 github saved key, 8 desktop.
		const result = await run(
			["agents", "access", "agent-1", "pick"],
			["3 7", "save"]
		);
		expect(result.code).toBe(0);
		expect(result.out).toContain("1 [x] Treg");
		expect(result.out).toContain("Limit turned on");
		expect(puts()).toHaveLength(1);
		expect(puts()[0]?.body).toEqual({
			account_access: [
				"platform:treg",
				"composio:ca_gh",
				"provider:anthropic",
				"provider:openai",
				"mcp:default:@ryu/notion:notion",
				"platform:desktop",
			],
			expected_updated_at: "2026-10-01T00:00:00Z",
		});
	});

	test("keys it cannot list are kept, shown, and can be removed", async () => {
		stored.identity_mode = "managed";
		stored.account_access = ["composio:gone", "platform:treg"];
		const kept = await run(
			["agents", "access", "agent-1", "pick"],
			["2", "save"]
		);
		expect(kept.out).toContain("Allowed but not listed now");
		expect(kept.out).toContain("9 [x] composio:gone");
		expect(puts()[0]?.body).toMatchObject({
			account_access: ["composio:gone", "platform:treg", "composio:ca_gh"],
		});

		const removed = await run(
			["agents", "access", "agent-1", "pick"],
			["9", "save"]
		);
		expect(removed.code).toBe(0);
		expect(stored.account_access).toEqual(["platform:treg", "composio:ca_gh"]);
	});

	test("none, unlimited and cancel", async () => {
		stored.account_access = ["platform:treg"];
		await run(["agents", "access", "agent-1", "pick"], ["unlimited", "save"]);
		expect(stored.account_access).toBeNull();
		await run(["agents", "access", "agent-1", "pick"], ["none", "save"]);
		expect(stored.account_access).toEqual([]);
		const before = puts().length;
		const cancelled = await run(
			["agents", "access", "agent-1", "pick"],
			["all", "cancel"]
		);
		expect(cancelled.out).toContain("Nothing was saved");
		expect(puts()).toHaveLength(before);
	});

	test("a bad row number is explained and nothing changes", async () => {
		const result = await run(
			["agents", "access", "agent-1", "pick"],
			["99", "x", "save"]
		);
		expect(result.err).toContain("There is no row 99");
		expect(result.err).toContain("'x' is not a row number");
		expect(result.out).toContain("Nothing changed");
		expect(puts()).toEqual([]);
	});

	test("without a terminal it refuses instead of saving", async () => {
		const result = await run(["agents", "access", "agent-1", "pick"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("needs an interactive terminal");
		expect(puts()).toEqual([]);
		const json = await run(["agents", "access", "agent-1", "pick", "--json"]);
		expect(json.code).toBe(2);
		expect(json.asked).toEqual([]);
	});

	test("a locked agent or a remote peer cannot be picked for", async () => {
		stored.locked = true;
		const locked = await run(["agents", "access", "agent-1", "pick"], ["save"]);
		expect(locked.code).toBe(1);
		expect(locked.err).toContain("locked");
		expect(locked.asked).toEqual([]);

		stored.locked = false;
		stored.engine = "a2a:peer";
		const peer = await run(["agents", "access", "agent-1", "pick"], ["save"]);
		expect(peer.code).toBe(1);
		expect(peer.err).toContain("Runs on another node".toLowerCase());
		expect(puts()).toEqual([]);
	});
});
