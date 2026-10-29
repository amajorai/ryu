// `ryu connect` / `ryu disconnect` / `ryu doctor agents`: the per-agent config
// merge and removal rules (pure string functions), plus the command layer run
// against a temp HOME + temp state dir with a fake fetch, so no real agent
// config, Core node, or network is ever touched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	type AgentTarget,
	describeEntry,
	findAgent,
	type JsonObject,
	readEntry,
	removeEntry,
	UnsupportedConfigError,
	writeEntry,
} from "../cli/agentConnect.ts";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, FetchLike } from "../cli/types.ts";

const MCP_URL = "http://127.0.0.1:7980/mcp/ryu";
const TOKEN = "ryu_test_token";
/** Spelled out so `${…}` env references read as literal text, not placeholders. */
const DOLLAR = "$";

function agent(id: string): AgentTarget {
	const found = findAgent(id);
	if (!found) {
		throw new Error(`missing agent ${id}`);
	}
	return found;
}

function inlineEntry(id: string): JsonObject {
	return agent(id).buildEntry({
		mcpUrl: MCP_URL,
		token: TOKEN,
		tokenMode: "inline",
	});
}

describe("entry shapes", () => {
	test("each agent gets its own key names and env reference syntax", () => {
		expect(inlineEntry("claude-code")).toEqual({
			type: "http",
			url: MCP_URL,
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(inlineEntry("cursor")).toEqual({
			url: MCP_URL,
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(inlineEntry("opencode")).toEqual({
			type: "remote",
			url: MCP_URL,
			enabled: true,
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(inlineEntry("gemini")).toEqual({
			httpUrl: MCP_URL,
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(inlineEntry("codex")).toEqual({
			url: MCP_URL,
			http_headers: { Authorization: `Bearer ${TOKEN}` },
		});
		const env = { mcpUrl: MCP_URL, token: null, tokenMode: "env" } as const;
		expect(agent("claude-code").buildEntry(env).headers).toEqual({
			Authorization: `Bearer ${DOLLAR}{RYU_CORE_TOKEN}`,
		});
		expect(agent("cursor").buildEntry(env).headers).toEqual({
			Authorization: `Bearer ${DOLLAR}{env:RYU_CORE_TOKEN}`,
		});
		expect(agent("opencode").buildEntry(env).headers).toEqual({
			Authorization: "Bearer {env:RYU_CORE_TOKEN}",
		});
		expect(agent("codex").buildEntry(env)).toEqual({
			url: MCP_URL,
			bearer_token_env_var: "RYU_CORE_TOKEN",
		});
	});

	test("inline mode without a token is refused", () => {
		expect(() =>
			agent("cursor").buildEntry({
				mcpUrl: MCP_URL,
				token: null,
				tokenMode: "inline",
			})
		).toThrow("No node token");
	});

	test("describeEntry reads the URL and credential back for every format", () => {
		for (const id of ["claude-code", "cursor", "opencode", "gemini", "codex"]) {
			expect(describeEntry(inlineEntry(id))).toEqual({
				inlineToken: TOKEN,
				tokenMode: "inline",
				url: MCP_URL,
			});
			expect(
				describeEntry(
					agent(id).buildEntry({
						mcpUrl: MCP_URL,
						token: null,
						tokenMode: "env",
					})
				).tokenMode
			).toBe("env");
		}
		expect(describeEntry({ command: "x" }).tokenMode).toBe("none");
	});
});

describe("JSON configs", () => {
	const cursor = () => agent("cursor");

	test("merging keeps other servers, other settings, key order and indentation", () => {
		const original =
			'{\n\t"theme": "dark",\n\t"mcpServers": {\n\t\t"git": { "command": "mcp-git" }\n\t}\n}\n';
		const next = writeEntry(cursor(), original, inlineEntry("cursor"));
		const parsed = JSON.parse(next);
		expect(Object.keys(parsed)).toEqual(["theme", "mcpServers"]);
		expect(Object.keys(parsed.mcpServers)).toEqual(["git", "ryu"]);
		expect(parsed.mcpServers.git).toEqual({ command: "mcp-git" });
		expect(next).toContain('\n\t"theme"');
		expect(next.endsWith("\n")).toBe(true);
	});

	test("a missing file or container is created", () => {
		const next = writeEntry(agent("opencode"), null, inlineEntry("opencode"));
		expect(JSON.parse(next)).toEqual({ mcp: { ryu: inlineEntry("opencode") } });
	});

	test("removal drops only the ryu entry", () => {
		const original = writeEntry(
			cursor(),
			'{"mcpServers":{"git":{"command":"mcp-git"}}}',
			inlineEntry("cursor")
		);
		const removed = removeEntry(cursor(), original, false);
		expect(removed).not.toBeNull();
		expect(JSON.parse(removed ?? "")).toEqual({
			mcpServers: { git: { command: "mcp-git" } },
		});
	});

	test("a file Ryu created is deleted once only its entry remains", () => {
		const created = writeEntry(cursor(), null, inlineEntry("cursor"));
		expect(removeEntry(cursor(), created, true)).toBeNull();
		// Without the created marker the (now empty) file is kept.
		expect(removeEntry(cursor(), created, false)).toBe(
			'{\n  "mcpServers": {}\n}\n'
		);
	});

	test("JSON with comments or a non-object server map is refused", () => {
		expect(() =>
			writeEntry(
				agent("opencode"),
				'{ // hi\n "mcp": {} }',
				inlineEntry("opencode")
			)
		).toThrow(UnsupportedConfigError);
		expect(() =>
			writeEntry(cursor(), '{"mcpServers": []}', inlineEntry("cursor"))
		).toThrow(UnsupportedConfigError);
	});
});

describe("Codex TOML config", () => {
	const codex = () => agent("codex");
	const original = [
		"# my codex config",
		'model = "o3"',
		"",
		"[mcp_servers.git]",
		'command = "mcp-git"',
		"",
		"# profiles",
		"[profiles.fast]",
		'model = "o4-mini"',
		"",
	].join("\n");

	test("connect appends a table and keeps comments and layout", () => {
		const next = writeEntry(codex(), original, inlineEntry("codex"));
		expect(next.startsWith(original)).toBe(true);
		expect(next.slice(original.length)).toBe(
			`\n[mcp_servers.ryu]\nurl = "${MCP_URL}"\nhttp_headers = { Authorization = "Bearer ${TOKEN}" }\n`
		);
		expect(readEntry(codex(), next)).toEqual(inlineEntry("codex"));
	});

	test("disconnect restores the original bytes", () => {
		const next = writeEntry(codex(), original, inlineEntry("codex"));
		expect(removeEntry(codex(), next, false)).toBe(original);
	});

	test("an existing ryu table is replaced in place, subtables included", () => {
		const withRyu = [
			'model = "o3"',
			"",
			"[mcp_servers.ryu]",
			'url = "http://old/mcp/ryu"',
			"",
			"[mcp_servers.ryu.tools.x]",
			'approval_mode = "approve"',
			"",
			"# git server",
			"[mcp_servers.git]",
			'command = "mcp-git"',
			"",
		].join("\n");
		const next = writeEntry(codex(), withRyu, inlineEntry("codex"));
		expect(next).toBe(
			[
				'model = "o3"',
				"",
				"[mcp_servers.ryu]",
				`url = "${MCP_URL}"`,
				`http_headers = { Authorization = "Bearer ${TOKEN}" }`,
				"",
				"# git server",
				"[mcp_servers.git]",
				'command = "mcp-git"',
				"",
			].join("\n")
		);
		expect(readEntry(codex(), next)).toEqual(inlineEntry("codex"));
	});

	test("CRLF files stay CRLF", () => {
		const crlf = 'model = "o3"\r\n';
		const next = writeEntry(codex(), crlf, inlineEntry("codex"));
		expect(next).not.toMatch(/[^\r]\n/);
		expect(removeEntry(codex(), next, false)).toBe(crlf);
	});

	test("an inline ryu entry or a root inline server map is refused", () => {
		const inline = '[mcp_servers]\nryu = { url = "http://x" }\n';
		expect(() => writeEntry(codex(), inline, inlineEntry("codex"))).toThrow(
			UnsupportedConfigError
		);
		expect(() => removeEntry(codex(), inline, false)).toThrow(
			UnsupportedConfigError
		);
		const rootInline = 'mcp_servers = { git = { command = "g" } }\n';
		expect(() => writeEntry(codex(), rootInline, inlineEntry("codex"))).toThrow(
			UnsupportedConfigError
		);
	});

	test("a file Ryu created is deleted once only its table remains", () => {
		const created = writeEntry(codex(), null, inlineEntry("codex"));
		expect(removeEntry(codex(), created, true)).toBeNull();
	});
});

// ── Command layer ──────────────────────────────────────────────────────────────

let home = "";
let env: Record<string, string | undefined> = {};
const target: ApiTarget = { url: "http://127.0.0.1:7980", token: TOKEN };

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ryu-agent-connect-"));
	mkdirSync(join(home, "bin"));
	env = {
		HOME: home,
		USERPROFILE: home,
		RYU_CLI_CONFIG_DIR: join(home, "state"),
		PATH: join(home, "bin"),
	};
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function capture() {
	const output = { out: "", err: "" };
	const io: CliIO = {
		out: (s) => {
			output.out += s;
		},
		err: (s) => {
			output.err += s;
		},
	};
	return { io, output };
}

const failingFetch: FetchLike = () =>
	Promise.reject(new Error("no network in tests"));

function run(argv: string[], fetchImpl: FetchLike = failingFetch) {
	const { io, output } = capture();
	return runCli(argv, { env, fetch: fetchImpl, io, target }).then((code) => ({
		code,
		output,
	}));
}

function writeHomeFile(relative: string, contents: string): string {
	const path = join(home, relative);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
	return path;
}

test("connect then disconnect round-trips a user's Cursor config byte for byte", async () => {
	const original =
		'{\n  "mcpServers": {\n    "git": { "command": "mcp-git" }\n  }\n}\n';
	const path = writeHomeFile(".cursor/mcp.json", original);

	const connected = await run(["connect", "cursor"]);
	expect(connected.code).toBe(0);
	expect(connected.output.err).toContain("plain text");
	const written = JSON.parse(readFileSync(path, "utf8"));
	expect(written.mcpServers.ryu).toEqual(inlineEntry("cursor"));
	expect(written.mcpServers.git).toEqual({ command: "mcp-git" });

	const again = await run(["connect", "cursor", "--json"]);
	expect(JSON.parse(again.output.out).action).toBe("unchanged");

	const disconnected = await run(["disconnect", "cursor"]);
	expect(disconnected.code).toBe(0);
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(original));
});

test("connect creates a missing config with mode 0600 and disconnect deletes it", async () => {
	const result = await run(["connect", "claude-code"]);
	expect(result.code).toBe(0);
	const path = join(home, ".claude.json");
	if (process.platform !== "win32") {
		expect(readFileSync(path).length).toBeGreaterThan(0);
		const { statSync } = await import("node:fs");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	}
	expect((await run(["disconnect", "claude-code"])).code).toBe(0);
	expect(existsSync(path)).toBe(false);
});

test("connect refuses a ryu entry it did not write unless --force", async () => {
	const foreign = '{"mcpServers":{"ryu":{"command":"something-else"}}}';
	const path = writeHomeFile(".gemini/settings.json", foreign);

	const refused = await run(["connect", "gemini"]);
	expect(refused.code).toBe(1);
	expect(refused.output.err).toContain("--force");
	expect(readFileSync(path, "utf8")).toBe(foreign);

	const forced = await run(["connect", "gemini", "--force"]);
	expect(forced.code).toBe(0);
	expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.ryu).toEqual(
		inlineEntry("gemini")
	);
});

test("disconnect refuses an entry edited after connect unless --force", async () => {
	const path = join(home, ".cursor", "mcp.json");
	await run(["connect", "cursor"]);
	const edited = JSON.parse(readFileSync(path, "utf8"));
	edited.mcpServers.ryu.url = "http://elsewhere/mcp/ryu";
	writeFileSync(path, JSON.stringify(edited));

	const refused = await run(["disconnect", "cursor"]);
	expect(refused.code).toBe(1);
	expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.ryu.url).toBe(
		"http://elsewhere/mcp/ryu"
	);
	expect((await run(["disconnect", "cursor", "--force"])).code).toBe(0);
	// Ryu created this file and nothing else is in it, so it is removed.
	expect(existsSync(path)).toBe(false);
});

test("--print and --dry-run write nothing; dry-run redacts the token", async () => {
	const printed = await run(["connect", "codex", "--print"]);
	expect(printed.code).toBe(0);
	expect(printed.output.out).toContain("[mcp_servers.ryu]");
	expect(printed.output.out).toContain(TOKEN);

	const dry = await run(["connect", "codex", "--dry-run"]);
	expect(dry.code).toBe(0);
	expect(dry.output.out).toContain("<node token>");
	expect(dry.output.out).not.toContain(TOKEN);
	expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
	expect(existsSync(join(home, "state", "agent-connect.json"))).toBe(false);
});

test("an uneditable config falls back to printing the snippet", async () => {
	const jsonc = '{\n  // my settings\n  "mcp": {}\n}\n';
	const path = writeHomeFile(".config/opencode/opencode.jsonc", jsonc);
	const result = await run(["connect", "opencode", "--token-env"]);
	expect(result.code).toBe(1);
	expect(result.output.err).toContain("Nothing was written");
	expect(result.output.out).toContain("{env:RYU_CORE_TOKEN}");
	expect(readFileSync(path, "utf8")).toBe(jsonc);
});

test("--token-env writes no token at all", async () => {
	const result = await run(["connect", "codex", "--token-env"]);
	expect(result.code).toBe(0);
	const text = readFileSync(join(home, ".codex", "config.toml"), "utf8");
	expect(text).toContain('bearer_token_env_var = "RYU_CORE_TOKEN"');
	expect(text).not.toContain(TOKEN);
});

test("an unknown agent is a usage error", async () => {
	const result = await run(["connect", "notepad"]);
	expect(result.code).toBe(2);
	expect(result.output.err).toContain("claude-code");
});

function mcpFetch(
	status: number,
	body: unknown,
	seen: string[] = []
): FetchLike {
	return (url, init) => {
		const auth = new Headers(init?.headers).get("authorization") ?? "";
		seen.push(`${url} ${auth}`);
		return Promise.resolve(
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			})
		);
	};
}

test("doctor agents reports binaries, entries and a passing endpoint", async () => {
	const fakeCodex = join(home, "bin", "codex");
	writeFileSync(fakeCodex, "#!/bin/sh\n");
	chmodSync(fakeCodex, 0o755);
	await run(["connect", "cursor"]);

	const seen: string[] = [];
	const ok = mcpFetch(
		200,
		{ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
		seen
	);
	const result = await run(["doctor", "agents", "--json"], ok);
	expect(result.code).toBe(0);
	const report = JSON.parse(result.output.out);
	expect(report.endpoint.status).toBe("ok");
	const byId = new Map(
		report.agents.map((entry: { id: string }) => [entry.id, entry])
	);
	expect(byId.get("cursor")).toMatchObject({
		status: "connected",
		managedByRyu: true,
		tokenMode: "inline",
	});
	expect(byId.get("codex")).toMatchObject({
		status: "not-connected",
		binary: fakeCodex,
		fix: "ryu-cli connect codex",
	});
	expect(byId.get("opencode")).toMatchObject({ binary: null, fix: null });
	expect(seen).toContain(`${MCP_URL} Bearer ${TOKEN}`);
});

test("doctor agents fails on a rejected token and points at connect", async () => {
	await run(["connect", "claude-code"]);
	const rejected = mcpFetch(401, { ok: false, error: "invalid token" });
	const result = await run(["doctor", "agents"], rejected);
	expect(result.code).toBe(1);
	expect(result.output.out).toContain("unauthorized");
	expect(result.output.out).toContain("ryu-cli connect claude-code");
});

test("doctor agents flags a ryu entry that targets another node", async () => {
	writeHomeFile(
		".cursor/mcp.json",
		'{"mcpServers":{"ryu":{"url":"http://10.0.0.9:7980/mcp/ryu"}}}'
	);
	const ok = mcpFetch(200, { jsonrpc: "2.0", id: 1, result: {} });
	const result = await run(["doctor", "agents", "--json"], ok);
	const report = JSON.parse(result.output.out);
	const cursor = report.agents.find(
		(entry: { id: string }) => entry.id === "cursor"
	);
	expect(cursor.status).toBe("other-node");
	expect(cursor.fix).toBe("ryu-cli connect cursor --force");
});

// ── Regressions found in adversarial review ────────────────────────────────────

describe("review regressions", () => {
	test('a ryu table followed by Codex\'s own quoted [projects."/path"] table is still editable', () => {
		const codex = agent("codex");
		const text = [
			"[mcp_servers.ryu]",
			'url = "http://old/mcp/ryu"',
			"",
			'[projects."/Users/me/my proj ü"]',
			'trust_level = "trusted"',
			"",
		].join("\n");
		const next = writeEntry(codex, text, inlineEntry("codex"));
		expect(readEntry(codex, next)).toEqual(inlineEntry("codex"));
		expect(next).toContain('[projects."/Users/me/my proj ü"]\ntrust_level');
		expect(removeEntry(codex, next, false)).toBe(
			'[projects."/Users/me/my proj ü"]\ntrust_level = "trusted"\n'
		);
	});

	test("CRLF JSON stays CRLF", () => {
		const next = writeEntry(
			agent("cursor"),
			'{\r\n  "a": 1\r\n}\r\n',
			inlineEntry("cursor")
		);
		expect(next).not.toMatch(/[^\r]\n/);
		expect(JSON.parse(next).a).toBe(1);
	});

	test("a config that is not valid UTF-8 is never rewritten", async () => {
		const bytes = Buffer.concat([
			Buffer.from("# caf"),
			Buffer.from([0xe9]),
			Buffer.from('\nmodel = "x"\n'),
		]);
		const path = join(home, ".codex", "config.toml");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, bytes);
		const result = await run(["connect", "codex"]);
		expect(result.code).toBe(1);
		expect(result.output.err).toContain("UTF-8");
		expect(readFileSync(path).equals(bytes)).toBe(true);
	});

	test("a dangling symlinked config is written through, keeping the link", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { lstatSync, symlinkSync } = await import("node:fs");
		const real = join(home, "dotfiles", "settings.json");
		mkdirSync(dirname(real), { recursive: true });
		mkdirSync(join(home, ".gemini"));
		const link = join(home, ".gemini", "settings.json");
		symlinkSync(real, link);
		expect((await run(["connect", "gemini"])).code).toBe(0);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(real, "utf8")).mcpServers.ryu).toEqual(
			inlineEntry("gemini")
		);
		expect((await run(["disconnect", "gemini"])).code).toBe(0);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(existsSync(real)).toBe(false);
	});

	test("the uneditable-config fallback never prints the token unless --print", async () => {
		writeHomeFile(".claude.json", "{ // mine\n}");
		for (const argv of [
			["connect", "claude-code", "--dry-run"],
			["connect", "claude-code"],
			["connect", "claude-code", "--json"],
		]) {
			const result = await run(argv);
			expect(result.code).toBe(1);
			expect(result.output.out).not.toContain(TOKEN);
			expect(result.output.err).not.toContain(TOKEN);
		}
	});

	test("disconnect ignores a created-file marker recorded for another path", async () => {
		const claudeDir = join(home, "claude-alt");
		await run(["connect", "claude-code"]);
		// The user moves Claude Code's config and pastes the same entry there.
		const moved = join(claudeDir, ".claude.json");
		mkdirSync(claudeDir);
		writeFileSync(moved, readFileSync(join(home, ".claude.json"), "utf8"));
		env.CLAUDE_CONFIG_DIR = claudeDir;
		expect((await run(["disconnect", "claude-code"])).code).toBe(0);
		expect(existsSync(moved)).toBe(true);
		expect(JSON.parse(readFileSync(moved, "utf8"))).toEqual({
			mcpServers: {},
		});
	});

	test("doctor agents flags an entry without an Authorization header as broken", async () => {
		writeHomeFile(
			".cursor/mcp.json",
			JSON.stringify({ mcpServers: { ryu: { url: MCP_URL } } })
		);
		const seen: string[] = [];
		const ok = mcpFetch(200, { jsonrpc: "2.0", id: 1, result: {} }, seen);
		const result = await run(["doctor", "agents", "--json"], ok);
		expect(result.code).toBe(1);
		const cursor = JSON.parse(result.output.out).agents.find(
			(entry: { id: string }) => entry.id === "cursor"
		);
		expect(cursor.status).toBe("broken");
		expect(cursor.fix).toBe("ryu-cli connect cursor --force");
	});

	test("doctor agents reads commented JSONC configs instead of failing them", async () => {
		writeHomeFile(
			".config/opencode/opencode.jsonc",
			'{\n  // my settings\n  "theme": "x", /* block */\n  "mcp": {},\n}\n'
		);
		writeHomeFile(
			".gemini/settings.json",
			`{\n  // pinned\n  "mcpServers": { "ryu": { "httpUrl": "${MCP_URL}", "headers": { "Authorization": "Bearer ${TOKEN}" } } }\n}\n`
		);
		const ok = mcpFetch(200, { jsonrpc: "2.0", id: 1, result: {} });
		const result = await run(["doctor", "agents", "--json"], ok);
		expect(result.code).toBe(0);
		const byId = new Map(
			JSON.parse(result.output.out).agents.map(
				(entry: { id: string; status: string }) => [entry.id, entry.status]
			)
		);
		expect(byId.get("opencode")).toBe("not-connected");
		expect(byId.get("gemini")).toBe("connected");
	});
});
