// `ryu disconnect <agent>` edge cases the round-trip tests in
// cli.agentConnect.test.ts do not reach: `--dry-run` must leave both the agent
// config and the connect-state record untouched, and an entry that is already
// gone must drop a stale state record (live) or keep it (dry run). Runs against
// a temp HOME + temp state dir; no real agent config or network is touched.

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, FetchLike } from "../cli/types.ts";

const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "ryu_test" };
const failingFetch: FetchLike = () =>
	Promise.reject(new Error("no network in tests"));

let home = "";
let env: Record<string, string | undefined> = {};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ryu-agent-disconnect-"));
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

async function run(argv: string[]) {
	const output = { out: "", err: "" };
	const io: CliIO = {
		out: (s) => {
			output.out += s;
		},
		err: (s) => {
			output.err += s;
		},
	};
	const code = await runCli(argv, { env, fetch: failingFetch, io, target });
	return { code, output };
}

const statePath = () => join(home, "state", "agent-connect.json");
const cursorPath = () => join(home, ".cursor", "mcp.json");

function stateAgents(): Record<string, unknown> {
	return JSON.parse(readFileSync(statePath(), "utf8")).agents;
}

test("disconnect --dry-run leaves an edited config and its record untouched", async () => {
	mkdirSync(join(home, ".cursor"));
	writeFileSync(
		cursorPath(),
		'{\n  "mcpServers": {\n    "git": { "command": "mcp-git" }\n  }\n}\n'
	);
	expect((await run(["connect", "cursor"])).code).toBe(0);
	const configBefore = readFileSync(cursorPath());
	const stateBefore = readFileSync(statePath());
	expect(stateAgents().cursor).toBeDefined();

	const dry = await run(["disconnect", "cursor", "--dry-run", "--json"]);
	expect(dry.code).toBe(0);
	expect(JSON.parse(dry.output.out)).toEqual({
		action: "remove",
		agent: "cursor",
		configPath: cursorPath(),
		dryRun: true,
	});
	expect(readFileSync(cursorPath()).equals(configBefore)).toBe(true);
	expect(readFileSync(statePath()).equals(stateBefore)).toBe(true);

	// The live run afterwards still does the removal the preview described.
	const live = await run(["disconnect", "cursor", "--json"]);
	expect(JSON.parse(live.output.out).action).toBe("remove");
	expect(JSON.parse(readFileSync(cursorPath(), "utf8")).mcpServers.ryu).toBe(
		undefined
	);
	expect(stateAgents().cursor).toBeUndefined();
});

test("disconnect --dry-run of a file Ryu created reports delete-file and keeps it", async () => {
	expect((await run(["connect", "cursor"])).code).toBe(0);
	const configBefore = readFileSync(cursorPath());
	const stateBefore = readFileSync(statePath());

	const dry = await run(["disconnect", "cursor", "--dry-run", "--json"]);
	expect(dry.code).toBe(0);
	const report = JSON.parse(dry.output.out);
	expect(report.action).toBe("delete-file");
	expect(report.dryRun).toBe(true);
	expect(existsSync(cursorPath())).toBe(true);
	expect(readFileSync(cursorPath()).equals(configBefore)).toBe(true);
	expect(readFileSync(statePath()).equals(stateBefore)).toBe(true);

	const human = await run(["disconnect", "cursor", "--dry-run"]);
	expect(human.output.out).toContain("would delete");
	expect(existsSync(cursorPath())).toBe(true);
});

test("an entry removed by hand: live disconnect drops the stale record, dry run keeps it", async () => {
	expect((await run(["connect", "cursor"])).code).toBe(0);
	expect((await run(["connect", "codex"])).code).toBe(0);
	// The user deletes the ryu entry themselves; the state record is now stale.
	writeFileSync(cursorPath(), '{"mcpServers":{}}\n');

	const dry = await run(["disconnect", "cursor", "--dry-run", "--json"]);
	expect(dry.code).toBe(0);
	expect(JSON.parse(dry.output.out).action).toBe("absent");
	expect(stateAgents().cursor).toBeDefined();

	const live = await run(["disconnect", "cursor", "--json"]);
	expect(live.code).toBe(0);
	expect(JSON.parse(live.output.out)).toEqual({
		action: "absent",
		agent: "cursor",
		configPath: cursorPath(),
	});
	const agents = stateAgents();
	expect(agents.cursor).toBeUndefined();
	// Only the named agent's record is dropped.
	expect(agents.codex).toBeDefined();
	expect(readFileSync(cursorPath(), "utf8")).toBe('{"mcpServers":{}}\n');
});

test("disconnect with no config and no record reports absent and writes no state", async () => {
	const result = await run(["disconnect", "cursor"]);
	expect(result.code).toBe(0);
	expect(result.output.out).toContain("has no Ryu MCP entry");
	expect(existsSync(statePath())).toBe(false);
	expect(existsSync(cursorPath())).toBe(false);
});
