// `ryu secrets agent` command wiring: config file errors stop it before any
// request.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommand } from "../cli/secrets-agentd.ts";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import type { CliContext } from "../cli/types.ts";
import { fakeNode } from "./secrets-fixture.ts";

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-agentd-command-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function context() {
	const node = fakeNode({});
	const ctx = {
		cwd: dir,
		env: {},
		io: { out: () => undefined, err: () => undefined },
		spawn: () => Promise.resolve(0),
		target: node.target,
	} as unknown as CliContext;
	return { ctx, node };
}

test("a missing config file is a usage error naming it", async () => {
	const { ctx, node } = context();
	await expect(
		agentCommand(ctx, parseSecretsArgs(["agent", "--config", "nope.json"]))
	).rejects.toThrow(`Cannot read ${join(dir, "nope.json")}.`);
	expect(node.calls).toEqual([]);
});

test("a config with nothing to do is refused before logging in", async () => {
	await writeFile(
		join(dir, "agent.json"),
		JSON.stringify({ version: 1, auth: { method: "env" } })
	);
	const { ctx, node } = context();
	await expect(
		agentCommand(ctx, parseSecretsArgs(["agent", "--config", "agent.json"]))
	).rejects.toThrow("has no templates and no sinks");
	expect(node.calls).toEqual([]);
});

test("extra positional arguments are a usage error", async () => {
	const { ctx } = context();
	await expect(
		agentCommand(
			ctx,
			parseSecretsArgs(["agent", "run", "--config", "agent.json"])
		)
	).rejects.toThrow("secrets agent --config FILE");
});
