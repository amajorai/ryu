// The ways around value-type redaction in AI agent sessions stay closed: a
// metadata-only re-type to config, a rollback to a version written as a
// secret, a listing missing its Team and Organization rows, and a `get`
// whose environment holds a row the listing does not show.

import { expect, test } from "bun:test";
import { agentConfigEnvironment } from "../cli/secrets-agent-redaction.ts";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import type { CliContext } from "../cli/types.ts";
import {
	exportBody,
	fakeNode,
	listing,
	routesOf,
	row,
	run,
} from "./agent-redaction-fixture.ts";

test("set --type config with no value is refused in an agent session", async () => {
	const node = fakeNode({
		"PUT /api/vault/secrets/API_KEY": () =>
			Response.json({ ok: true, secret: row({ name: "API_KEY" }) }),
	});
	// An agent shell: stdin is not a terminal and is empty.
	for (const stdin of ["", null]) {
		const retype = await run(
			["secrets", "set", "API_KEY", "--type", "config"],
			node,
			{ stdin }
		);
		expect(retype.code).toBe(1);
		expect(retype.err).toContain("without a new value");
	}
	expect(node.calls).toEqual([]);

	// A new value in the same call replaces the stored plaintext, so it is allowed.
	const withValue = await run(
		["secrets", "set", "API_KEY", "https://api.test", "--type", "config"],
		node
	);
	expect(withValue.code).toBe(0);
	const piped = await run(
		["secrets", "set", "API_KEY", "--type", "config"],
		node,
		{
			stdin: "https://api.test\n",
		}
	);
	expect(piped.code).toBe(0);
	expect(node.calls.map((call) => JSON.parse(call.body).value)).toEqual([
		"https://api.test",
		"https://api.test",
	]);

	// Tightening the type, or a person outside an agent session, still works.
	const tighten = await run(
		["secrets", "set", "API_KEY", "--type", "secret"],
		node,
		{ stdin: "" }
	);
	expect(tighten.code).toBe(0);
	const human = await run(
		["secrets", "set", "API_KEY", "--type", "config"],
		node,
		{ env: { HOME: "/home/me" }, stdin: "" }
	);
	expect(human.code).toBe(0);
	expect(node.calls).toHaveLength(4);
});

test("rollback is refused in an agent session, so get cannot print an older secret", async () => {
	const node = fakeNode({
		"POST /api/vault/secrets/API_URL/rollback": () =>
			Response.json({ ok: true, secret: row({ name: "API_URL" }) }),
		"GET /api/vault/secrets": () =>
			Response.json(
				listing([
					{ name: "API_URL", valueType: "config", environment: "default" },
				])
			),
		"POST /api/vault/secrets/API_URL/reveal": () =>
			Response.json({ value: "written-as-secret" }),
	});
	const rolled = await run(["secrets", "rollback", "API_URL", "1"], node);
	expect(rolled.code).toBe(1);
	expect(rolled.err).toContain("Refusing to roll back");
	expect(routesOf(node)).toEqual([]);

	const human = await run(["secrets", "rollback", "API_URL", "1"], node, {
		env: { HOME: "/home/me" },
	});
	expect(human.code).toBe(0);
	expect(routesOf(node)).toEqual(["POST /api/vault/secrets/API_URL/rollback"]);
});

test("a listing without its shared rows refuses get and export and adds nothing to a run", async () => {
	const rows = [
		{ name: "N", valueType: "config", environment: "default" },
		{ name: "LOG_LEVEL", valueType: "config", environment: "default" },
	];
	const node = fakeNode({
		"GET /api/vault/secrets": () =>
			Response.json(listing(rows, "control plane unreachable")),
		"POST /api/vault/secrets/N/reveal": () =>
			Response.json({ value: "team-secret" }),
		"POST /api/vault/export": () =>
			Response.json(exportBody({ N: "team-secret" })),
	});
	const get = await run(["secrets", "get", "N"], node);
	expect(get.code).toBe(1);
	expect(get.err).toContain("could not be checked");
	const exported = await run(["secrets", "export", "--env", "prod"], node);
	expect(exported.code).toBe(1);
	expect(`${get.out}${exported.out}${exported.err}`).not.toContain(
		"team-secret"
	);
	expect(
		routesOf(node).filter((route) => route !== "GET /api/vault/secrets")
	).toEqual([]);

	let err = "";
	const ctx = {
		env: {},
		io: {
			out: () => undefined,
			err: (text: string) => {
				err += text;
			},
		},
		target: node.target,
	} as unknown as CliContext;
	const env = await agentConfigEnvironment(
		ctx,
		parseSecretsArgs(["run", "--", "npm", "test"])
	);
	expect(env).toEqual({});
	expect(err).toContain("Could not list value types");
});

test("get without --env checks Core's default environment, not a config row elsewhere", async () => {
	// The listing hides the secret row in `default` (no list grant there); a
	// config row of the same name in `dev` must not let the reveal through.
	const node = fakeNode({
		"GET /api/vault/secrets": () =>
			Response.json(
				listing([{ name: "API_KEY", valueType: "config", environment: "dev" }])
			),
		"POST /api/vault/secrets/API_KEY/reveal": () =>
			Response.json({ value: "hidden-secret" }),
	});
	const refused = await run(["secrets", "get", "API_KEY"], node);
	expect(refused.code).toBe(1);
	expect(refused.out).toBe("");
	expect(routesOf(node)).toEqual(["GET /api/vault/secrets"]);

	const pinned = await run(["secrets", "get", "API_KEY", "--env", "dev"], node);
	expect(pinned.code).toBe(0);
	expect(pinned.out).toBe("hidden-secret\n");
});
