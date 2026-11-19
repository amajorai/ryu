// Plain `ryu-cli secrets run` (no `--broker`) refuses commands that print
// their environment, before any value is exported or lease issued, unless
// `--allow-env-dump` is given. Core is faked through the target's `fetch`.

import { expect, test } from "bun:test";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import {
	ALLOW_ENV_DUMP_FLAG,
	refusePlainEnvDump,
} from "../cli/secrets-run-dump-guard.ts";
import {
	credential,
	fakeNode,
	json,
	jsonExport,
	runSecrets,
} from "./secrets-fixture.ts";

function valueNode() {
	return fakeNode({
		"POST /api/vault/export": json(jsonExport({ API_KEY: "s3cret" })),
		"POST /api/vault/dynamic/issue/db": json(
			credential("vl_1", { password: "p1" })
		),
	});
}

const DUMPS = [
	["printenv"],
	["env"],
	["set"],
	["export", "-p"],
	["bash", "-c", "env | sort"],
	["nohup", "printenv", "API_KEY"],
];

for (const command of DUMPS) {
	test(`run refuses '${command.join(" ")}' before anything is exported`, async () => {
		const node = valueNode();
		let spawned = false;
		const result = await runSecrets(
			["run", "--no-project", "--lease", "db", "--", ...command],
			node,
			{
				spawn: () => {
					spawned = true;
					return Promise.resolve(0);
				},
			}
		);
		expect(result.code).toBe(1);
		expect(spawned).toBe(false);
		expect(node.calls).toEqual([]);
		expect(result.err).toContain("prints its environment");
		expect(result.err).toContain("--allow-env-dump");
	});
}

test("run --watch refuses an env dump before subscribing", async () => {
	const node = valueNode();
	const result = await runSecrets(
		["run", "--no-project", "--watch", "--", "printenv"],
		node
	);
	expect(result.code).toBe(1);
	expect(node.calls).toEqual([]);
});

test("--allow-env-dump lets a person run the dump on purpose", async () => {
	const node = valueNode();
	let childEnv: Record<string, string> = {};
	const result = await runSecrets(
		["run", "--no-project", "--allow-env-dump", "--", "printenv"],
		node,
		{
			spawn: (_command, env) => {
				childEnv = env;
				return Promise.resolve(0);
			},
		}
	);
	expect(result.code).toBe(0);
	expect(childEnv.API_KEY).toBe("s3cret");
});

test("ordinary commands and interactive shells still run", async () => {
	for (const command of [["bash"], ["node", "server.js"], ["env", "node"]]) {
		const node = valueNode();
		let spawned: string[] = [];
		const result = await runSecrets(
			["run", "--no-project", "--", ...command],
			node,
			{
				spawn: (cmd) => {
					spawned = cmd;
					return Promise.resolve(0);
				},
			}
		);
		expect(result.code).toBe(0);
		expect(spawned).toEqual(command);
	}
});

test("--allow-env-dump does not lift the AI agent guard", async () => {
	const node = valueNode();
	let spawned = false;
	const result = await runSecrets(
		["run", "--no-project", "--allow-env-dump", "--", "printenv"],
		node,
		{
			env: { HOME: "/home/me", CLAUDECODE: "1" },
			spawn: () => {
				spawned = true;
				return Promise.resolve(0);
			},
		}
	);
	expect(result.code).toBe(1);
	expect(spawned).toBe(false);
	expect(result.err).toContain("AI agent session");
});

test("the guard function names the escape flag and ignores other commands", () => {
	let err = "";
	const io = {
		io: { out: () => undefined, err: (text: string) => (err += text) },
	};
	expect(refusePlainEnvDump(io, parseSecretsArgs(["run"]), ["printenv"])).toBe(
		1
	);
	expect(err).toContain(ALLOW_ENV_DUMP_FLAG);
	expect(
		refusePlainEnvDump(io, parseSecretsArgs(["run", ALLOW_ENV_DUMP_FLAG]), [
			"printenv",
		])
	).toBeNull();
	expect(
		refusePlainEnvDump(io, parseSecretsArgs(["run"]), ["ls", "-la"])
	).toBeNull();
});
