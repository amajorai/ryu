// Dispatch tests for `ryu migrate …`. Core is faked through `CoreApi.call`, so
// nothing touches a node. The scan/import contract under test is Core's
// `POST /api/import/scan` → `POST /api/import/run`.

import { expect, test } from "bun:test";
import { runCli } from "../cli/dispatch.ts";
import { credentialDotenv, parseMigrateArgs } from "../cli/migrate.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";

function makeIo() {
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
	return { err: () => err, io, out: () => out };
}

function stubApi(call: CoreApi["call"]): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected Core API call"));
	return {
		call,
		disableApp: notCalled,
		enableApp: notCalled,
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: notCalled,
		streamChat: notCalled,
	};
}

interface Call {
	body: unknown;
	path: string;
}

const openclawScan = {
	root: "/home/sam/.openclaw",
	source: "openclaw",
	items: [
		{
			kind: "agent",
			id: "agent/workspace/SOUL.md",
			title: "OpenClaw agent 'Clawd'",
		},
		{
			kind: "memory",
			id: "memory/workspace/MEMORY.md",
			title: "OpenClaw memory MEMORY.md (2 entries)",
		},
		{
			kind: "mcp_server",
			id: "mcp_server/mcp/openclaw/docs",
			title: "MCP server 'docs'",
		},
		{
			kind: "skill",
			id: "skill/workspace/skills/deploy",
			title: "Skill 'deploy'",
			already_exists: true,
		},
	],
	warnings: [
		"Channels configured in OpenClaw (telegram) are not imported; reconnect them in Ryu Channels.",
	],
};

function fakeNode(calls: Call[], missing: string[] = []): CoreApi {
	return stubApi((_target, path, options) => {
		calls.push({ path, body: options?.body });
		const body = options?.body as { path?: string; items?: unknown[] };
		if (path === "/api/import/scan") {
			if (body.path && missing.includes(body.path)) {
				return Promise.reject(
					new Error(`cannot resolve folder ${body.path}: No such file`)
				);
			}
			return Promise.resolve(openclawScan);
		}
		if (path === "/api/import/run") {
			return Promise.resolve({
				root: openclawScan.root,
				results: (body.items as { kind: string; id: string }[]).map((item) => ({
					...item,
					title: item.id,
					status: "imported",
				})),
			});
		}
		return Promise.reject(new Error(`unexpected path ${path}`));
	});
}

test("parseMigrateArgs: source, path, kinds, and confirmation flags", () => {
	expect(
		parseMigrateArgs([
			"hermes",
			"/backup/.hermes",
			"--only",
			"skills,mcp",
			"--yes",
			"--secrets",
		])
	).toEqual({
		source: "hermes",
		path: "/backup/.hermes",
		only: ["skill", "mcp_server"],
		yes: true,
		secrets: true,
	});
	expect(parseMigrateArgs(["./my-agent"]).path).toBe("./my-agent");
	expect(parseMigrateArgs(["langgraph", "--path=."]).source).toBe("langchain");
	expect(() => parseMigrateArgs(["openclaw", "--only", "bogus"])).toThrow(
		/Unknown kind/
	);
});

test("migrate openclaw --dry-run: scans the first existing default and changes nothing", async () => {
	const cap = makeIo();
	const calls: Call[] = [];
	const code = await runCli(["migrate", "openclaw", "--dry-run"], {
		io: cap.io,
		api: fakeNode(calls, ["~/.openclaw"]),
	});
	expect(code).toBe(0);
	expect(calls.map((c) => c.path)).toEqual([
		"/api/import/scan",
		"/api/import/scan",
	]);
	expect(calls[1]?.body).toEqual({ path: "~/.clawdbot" });
	expect(cap.out()).toContain("Found OpenClaw setup at /home/sam/.openclaw");
	expect(cap.out()).toContain("+ OpenClaw agent 'Clawd'");
	expect(cap.out()).toContain("= Skill 'deploy'  (already in Ryu)");
	expect(cap.out()).toContain("! Channels configured in OpenClaw");
	expect(cap.out()).toContain("3 item(s) would be imported");
});

test("migrate openclaw --yes --only: imports only the selected new kinds", async () => {
	const cap = makeIo();
	const calls: Call[] = [];
	const code = await runCli(
		["migrate", "openclaw", "--yes", "--only", "agent,memory"],
		{ io: cap.io, api: fakeNode(calls) }
	);
	expect(code).toBe(0);
	const run = calls.find((c) => c.path === "/api/import/run");
	expect(run?.body).toEqual({
		path: "/home/sam/.openclaw",
		items: [
			{ kind: "agent", id: "agent/workspace/SOUL.md" },
			{ kind: "memory", id: "memory/workspace/MEMORY.md" },
		],
	});
	expect(cap.out()).toContain("Migration complete: 2 imported");
	expect(cap.out()).toContain("Next steps:");
});

test("migrate --yes --json --secrets prints one JSON document", async () => {
	const cap = makeIo();
	const calls: Call[] = [];
	const code = await runCli(
		["migrate", "openclaw", "--yes", "--json", "--secrets", "--only", "agent"],
		{ io: cap.io, api: fakeNode(calls) }
	);
	expect(code).toBe(0);
	// The fake source root has no .env on this machine.
	const result = JSON.parse(cap.out()) as {
		results: { status: string }[];
		secrets: { created: number; message: string; names: string[] };
	};
	expect(result.results).toHaveLength(1);
	expect(result.secrets.created).toBe(0);
	expect(result.secrets.names).toEqual([]);
	expect(result.secrets.message).toContain("No readable");
	expect(cap.out()).not.toContain("Next steps:");
});

test("migrate without --yes in a non-interactive shell refuses to write", async () => {
	const cap = makeIo();
	const calls: Call[] = [];
	const code = await runCli(["migrate", "openclaw"], {
		io: cap.io,
		api: fakeNode(calls),
	});
	expect(code).toBe(2);
	expect(calls.some((c) => c.path === "/api/import/run")).toBe(false);
});

test("migrate dots without a folder explains the manual path", async () => {
	const cap = makeIo();
	const calls: Call[] = [];
	const code = await runCli(["migrate", "dots"], {
		io: cap.io,
		api: fakeNode(calls),
	});
	expect(code).toBe(2);
	expect(calls).toEqual([]);
	expect(cap.err()).toContain("no setup export");
});

test("migrate claude imports a Claude export's chats and projects", async () => {
	const cap = makeIo();
	const calls: Call[] = [];
	const api = stubApi((_target, path, options) => {
		calls.push({ path, body: options?.body });
		if (path === "/api/import/scan") {
			return Promise.resolve({
				root: "/home/sam/claude-export",
				source: "claude-ai",
				items: [
					{
						kind: "conversations",
						id: "conversations/conversations.json#chats",
						title: "Claude chats (214)",
					},
					{
						kind: "conversations",
						id: "conversations/conversations.json#proj-1",
						title: "Claude project 'Research'",
					},
					{
						kind: "memory",
						id: "memory/memories.json#saved-context",
						title: "Claude memory",
					},
				],
				warnings: [],
			});
		}
		const body = options?.body as { items: { kind: string; id: string }[] };
		return Promise.resolve({
			results: body.items.map((item) => ({
				...item,
				status: "imported",
				title: item.id,
			})),
		});
	});
	const code = await runCli(
		[
			"migrate",
			"claude",
			"/home/sam/claude-export",
			"--yes",
			"--only",
			"chats",
		],
		{ io: cap.io, api }
	);
	expect(code).toBe(0);
	expect(cap.err()).not.toContain("looks like");
	const run = calls.find((c) => c.path === "/api/import/run");
	expect(run?.body).toEqual({
		path: "/home/sam/claude-export",
		items: [
			{ kind: "conversations", id: "conversations/conversations.json#chats" },
			{ kind: "conversations", id: "conversations/conversations.json#proj-1" },
		],
	});
});

test("migrate chatgpt without a folder explains how to export", async () => {
	const cap = makeIo();
	const code = await runCli(["migrate", "chatgpt"], {
		io: cap.io,
		api: fakeNode([]),
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Data controls → Export data");
});

test("migrate reports a missing source folder", async () => {
	const cap = makeIo();
	const code = await runCli(["migrate", "hermes"], {
		io: cap.io,
		api: fakeNode([], ["~/.hermes"]),
	});
	expect(code).toBe(1);
	expect(cap.err()).toContain("No Hermes folder found at ~/.hermes");
});

test("credentialDotenv keeps only credential-looking keys", () => {
	const { content, names } = credentialDotenv(
		"# comment\nexport OPENAI_API_KEY=sk-1\nTELEGRAM_BOT_TOKEN='1:x'\nLOG_LEVEL=debug\nEMPTY_TOKEN=\n"
	);
	expect(names).toEqual(["OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN"]);
	expect(content).toBe("OPENAI_API_KEY=sk-1\nTELEGRAM_BOT_TOKEN='1:x'\n");
});
