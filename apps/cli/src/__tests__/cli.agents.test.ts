import { beforeEach, describe, expect, test } from "bun:test";
import { ApiError, type RequestOptions } from "@ryuhq/core-client/client";
import { parseAgentsArgs } from "../cli/agents.ts";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

const TARGET = { url: "http://127.0.0.1:7980", token: null };

interface Call {
	body?: unknown;
	method: string;
	path: string;
}

interface StoredAgent {
	account_access?: string[] | null;
	engine: string | null;
	id: string;
	identity_mode?: string;
	locked?: boolean;
	name: string;
	updated_at: string;
}

let stored: StoredAgent;
let calls: Call[];
let launchCheckFails = false;
let launchCheckMissing = false;

beforeEach(() => {
	stored = {
		id: "agent-1",
		name: "Researcher",
		engine: "acp:claude",
		updated_at: "2026-10-01T00:00:00Z",
	};
	calls = [];
	launchCheckFails = false;
	launchCheckMissing = false;
});

// A tiny Core: Core's patch semantics on PUT (absent = unchanged, null clears
// the allowlist), its revision guard, and a launch check that refuses
// `individual` on any engine but Ryu's own, as Core does for Claude Code.
function fakeCall(
	_target: unknown,
	path: string,
	options: RequestOptions = {}
): Promise<unknown> {
	const method = options.method ?? "GET";
	calls.push({ method, path, body: options.body });
	if (path === "/api/agents/launch-check") {
		if (launchCheckFails) {
			return Promise.reject(new ApiError(path, 503, "Core is busy"));
		}
		if (launchCheckMissing) {
			return Promise.reject(new ApiError(path, 404, "not found"));
		}
		const body = options.body as Record<string, unknown>;
		const refused =
			body.identity_mode === "individual" && body.engine !== "acp:pi";
		return Promise.resolve({
			launchable: !refused,
			reason: refused
				? "Claude Code signs in as you, so it can't run an agent with its own identity."
				: null,
			sandbox_supported: true,
			runs_on_managed_pi: false,
		});
	}
	if (path === "/api/agents" && method === "GET") {
		return Promise.resolve({
			agents: [{ id: stored.id, name: stored.name, engine: stored.engine }],
		});
	}
	if (path === "/api/agents" && method === "POST") {
		const body = options.body as Record<string, unknown>;
		return Promise.resolve({
			agent: {
				id: "agent-new",
				name: body.name,
				engine: body.engine,
				identity_mode: body.identity_mode,
				account_access: null,
			},
		});
	}
	if (path === `/api/agents/${stored.id}` && method === "GET") {
		return Promise.resolve({ agent: { ...stored } });
	}
	if (path === `/api/agents/${stored.id}` && method === "PUT") {
		const patch = options.body as Record<string, unknown>;
		if (stored.locked) {
			return Promise.reject(new ApiError(path, 409, "agent is locked"));
		}
		if (
			patch.expected_updated_at !== undefined &&
			patch.expected_updated_at !== stored.updated_at
		) {
			return Promise.reject(
				new ApiError(path, 409, "agent revision conflict: changed")
			);
		}
		stored = {
			...stored,
			...(patch.identity_mode === undefined
				? {}
				: { identity_mode: String(patch.identity_mode) }),
			...(patch.account_access === undefined
				? {}
				: { account_access: patch.account_access as string[] | null }),
			...(patch.engine === undefined ? {} : { engine: String(patch.engine) }),
			updated_at: "2026-10-02T00:00:00Z",
		};
		return Promise.resolve({ agent: { ...stored } });
	}
	return Promise.reject(new ApiError(path, 404, "agent not found"));
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

async function run(argv: string[]) {
	let out = "";
	let err = "";
	const io: CliIO = {
		out: (chunk) => {
			out += chunk;
		},
		err: (chunk) => {
			err += chunk;
		},
	};
	const code = await runCli(argv, { api: api(), io, target: TARGET });
	return { code, err, out };
}

const writes = () => calls.filter((call) => call.method !== "GET");
const puts = () => calls.filter((call) => call.method === "PUT");

describe("argument parsing", () => {
	test("own value flags are taken out of the positional args", () => {
		expect(
			parseAgentsArgs([
				"create",
				"My",
				"Agent",
				"--identity",
				"mixed",
				"--engine=acp:pi",
				"--json",
				"--node",
				"http://x",
			])
		).toEqual({
			engine: "acp:pi",
			identity: "mixed",
			model: null,
			positional: ["create", "My", "Agent"],
		});
	});

	test("an unknown flag or a missing value is a usage error", async () => {
		const typo = await run(["agents", "create", "A", "--mode", "individual"]);
		expect(typo.code).toBe(2);
		expect(typo.err).toContain("Unknown option '--mode'");
		const missing = await run(["agents", "create", "A", "--identity"]);
		expect(missing.code).toBe(2);
		expect(calls).toEqual([]);
	});
});

describe("ryu-cli agents show / list", () => {
	test("a legacy agent reads as Acts as you with no limit", async () => {
		const result = await run(["agents", "show", "agent-1"]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("How it works:   Acts as you (managed)");
		expect(result.out).toContain("Account access: No limit");
	});

	test("--json keeps null and [] distinct and marks unused keys in text", async () => {
		stored.identity_mode = "individual";
		stored.account_access = ["provider:openai", "agent:vault-1"];
		const json = await run(["agents", "show", "agent-1", "--json"]);
		expect(JSON.parse(json.out)).toEqual({
			id: "agent-1",
			name: "Researcher",
			engine: "acp:claude",
			identity_mode: "individual",
			account_access: ["provider:openai", "agent:vault-1"],
		});
		const text = await run(["agents", "access", "agent-1"]);
		expect(text.out).toContain("Limited to 2 accounts");
		expect(text.out).toContain("not used: it has only its own identity");
		stored.account_access = [];
		const none = await run(["agents", "show", "agent-1", "--json"]);
		expect(JSON.parse(none.out).account_access).toEqual([]);
	});

	test("an unknown mode from a newer Core reads as its own identity", async () => {
		stored.identity_mode = "delegate";
		const result = await run(["agents", "identity", "agent-1", "--json"]);
		expect(JSON.parse(result.out).identity_mode).toBe("individual");
	});

	test("list prints a table", async () => {
		const result = await run(["agents"]);
		expect(result.out).toContain("agent-1");
		expect(result.out).toContain("acp:claude");
	});
});

describe("ryu-cli agents create", () => {
	test("sends the identity mode with no tools and no account limit", async () => {
		const result = await run([
			"agents",
			"create",
			"Mixed",
			"Helper",
			"--identity",
			"mixed",
			"--engine",
			"acp:claude",
		]);
		expect(result.code).toBe(0);
		expect(calls.at(-1)).toEqual({
			method: "POST",
			path: "/api/agents",
			body: {
				name: "Mixed Helper",
				identity_mode: "mixed",
				engine: "acp:claude",
				model: null,
				tools: ["__ryu_none__"],
			},
		});
		expect(result.out).toContain("Both (mixed)");
	});

	test("defaults to Acts as you, like the desktop dialog", async () => {
		await run(["agents", "create", "Plain"]);
		expect(calls.at(-1)?.body).toMatchObject({ identity_mode: "managed" });
	});

	test("refuses an unknown mode and Core's launch refusal before writing", async () => {
		const bad = await run(["agents", "create", "A", "--identity", "owner"]);
		expect(bad.code).toBe(2);
		const refused = await run([
			"agents",
			"create",
			"A",
			"--identity",
			"individual",
			"--engine",
			"acp:claude",
		]);
		expect(refused.code).toBe(1);
		expect(refused.err).toContain("signs in as you");
		expect(refused.err).toContain("--engine acp:pi");
		expect(calls.some((call) => call.path === "/api/agents")).toBe(false);
	});
});

describe("ryu-cli agents identity", () => {
	test("changes only the mode, with the revision guard", async () => {
		const result = await run(["agents", "identity", "agent-1", "mixed"]);
		expect(result.code).toBe(0);
		expect(puts()).toEqual([
			{
				method: "PUT",
				path: "/api/agents/agent-1",
				body: {
					identity_mode: "mixed",
					expected_updated_at: "2026-10-01T00:00:00Z",
				},
			},
		]);
		expect(stored.identity_mode).toBe("mixed");
	});

	test("a refused engine saves nothing; --engine acp:pi switches to Ryu", async () => {
		const refused = await run(["agents", "identity", "agent-1", "individual"]);
		expect(refused.code).toBe(1);
		expect(refused.err).toContain("Nothing was saved");
		expect(puts()).toEqual([]);
		const switched = await run([
			"agents",
			"identity",
			"agent-1",
			"individual",
			"--engine",
			"acp:pi",
		]);
		expect(switched.code).toBe(0);
		expect(puts()[0]?.body).toEqual({
			identity_mode: "individual",
			engine: "acp:pi",
			expected_updated_at: "2026-10-01T00:00:00Z",
		});
	});

	test("a locked agent is refused before any write", async () => {
		stored.locked = true;
		const result = await run(["agents", "identity", "agent-1", "mixed"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("locked");
		expect(writes()).toEqual([]);
	});

	test("--dry-run previews without writing", async () => {
		const result = await run([
			"agents",
			"identity",
			"agent-1",
			"mixed",
			"--dry-run",
		]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("Nothing was saved (--dry-run)");
		expect(puts()).toEqual([]);
	});

	test("a Core without the launch check is not reported as a missing agent", async () => {
		launchCheckMissing = true;
		const result = await run(["agents", "identity", "agent-1", "mixed"]);
		expect(result.code).toBe(0);
		expect(result.err).toContain("this Core has no launch check");
		expect(result.err).not.toContain("was not found");
		expect(puts()).toHaveLength(1);
	});

	test("a failed launch check does not block the save, as on desktop", async () => {
		launchCheckFails = true;
		const result = await run(["agents", "identity", "agent-1", "mixed"]);
		expect(result.code).toBe(0);
		expect(result.err).toContain("could not ask Core");
		expect(puts()).toHaveLength(1);
	});
});

describe("ryu-cli agents access", () => {
	test("add on no limit narrows to Treg and the added keys", async () => {
		const result = await run([
			"agents",
			"access",
			"agent-1",
			"add",
			"provider:openai",
		]);
		expect(result.code).toBe(0);
		expect(puts()[0]?.body).toEqual({
			account_access: ["platform:treg", "provider:openai"],
			expected_updated_at: "2026-10-01T00:00:00Z",
		});
		expect(result.out).toContain("had no account limit");
		expect(result.out).toContain("no longer allowed");
	});

	test("an invalid key is refused and nothing is written", async () => {
		const result = await run([
			"agents",
			"access",
			"agent-1",
			"add",
			"provider:openai",
			"openai",
		]);
		expect(result.code).toBe(2);
		expect(result.err).toContain("Not an account key Core accepts: openai");
		expect(writes()).toEqual([]);
	});

	test("remove, clear and none", async () => {
		stored.account_access = ["provider:openai", "platform:treg"];
		await run(["agents", "access", "agent-1", "remove", "provider:openai"]);
		expect(stored.account_access).toEqual(["platform:treg"]);
		const missing = await run([
			"agents",
			"access",
			"agent-1",
			"remove",
			"provider:anthropic",
		]);
		expect(missing.code).toBe(1);
		await run(["agents", "access", "agent-1", "none"]);
		expect(stored.account_access).toEqual([]);
		await run(["agents", "access", "agent-1", "clear"]);
		expect(stored.account_access).toBeNull();
		expect(puts().at(-1)?.body).toEqual({
			account_access: null,
			expected_updated_at: "2026-10-02T00:00:00Z",
		});
	});

	test("remove on no limit explains instead of writing", async () => {
		const result = await run([
			"agents",
			"access",
			"agent-1",
			"remove",
			"provider:openai",
		]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("no account limit");
		expect(writes()).toEqual([]);
	});

	test("a key the mode cannot use is saved with a note", async () => {
		const result = await run([
			"agents",
			"access",
			"agent-1",
			"add",
			"agent:vault-1",
		]);
		expect(result.code).toBe(0);
		expect(result.err).toContain("agent:vault-1 is saved but not used");
	});

	test("a save made elsewhere in between is reported, not overwritten", async () => {
		const realCall = fakeCall;
		let first = true;
		const racing: CoreApi = {
			...api(),
			call: ((target: unknown, path: string, options?: RequestOptions) => {
				if (first && options?.method === "PUT") {
					first = false;
					stored.updated_at = "2026-10-05T00:00:00Z";
				}
				return realCall(target, path, options);
			}) as CoreApi["call"],
		};
		let err = "";
		const code = await runCli(["agents", "access", "agent-1", "none"], {
			api: racing,
			io: {
				out: () => undefined,
				err: (chunk) => {
					err += chunk;
				},
			},
			target: TARGET,
		});
		expect(code).toBe(1);
		expect(err).toContain("changed by someone else");
		expect(stored.account_access).toBeUndefined();
	});
});

describe("a remote A2A peer", () => {
	test("shows the note instead of an identity or account access", async () => {
		stored = { ...stored, engine: "a2a:peer-hermes" };
		const shown = await run(["agents", "show", "agent-1"]);
		expect(shown.code).toBe(0);
		expect(shown.out).toContain("Runs on another node");
		expect(shown.out).not.toContain("Account access:");
		const access = await run(["agents", "access", "agent-1"]);
		expect(access.out).toContain("Runs on another node");
	});

	test("refuses identity and account-access changes", async () => {
		stored = { ...stored, engine: "a2a:peer-hermes" };
		const identity = await run(["agents", "identity", "agent-1", "mixed"]);
		expect(identity.code).toBe(1);
		expect(identity.err).toContain("Nothing was saved");
		const access = await run([
			"agents",
			"access",
			"agent-1",
			"add",
			"provider:openai",
		]);
		expect(access.code).toBe(1);
		expect(puts()).toEqual([]);
	});

	test("can move to another engine in the same command", async () => {
		stored = { ...stored, engine: "a2a:peer-hermes" };
		const result = await run([
			"agents",
			"identity",
			"agent-1",
			"mixed",
			"--engine",
			"acp:pi",
		]);
		expect(result.code).toBe(0);
		expect(puts()).toHaveLength(1);
	});
});
