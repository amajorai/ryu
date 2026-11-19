// `ryu-cli secrets shell`: starts the caller's shell with the run
// environment, revokes leases when it exits, and refuses the flags and
// sessions an interactive shell cannot serve. Core is faked through the
// target's `fetch`; the shell is the `spawn` stub.

import { expect, test } from "bun:test";
import { interactiveShell } from "../cli/secrets-shell.ts";
import type { ProcessRunner } from "../cli/types.ts";
import {
	fakeNode,
	json,
	jsonExport,
	lease,
	runSecrets,
} from "./secrets-fixture.ts";

function recorder() {
	const runs: { command: string[]; env: Record<string, string> }[] = [];
	const spawn: ProcessRunner = (command, env) => {
		runs.push({ command, env });
		return Promise.resolve(7);
	};
	return { runs, spawn };
}

test("the shell is $SHELL, then /bin/sh; %COMSPEC% or cmd.exe on Windows", () => {
	expect(interactiveShell({ SHELL: "/usr/bin/zsh" }, "linux")).toBe(
		"/usr/bin/zsh"
	);
	expect(interactiveShell({ SHELL: " " }, "darwin")).toBe("/bin/sh");
	expect(interactiveShell({}, "linux")).toBe("/bin/sh");
	expect(interactiveShell({ COMSPEC: "C:\\pwsh.exe" }, "win32")).toBe(
		"C:\\pwsh.exe"
	);
	expect(interactiveShell({ SHELL: "/bin/bash" }, "win32")).toBe("cmd.exe");
});

test("starts $SHELL with the exported values and returns its exit code", async () => {
	const node = fakeNode({
		"POST /api/vault/export": json(jsonExport({ API_KEY: "k-1" })),
	});
	const { runs, spawn } = recorder();
	const result = await runSecrets(["shell", "--no-project"], node, {
		env: { HOME: "/home/me", SHELL: "/bin/zsh" },
		spawn,
	});
	expect(result.code).toBe(7);
	expect(runs).toHaveLength(1);
	expect(runs[0]?.command).toEqual(["/bin/zsh"]);
	expect(runs[0]?.env.API_KEY).toBe("k-1");
	expect(result.err).toContain("starting /bin/zsh");
	expect(result.err).toContain("vault shell ended");
	expect(result.out).not.toContain("k-1");
	expect(result.err).not.toContain("k-1");
});

test("revokes a --lease credential when the shell exits", async () => {
	const live = {
		...lease("vl_9"),
		expiresAt: Date.now() + 3_600_000,
		maxExpiresAt: Date.now() + 7_200_000,
	};
	const node = fakeNode({
		"POST /api/vault/export": json(jsonExport({})),
		"POST /api/vault/dynamic/issue/db": json({
			credential: { data: { password: "p" }, lease: live },
		}),
		"POST /api/vault/leases/vl_9/revoke": json({
			lease: { ...live, revokedAt: Date.now() },
		}),
	});
	const { runs, spawn } = recorder();
	const result = await runSecrets(
		["shell", "--no-project", "--lease", "db=PG"],
		node,
		{ env: { HOME: "/home/me", SHELL: "/bin/bash" }, spawn }
	);
	expect(result.code).toBe(7);
	expect(runs[0]?.env.PG_PASSWORD).toBe("p");
	expect(node.calls.map((call) => call.route).at(-1)).toBe(
		"POST /api/vault/leases/vl_9/revoke"
	);
});

test("refuses a command, --watch, and --broker before contacting Core", async () => {
	const node = fakeNode({});
	const { runs, spawn } = recorder();
	for (const argv of [
		["shell", "--", "ls"],
		["shell", "--watch"],
		["shell", "--broker", "openai"],
	]) {
		const result = await runSecrets(argv, node, {
			env: { HOME: "/home/me", SHELL: "/bin/sh" },
			spawn,
		});
		expect(result.code).toBe(2);
	}
	expect(runs).toHaveLength(0);
	expect(node.calls).toHaveLength(0);
});

test("refuses in an AI agent session", async () => {
	const node = fakeNode({});
	const { runs, spawn } = recorder();
	const result = await runSecrets(["shell", "--no-project"], node, {
		env: { CLAUDECODE: "1", HOME: "/home/me", SHELL: "/bin/sh" },
		spawn,
	});
	expect(result.code).toBe(1);
	expect(result.err).toContain("Refusing to start an interactive shell");
	expect(runs).toHaveLength(0);
	expect(node.calls).toHaveLength(0);
});
