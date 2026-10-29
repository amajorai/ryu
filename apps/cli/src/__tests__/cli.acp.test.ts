// Dispatch tests for `ryu acp`: it must launch `ryu-core acp` with inherited
// stdio and forward only the flags it owns, writing nothing to stdout itself
// (stdout carries the editor's protocol frames). Child processes are faked.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, ProcessRunner } from "../cli/types.ts";

interface Spawned {
	cmd: string[];
	env: Record<string, string>;
}

let dir = "";
let savedCoreBin: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-acp-cli-"));
	savedCoreBin = process.env.RYU_CORE_BIN;
});

afterEach(async () => {
	if (savedCoreBin === undefined) {
		Reflect.deleteProperty(process.env, "RYU_CORE_BIN");
	} else {
		process.env.RYU_CORE_BIN = savedCoreBin;
	}
	await rm(dir, { recursive: true, force: true });
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

function fakeSpawn(calls: Spawned[], code = 0): ProcessRunner {
	return (cmd, env) => {
		calls.push({ cmd, env });
		return Promise.resolve(code);
	};
}

test("ryu acp launches ryu-core acp with the agent and node flags", async () => {
	const coreBin = join(dir, "ryu-core");
	await writeFile(coreBin, "");
	process.env.RYU_CORE_BIN = coreBin;
	const calls: Spawned[] = [];
	const { io, output } = capture();

	const code = await runCli(
		["acp", "--agent", "coder", "--node", "http://127.0.0.1:9999"],
		{
			io,
			env: { RYU_CORE_TOKEN: "tok", UNSET: undefined },
			// An unsaved --node URL resolves to the env token (core/nodeTarget.ts).
			target: { url: "http://127.0.0.1:9999", token: "tok" },
			spawn: fakeSpawn(calls, 0),
		}
	);

	expect(code).toBe(0);
	expect(output.out).toBe("");
	expect(calls).toHaveLength(1);
	expect(calls[0]?.cmd).toEqual([
		coreBin,
		"acp",
		"--agent",
		"coder",
		"--core-url",
		"http://127.0.0.1:9999",
	]);
	expect(calls[0]?.env).toEqual({ RYU_CORE_TOKEN: "tok" });
});

test("ryu acp without flags lets ryu-core resolve the local node", async () => {
	const coreBin = join(dir, "ryu-core");
	await writeFile(coreBin, "");
	process.env.RYU_CORE_BIN = coreBin;
	const calls: Spawned[] = [];
	const { io } = capture();

	const code = await runCli(["acp"], {
		io,
		env: {},
		spawn: fakeSpawn(calls, 3),
	});

	expect(code).toBe(3);
	expect(calls[0]?.cmd).toEqual([coreBin, "acp"]);
});

test("ryu acp targets a remote active node without leaking another node's env token", async () => {
	const coreBin = join(dir, "ryu-core");
	await writeFile(coreBin, "");
	process.env.RYU_CORE_BIN = coreBin;
	const calls: Spawned[] = [];
	const { io } = capture();

	const code = await runCli(["acp"], {
		io,
		env: { RYU_CORE_TOKEN: "local-only" },
		target: { url: "https://prod.example.test", token: null },
		spawn: fakeSpawn(calls, 0),
	});

	expect(code).toBe(0);
	expect(calls[0]?.cmd).toEqual([
		coreBin,
		"acp",
		"--core-url",
		"https://prod.example.test",
	]);
	expect(calls[0]?.env).toEqual({});
});

test("ryu acp passes a remote active node's saved token by env, never argv", async () => {
	const coreBin = join(dir, "ryu-core");
	await writeFile(coreBin, "");
	process.env.RYU_CORE_BIN = coreBin;
	const calls: Spawned[] = [];
	const { io } = capture();

	await runCli(["acp"], {
		io,
		env: {},
		target: { url: "https://prod.example.test", token: "prod-secret" },
		spawn: fakeSpawn(calls, 0),
	});

	expect(calls[0]?.cmd).not.toContain("prod-secret");
	expect(calls[0]?.env).toEqual({ RYU_CORE_TOKEN: "prod-secret" });
});

test("ryu acp leaves RYU_CORE_URL resolution to ryu-core", async () => {
	const coreBin = join(dir, "ryu-core");
	await writeFile(coreBin, "");
	process.env.RYU_CORE_BIN = coreBin;
	const calls: Spawned[] = [];
	const { io } = capture();

	await runCli(["acp"], {
		io,
		env: { RYU_CORE_URL: "http://env-node.example.test:7980" },
		target: { url: "http://env-node.example.test:7980", token: null },
		spawn: fakeSpawn(calls, 0),
	});

	expect(calls[0]?.cmd).toEqual([coreBin, "acp"]);
	expect(calls[0]?.env).toEqual({
		RYU_CORE_URL: "http://env-node.example.test:7980",
	});
});
