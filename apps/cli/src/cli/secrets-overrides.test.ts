// Direct tests of `overrides` (the routed command is covered end to end in
// `__tests__/cli.secrets.overrides.test.ts`).

import { expect, test } from "bun:test";
import { fakeNode } from "../__tests__/secrets-fixture.ts";
import type { SecretsArgs } from "./secrets-args.ts";
import { overrides } from "./secrets-overrides.ts";
import { type CliContext, UsageError } from "./types.ts";

const ROUTE = "/api/vault/personal-overrides";

function harness(json: boolean) {
	let enabled = true;
	const node = fakeNode({
		[`GET ${ROUTE}`]: () => Response.json({ enabled, userId: "user-1" }),
		[`PUT ${ROUTE}`]: (call) => {
			enabled = (JSON.parse(call.body) as { enabled: boolean }).enabled;
			return Response.json({ enabled, userId: "user-1" });
		},
	});
	let out = "";
	const ctx = {
		flags: { json },
		io: {
			err: () => undefined,
			out: (text: string) => {
				out += text;
			},
		},
		target: node.target,
	} as unknown as CliContext;
	const run = (positional: string[]) =>
		overrides(ctx, { positional } as unknown as SecretsArgs);
	return { output: () => out, run };
}

test("off switches the setting and --json prints Core's answer", async () => {
	const { output, run } = harness(true);
	expect(await run(["overrides", "off"])).toBe(0);
	expect(JSON.parse(output())).toEqual({ enabled: false, userId: "user-1" });
});

test("an unknown action is a usage error", async () => {
	const { run } = harness(false);
	await expect(run(["overrides", "maybe"])).rejects.toBeInstanceOf(UsageError);
});
