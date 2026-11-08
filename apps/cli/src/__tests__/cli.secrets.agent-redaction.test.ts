// Value-type redaction in AI agent sessions: `get` and `export` show config
// values only, checking the type before and after reading, and a broker run
// gets the config values in its environment. Core is faked through the
// target's `fetch`.

import { expect, test } from "bun:test";
import {
	agentReadableNames,
	rowsForGet,
} from "../cli/secrets-agent-redaction.ts";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import {
	AGENT_ENV,
	exportBody,
	fakeNode,
	listing,
	routesOf,
	row,
	run,
	T,
} from "./agent-redaction-fixture.ts";

test("agentReadableNames keeps names whose every row is config", () => {
	const rows = [
		row({ name: "LOG_LEVEL", valueType: "config" }),
		row({ name: "LOG_LEVEL", valueType: "config", environment: "prod" }),
		row({ name: "API_URL", valueType: "config" }),
		// A secret row anywhere (another scope, environment, folder) wins.
		row({ name: "API_URL", valueType: "secret", scope: "org" }),
		row({ name: "API_KEY" }),
		row({ name: "SIGNING_KEY", valueType: "sealed" }),
		row({ name: "FUTURE", valueType: "public" }),
	];
	expect([...agentReadableNames(rows)]).toEqual(["LOG_LEVEL"]);
});

test("rowsForGet matches the coordinates a reveal would use", () => {
	const rows = [
		row({ name: "A", valueType: "config" }),
		row({ name: "A", environment: "prod" }),
		row({ name: "A", environment: "default" }),
		row({ name: "A", path: "/svc" }),
		row({ name: "A", scope: "node", scopeId: "n1" }),
	];
	const get = (...argv: string[]) =>
		rowsForGet(rows, "A", parseSecretsArgs(["get", "A", ...argv])).map(
			(found) => `${found.scope}:${found.environment}:${found.path}`
		);
	// No --env: the reveal reads Core's `default` environment, so only that
	// row counts; a config row elsewhere cannot stand in for a hidden one.
	expect(get()).toEqual(["user:default:/"]);
	expect(get("--env", "dev")).toEqual(["user:dev:/"]);
	expect(get("--env", "dev", "--path", "/svc/")).toEqual(["user:dev:/svc"]);
	expect(get("--env", "dev", "--scope", "node")).toEqual(["node:dev:/"]);
});

test("get prints a config value and refuses secret and sealed ones without revealing", async () => {
	const node = fakeNode({
		"GET /api/vault/secrets": () =>
			Response.json(
				listing(
					[
						{ name: "LOG_LEVEL", valueType: "config" },
						{ name: "API_KEY", valueType: "secret" },
						{ name: "LEGACY_KEY" },
						{ name: "SIGNING_KEY", valueType: "sealed" },
					].map((spec) => ({ ...spec, environment: "default" }))
				)
			),
		"POST /api/vault/secrets/LOG_LEVEL/reveal": () =>
			Response.json({ value: "debug" }),
		"POST /api/vault/secrets/API_KEY/reveal": () =>
			Response.json({ value: "sk_live_123" }),
	});
	const config = await run(["secrets", "get", "LOG_LEVEL"], node);
	expect(config).toEqual({ code: 0, err: "", out: "debug\n" });
	expect(routesOf(node)).toEqual([
		"GET /api/vault/secrets",
		"POST /api/vault/secrets/LOG_LEVEL/reveal",
		"GET /api/vault/secrets",
	]);

	for (const name of ["API_KEY", "LEGACY_KEY", "SIGNING_KEY", "MISSING"]) {
		const refused = await run(["secrets", "get", name], node);
		expect({ name, code: refused.code, out: refused.out }).toEqual({
			name,
			code: 1,
			out: "",
		});
		expect(refused.err).toContain("it is not a config value");
		expect(refused.err).not.toContain("sk_live_123");
	}
	expect(routesOf(node).filter((route) => route.endsWith("/reveal"))).toEqual([
		"POST /api/vault/secrets/LOG_LEVEL/reveal",
	]);

	// An earlier version may predate a change to config.
	const version = await run(["secrets", "get", "LOG_LEVEL", "2"], node);
	expect(version.code).toBe(1);
	expect(version.err).toContain("only the current version");
});

test("get refuses when the type changes between the checks or cannot be read", async () => {
	const retyped = fakeNode({
		"GET /api/vault/secrets": [
			() =>
				Response.json(
					listing([
						{ name: "API_URL", valueType: "config", environment: "default" },
					])
				),
			() =>
				Response.json(
					listing([
						{ name: "API_URL", valueType: "secret", environment: "default" },
					])
				),
		],
		"POST /api/vault/secrets/API_URL/reveal": () =>
			Response.json({ value: "rotated-secret" }),
	});
	const changed = await run(["secrets", "get", "API_URL"], retyped);
	expect(changed.code).toBe(1);
	expect(changed.out).toBe("");
	expect(changed.err).not.toContain("rotated-secret");
	expect(changed.err).toContain("could not be checked");

	const unavailable = fakeNode({
		"GET /api/vault/secrets": () =>
			Response.json({ error: "down" }, { status: 503 }),
	});
	const failed = await run(["secrets", "get", "API_URL"], unavailable);
	expect(failed.code).toBe(1);
	expect(routesOf(unavailable)).toEqual(["GET /api/vault/secrets"]);

	// A machine token cannot list types, so nothing is read.
	const machine = fakeNode({});
	const token = await run(["secrets", "get", "API_URL"], machine, {
		env: { ...AGENT_ENV, RYU_VAULT_TOKEN: "rvt_token" },
	});
	expect(token.code).toBe(1);
	expect(machine.calls).toEqual([]);
});

test("export emits only config names and refuses when a type changes", async () => {
	const rows = [
		{ name: "LOG_LEVEL", valueType: "config" },
		{ name: "API_URL", valueType: "config" },
		{ name: "API_KEY", valueType: "secret" },
		{ name: "SIGNING_KEY", valueType: "sealed" },
	];
	const node = fakeNode({
		"GET /api/vault/secrets": () => Response.json(listing(rows)),
		"POST /api/vault/export": () =>
			Response.json(
				exportBody({ API_URL: "https://api.test", LOG_LEVEL: "debug" })
			),
	});
	const result = await run(["secrets", "export", "--format", "json"], node);
	expect(result.code).toBe(0);
	expect(result.out).toContain("LOG_LEVEL");
	expect(result.err).toContain("2 secret or sealed values were left out");
	const exported = node.calls.find(
		(call) => call.route === "POST /api/vault/export"
	);
	expect(JSON.parse(exported?.body ?? "{}")).toMatchObject({
		format: "json",
		names: ["LOG_LEVEL", "API_URL"],
	});

	// --name narrows further; a secret name is left out, not exported.
	const named = fakeNode({
		"GET /api/vault/secrets": () => Response.json(listing(rows)),
		"POST /api/vault/export": () =>
			Response.json(exportBody({ LOG_LEVEL: "debug" })),
	});
	const narrowed = await run(
		["secrets", "export", "--name", "LOG_LEVEL", "--name", "API_KEY"],
		named
	);
	expect(narrowed.code).toBe(0);
	expect(narrowed.err).toContain("1 secret or sealed values were left out");
	expect(
		JSON.parse(named.calls.find((c) => c.route.endsWith("/export"))?.body ?? "")
			.names
	).toEqual(["LOG_LEVEL"]);

	const retyped = fakeNode({
		"GET /api/vault/secrets": [
			() => Response.json(listing(rows)),
			() =>
				Response.json(
					listing([{ name: "LOG_LEVEL", valueType: "secret" }, ...rows])
				),
		],
		"POST /api/vault/export": () =>
			Response.json(exportBody({ LOG_LEVEL: "now-a-secret" })),
	});
	const refused = await run(["secrets", "export"], retyped);
	expect(refused.code).toBe(1);
	expect(refused.out).toBe("");
	expect(refused.err).not.toContain("now-a-secret");
});

test("an agent's broker run gets the config values but never a secret", async () => {
	const proxyUrl = "http://rvb:rvb_session_secret@127.0.0.1:8123";
	const node = fakeNode({
		"GET /api/vault/broker/services": () =>
			Response.json({
				services: [
					{
						name: "github",
						environment: "dev",
						host: "api.github.com",
						pathPrefix: "/",
						enabled: true,
						auth: { kind: "bearer" },
						createdAt: T,
						updatedAt: T,
					},
				],
			}),
		"GET /api/vault/secrets": () =>
			Response.json(
				listing([
					{ name: "LOG_LEVEL", valueType: "config" },
					{ name: "GITHUB_TOKEN", valueType: "secret" },
				])
			),
		"POST /api/vault/export": () =>
			Response.json(exportBody({ LOG_LEVEL: "debug" })),
		"POST /api/vault/broker/sessions": () =>
			Response.json({
				token: "rvb_session_secret",
				session: {
					id: "bs_1",
					environment: "dev",
					services: ["github"],
					label: "ryu secrets run node",
					mintedBy: "user:u1",
					createdAt: T,
					expiresAt: T,
				},
				proxy: {
					url: "http://127.0.0.1:8123",
					port: 8123,
					caPath: "/nonexistent/ryu/ca.pem",
					caBundlePath: "/nonexistent/ryu/ca-bundle.pem",
					caUrl: "/api/vault/broker/ca.pem",
					env: { HTTPS_PROXY: proxyUrl, LOG_LEVEL: "proxy-wins" },
				},
			}),
		"GET /api/vault/broker/ca.pem": () =>
			new Response(
				"-----BEGIN CERTIFICATE-----\nb\n-----END CERTIFICATE-----\n"
			),
		"DELETE /api/vault/broker/sessions/bs_1": () =>
			Response.json({ revoked: true }),
	});
	const children: Record<string, string>[] = [];
	const result = await run(["secrets", "run", "--", "npm", "test"], node, {
		spawn: (_command, env) => {
			children.push(env);
			return Promise.resolve(0);
		},
	});
	expect(result.code).toBe(0);
	expect(result.err).toContain("Added 1 config value to");
	expect(result.err).not.toContain("debug");
	const exported = node.calls.find((call) => call.route.endsWith("/export"));
	expect(JSON.parse(exported?.body ?? "{}").names).toEqual(["LOG_LEVEL"]);
	expect(children[0]?.HTTPS_PROXY).toBe(proxyUrl);
	// The broker's own variables win over a config value of the same name.
	expect(children[0]?.LOG_LEVEL).toBe("proxy-wins");
	expect(children[0]?.GITHUB_TOKEN).toBeUndefined();
});

test("set --type sends the value type and list shows it", async () => {
	const node = fakeNode({
		"PUT /api/vault/secrets/LOG_LEVEL": () =>
			Response.json({ ok: true, secret: row({ name: "LOG_LEVEL" }) }),
		"GET /api/vault/secrets": () =>
			Response.json(
				listing([
					{ name: "LOG_LEVEL", valueType: "config" },
					{ name: "LEGACY_KEY" },
				])
			),
	});
	const human = { HOME: "/home/me" };
	const set = await run(
		["secrets", "set", "LOG_LEVEL", "debug", "--type", "config"],
		node,
		{ env: human }
	);
	expect(set.code).toBe(0);
	expect(JSON.parse(node.calls[0]?.body ?? "{}").metadata).toEqual({
		valueType: "config",
	});
	const invalid = await run(
		["secrets", "set", "LOG_LEVEL", "debug", "--type", "public"],
		node,
		{ env: human }
	);
	expect(invalid.code).not.toBe(0);
	expect(invalid.err).toContain("--type must be config, secret, or sealed.");
	expect(node.calls).toHaveLength(1);

	const list = await run(["secrets", "list"], node, { env: human });
	expect(list.out).toContain("TYPE");
	expect(list.out).toMatch(/LOG_LEVEL\s+dev\s+\/\s+user\s+config/);
	expect(list.out).toMatch(/LEGACY_KEY\s+dev\s+\/\s+user\s+secret/);
});
