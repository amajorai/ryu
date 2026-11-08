// Lease-on-run (`ryu-cli secrets run --lease ROLE[=PREFIX]`) and the
// `dynamic` / `lease` subcommands. Core is faked through the target's `fetch`
// and the child through `spawn`.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { parseRoleFile } from "../cli/secrets-dynamic.ts";
import { runWithSecrets } from "../cli/secrets-run.ts";
import { fieldVariable, parseLeaseSpec } from "../cli/secrets-run-env.ts";
import type { CliContext } from "../cli/types.ts";
import {
	credential,
	fakeNode,
	json,
	jsonExport,
	lease,
	runSecrets,
} from "./secrets-fixture.ts";

let dir: string | null = null;
afterEach(async () => {
	if (dir) {
		await rm(dir, { recursive: true, force: true });
		dir = null;
	}
});

test("lease specs and field names map to environment variables", () => {
	expect(parseLeaseSpec("db-main")).toEqual({
		role: "db-main",
		prefix: "DB_MAIN",
	});
	expect(parseLeaseSpec("aws=AWS")).toEqual({ role: "aws", prefix: "AWS" });
	expect(() => parseLeaseSpec("db=1BAD")).toThrow("not a valid variable name");
	expect(fieldVariable("AWS", "secretAccessKey")).toBe("AWS_SECRET_ACCESS_KEY");
	expect(fieldVariable("DB", "password")).toBe("DB_PASSWORD");
});

test("run --lease injects the credential and revokes the lease after the command", async () => {
	const node = fakeNode({
		"POST /api/vault/export": json(jsonExport({ API_KEY: "k" })),
		"POST /api/vault/dynamic/issue/db": json(
			credential("vl_1", { username: "u1", password: "p1" })
		),
		"POST /api/vault/leases/vl_1/revoke": json({
			lease: lease("vl_1", "db", true),
		}),
	});
	let childEnv: Record<string, string> = {};
	const result = await runSecrets(
		[
			"run",
			"--no-project",
			"--lease",
			"db",
			"--lease-ttl",
			"15m",
			"--",
			"psql",
		],
		node,
		{
			spawn: (_cmd, env) => {
				childEnv = env;
				// The lease is still live while the command runs.
				expect(node.calls.map((call) => call.route)).not.toContain(
					"POST /api/vault/leases/vl_1/revoke"
				);
				return Promise.resolve(3);
			},
		}
	);
	expect(result.code).toBe(3);
	expect(childEnv).toMatchObject({
		API_KEY: "k",
		DB_USERNAME: "u1",
		DB_PASSWORD: "p1",
	});
	const issue = node.calls.find((call) =>
		call.route.includes("/dynamic/issue/")
	);
	expect(JSON.parse(issue?.body ?? "{}")).toEqual({ ttlSecs: 900 });
	expect(node.calls.at(-1)?.route).toBe("POST /api/vault/leases/vl_1/revoke");
	expect(result.err).toContain("Leased db (vl_1");
	expect(result.err).not.toContain("p1");
	expect(result.out).toBe("");
});

test("a lease that would replace a value is revoked and the command never starts", async () => {
	const node = fakeNode({
		"POST /api/vault/export": json(jsonExport({ DB_PASSWORD: "static" })),
		"POST /api/vault/dynamic/issue/db": json(
			credential("vl_2", { password: "p2" })
		),
		"POST /api/vault/leases/vl_2/revoke": json({
			lease: lease("vl_2", "db", true),
		}),
	});
	let spawned = false;
	const result = await runSecrets(
		["run", "--no-project", "--lease", "db", "--", "psql"],
		node,
		{
			spawn: () => {
				spawned = true;
				return Promise.resolve(0);
			},
		}
	);
	expect(result.code).toBe(2);
	expect(spawned).toBe(false);
	expect(result.err).toContain("would replace DB_PASSWORD");
	expect(result.err).not.toContain("p2");
	expect(node.calls.at(-1)?.route).toBe("POST /api/vault/leases/vl_2/revoke");
});

test("--lease cannot be combined with --broker", async () => {
	const node = fakeNode({});
	const result = await runSecrets(
		["run", "--no-project", "--broker", "github", "--lease", "db", "--", "gh"],
		node
	);
	expect(result.code).toBe(2);
	expect(node.calls).toHaveLength(0);
});

test("dynamic issue prints the credential, and an AI agent session is refused", async () => {
	const node = fakeNode({
		"POST /api/vault/dynamic/issue/db": json(
			credential("vl_3", { password: "p3" })
		),
	});
	const result = await runSecrets(
		["dynamic", "issue", "db", "--ttl", "1h"],
		node
	);
	expect(result.code).toBe(0);
	expect(result.out).toBe("password=p3\n");
	expect(result.err).toContain("Lease vl_3");
	const guarded = fakeNode({});
	const refused = await runSecrets(["dynamic", "issue", "db"], guarded, {
		env: { CLAUDECODE: "1" },
	});
	expect(refused.code).toBe(1);
	expect(guarded.calls).toHaveLength(0);
});

test("dynamic put reads the role from a file and refuses unknown fields without echoing values", async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-dynamic-"));
	const good = join(dir, "role.json");
	await writeFile(
		good,
		JSON.stringify({
			provider: { kind: "random", charset: "hex", length: 32 },
			defaultTtl: "1h",
			maxTtl: "1d",
		})
	);
	const node = fakeNode({
		"PUT /api/vault/dynamic/roles/tokens": json({
			role: {
				name: "tokens",
				provider: "random",
				defaultTtlSecs: 3600,
				maxTtlSecs: 86_400,
				summary: { kind: "random" },
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		}),
	});
	const result = await runSecrets(["dynamic", "put", "tokens", good], node);
	expect(result.code).toBe(0);
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({
		provider: { kind: "random", charset: "hex", length: 32 },
		defaultTtlSecs: 3600,
		maxTtlSecs: 86_400,
	});
	expect(() =>
		parseRoleFile(
			JSON.stringify({
				provider: {
					kind: "webhook",
					url: "https://x",
					signingSecret: "s3cr3t",
					extra: 1,
				},
			}),
			"role.json"
		)
	).toThrow(/^(?!.*s3cr3t).*role\.json/);
});

test("lease list, renew, and revoke", async () => {
	const node = fakeNode({
		"GET /api/vault/leases": json({
			leases: [lease("vl_4"), lease("vl_5", "db", true)],
		}),
		"POST /api/vault/leases/vl_4/renew": json({ lease: lease("vl_4") }),
		"POST /api/vault/leases/vl_4/revoke": json({
			lease: lease("vl_4", "db", true),
		}),
	});
	const list = await runSecrets(
		["lease", "list", "--name", "db", "--all"],
		node
	);
	expect(list.code).toBe(0);
	expect(node.calls[0]?.path).toBe(
		"/api/vault/leases?role=db&includeRevoked=true"
	);
	expect(list.out).toContain("vl_4");
	expect(list.out).toContain("revoked");
	const renew = await runSecrets(
		["lease", "renew", "vl_4", "--increment", "2h"],
		node
	);
	expect(renew.code).toBe(0);
	expect(JSON.parse(node.calls[1]?.body ?? "{}")).toEqual({ ttlSecs: 7200 });
	const revoke = await runSecrets(["lease", "revoke", "vl_4"], node);
	expect(revoke.out).toBe("Revoked lease vl_4.\n");
});

test("runWithSecrets refuses --lease with --broker before touching the node", async () => {
	const untouched: Partial<CliContext> = {};
	await expect(
		runWithSecrets(
			untouched as CliContext,
			parseSecretsArgs([
				"run",
				"--broker",
				"github",
				"--lease",
				"db",
				"--",
				"gh",
			])
		)
	).rejects.toThrow("cannot be combined with --broker");
	await expect(
		runWithSecrets(untouched as CliContext, parseSecretsArgs(["run"]))
	).rejects.toThrow("--lease ROLE[=PREFIX]");
});
