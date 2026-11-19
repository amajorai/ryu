// `ryu secrets …` dispatch tests: list, set, get, delete, versions, rollback, restore, export, import and scan. Core is faked through the
// target's injected `fetch`, child processes through `spawn`, and stdin
// through `readStdin`, so nothing touches a node, spawns, or reads the real
// terminal. Shared fixtures are in `secrets-dispatch-fixture.ts`.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runCli } from "../cli/dispatch.ts";
import {
	collectScanFiles,
	parseDuration,
	parseSecretsArgs,
	scanBatches,
} from "../cli/secrets.ts";

import {
	changeRequest,
	coords,
	exportResponse,
	fakeNode,
	makeIo,
	seal,
	secret,
	stubApi,
	vaultScanRequestObservation,
} from "./secrets-dispatch-fixture.ts";

let tempDir: string | null = null;
afterEach(async () => {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
});

test("parseArgs keeps raw tokens after the command and stops at --", () => {
	const parsed = parseArgs([
		"--node",
		"http://x",
		"secrets",
		"run",
		"--env",
		"prod",
		"--",
		"node",
		"--version",
		"-h",
	]);
	expect(parsed.command).toBe("secrets");
	expect(parsed.flags.version).toBe(false);
	expect(parsed.flags.help).toBe(false);
	expect(parsed.rawArgs).toEqual([
		"run",
		"--env",
		"prod",
		"--",
		"node",
		"--version",
		"-h",
	]);
});

test("parseSecretsArgs: repeatable values, globals skipped, unknown flags rejected", () => {
	const parsed = parseSecretsArgs([
		"set",
		"A",
		"--tag",
		"x",
		"--tag=y",
		"--json",
		"--node",
		"http://n",
		"-",
	]);
	expect(parsed.positional).toEqual(["set", "A", "-"]);
	expect(parsed.values.get("--tag")).toEqual(["x", "y"]);
	expect(() => parseSecretsArgs(["list", "--enviroment", "prod"])).toThrow(
		"Unknown flag --enviroment"
	);
	expect(parseDuration("30d")).toBe(2_592_000);
	expect(parseDuration("3600")).toBe(3600);
	expect(() => parseDuration("soon")).toThrow();
});

test("secrets list renders a metadata table", async () => {
	const cap = makeIo();
	const node = fakeNode({
		"GET /api/vault/secrets": {
			secrets: [secret],
			node: {
				id: "local",
				scope: "local",
				orgId: null,
				teamId: null,
				ownerUserId: null,
			},
			caller: null,
			canManageShared: false,
			sharedRemote: false,
			sharedError: null,
			activeEnvironment: "prod",
			seal,
		},
	});
	const code = await runCli(["secrets", "list", "--env", "prod"], {
		api: stubApi(),
		io: cap.io,
		target: node.target,
	});
	expect(code).toBe(0);
	expect(node.calls[0]?.path).toBe("/api/vault/secrets?environment=prod");
	expect(cap.out()).toContain("API_KEY");
	expect(cap.out()).toContain("Stripe key");
});

test("secrets set reads stdin, strips one newline, and sends metadata", async () => {
	const cap = makeIo();
	const node = fakeNode({
		"PUT /api/vault/secrets/API_KEY": { ok: true, secret },
	});
	const code = await runCli(
		[
			"secrets",
			"set",
			"API_KEY",
			"-",
			"--scope",
			"node",
			"--env",
			"prod",
			"--path",
			"/stripe",
			"--description",
			"Stripe key",
			"--tag",
			"payments",
			"--expires-at",
			"2030-01-01T00:00:00Z",
			"--rotate-every",
			"30d",
		],
		{
			api: stubApi(),
			io: cap.io,
			readStdin: () => Promise.resolve("sk_live_123\n"),
			target: node.target,
		}
	);
	expect(code).toBe(0);
	expect(node.calls[0]?.body).toEqual({
		scope: "node",
		environment: "prod",
		path: "/stripe",
		value: "sk_live_123",
		metadata: {
			description: "Stripe key",
			tags: ["payments"],
			expiresAt: "2030-01-01T00:00:00.000Z",
			rotationPeriodSecs: 2_592_000,
		},
	});
	expect(cap.out()).toBe("Set API_KEY (version 3).\n");
	expect(cap.out()).not.toContain("sk_live_123");
});

test("secrets set reports a change request for a protected environment", async () => {
	const cap = makeIo();
	const node = fakeNode({
		"PUT /api/vault/secrets/API_KEY": () =>
			Response.json(
				{
					ok: true,
					changeRequest: changeRequest({ id: "cr_1", status: "pending" }),
				},
				{ status: 202 }
			),
	});
	const code = await runCli(["secrets", "set", "API_KEY", "value"], {
		api: stubApi(),
		io: cap.io,
		target: node.target,
	});
	expect(code).toBe(0);
	expect(cap.out()).toContain("Change request cr_1 created for prod/API_KEY");
});

test("secrets set refuses an empty value", async () => {
	const cap = makeIo();
	const code = await runCli(["secrets", "set", "API_KEY", "-"], {
		api: stubApi(),
		io: cap.io,
		readStdin: () => Promise.resolve("\n"),
		target: fakeNode({}).target,
	});
	expect(code).toBe(2);
	expect(cap.err()).toContain("Refusing to store an empty value");
});

test("secrets set with - and a terminal stdin is a usage error; empty CI stdin is metadata-only", async () => {
	const tty = makeIo();
	expect(
		await runCli(["secrets", "set", "API_KEY", "-"], {
			api: stubApi(),
			io: tty.io,
			readStdin: () => Promise.resolve(null),
			target: fakeNode({}).target,
		})
	).toBe(2);
	expect(tty.err()).toContain("stdin is a terminal");
	const node = fakeNode({
		"PUT /api/vault/secrets/API_KEY": { ok: true, secret },
	});
	expect(
		await runCli(["secrets", "set", "API_KEY", "--description", "rotated"], {
			api: stubApi(),
			io: makeIo().io,
			readStdin: () => Promise.resolve(""),
			target: node.target,
		})
	).toBe(0);
	expect(node.calls[0]?.body).toEqual({
		scope: "user",
		metadata: { description: "rotated" },
	});
});

test("secrets get, delete, versions, rollback, and restore hit the value routes", async () => {
	const node = fakeNode({
		"POST /api/vault/secrets/API_KEY/reveal": { value: "sk_live_123" },
		"DELETE /api/vault/secrets/API_KEY": {
			ok: true,
			deleted: true,
			...coords,
			binding: null,
		},
		"GET /api/vault/secrets/API_KEY/versions": {
			versions: [
				{
					version: 2,
					createdAt: "2026-01-01T00:00:00Z",
					createdBy: null,
					source: "write",
					destroyed: false,
					current: true,
				},
			],
		},
		"POST /api/vault/secrets/API_KEY/rollback": { ok: true, secret },
		"POST /api/vault/secrets/API_KEY/restore": { ok: true, secret },
	});
	const run = async (argv: string[]) => {
		const cap = makeIo();
		const code = await runCli(argv, {
			api: stubApi(),
			io: cap.io,
			target: node.target,
		});
		return { code, out: cap.out() };
	};
	expect(await run(["secrets", "get", "API_KEY", "2"])).toEqual({
		code: 0,
		out: "sk_live_123\n",
	});
	expect((await run(["secrets", "delete", "API_KEY"])).out).toContain(
		"Deleted API_KEY"
	);
	expect((await run(["secrets", "versions", "API_KEY"])).out).toContain("2 *");
	expect((await run(["secrets", "rollback", "API_KEY", "1"])).out).toContain(
		"Rolled API_KEY back to version 1"
	);
	expect((await run(["secrets", "restore", "API_KEY"])).code).toBe(0);
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /api/vault/secrets/API_KEY/reveal",
		// delete first checks which broker services use the value.
		"GET /api/vault/broker/services",
		"DELETE /api/vault/secrets/API_KEY",
		"GET /api/vault/secrets/API_KEY/versions?scope=user",
		"POST /api/vault/secrets/API_KEY/rollback",
		"POST /api/vault/secrets/API_KEY/restore",
	]);
	expect(node.calls[0]?.body).toEqual({ scope: "user", version: 2 });
	expect(node.calls[2]?.body).toEqual({ scope: "user" });
	expect(node.calls[4]?.body).toEqual({ scope: "user", version: 1 });
});

test("secrets export prints content and maps --format k8s", async () => {
	const cap = makeIo();
	const node = fakeNode({
		"POST /api/vault/export": exportResponse(
			"k8s-secret",
			"apiVersion: v1\nkind: Secret\n",
			1
		),
	});
	const code = await runCli(
		[
			"secrets",
			"export",
			"--format",
			"k8s",
			"--k8s-name",
			"app",
			"--k8s-namespace",
			"web",
		],
		{ api: stubApi(), io: cap.io, target: node.target }
	);
	expect(code).toBe(0);
	expect(node.calls[0]?.body).toEqual({
		format: "k8s-secret",
		k8sName: "app",
		k8sNamespace: "web",
	});
	expect(cap.out()).toBe("apiVersion: v1\nkind: Secret\n");
});

test("secrets import infers JSON from the extension and reports counts", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ryu-secrets-"));
	const file = join(tempDir, "values.json");
	await writeFile(file, '{"A":"1"}');
	const cap = makeIo();
	const node = fakeNode({
		"POST /api/vault/import": {
			ok: true,
			report: { created: 1, updated: 0, skipped: 0, unchanged: 0 },
		},
	});
	const code = await runCli(
		["secrets", "import", file, "--on-conflict", "overwrite", "--env", "dev"],
		{ api: stubApi(), io: cap.io, target: node.target }
	);
	expect(code).toBe(0);
	expect(node.calls[0]?.body).toEqual({
		scope: "user",
		environment: "dev",
		format: "json",
		content: '{"A":"1"}',
		onConflict: "overwrite",
	});
	expect(cap.out()).toContain("1 created");
});

test("secrets scan skips ignored, binary, and large files and exits 1 on findings", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ryu-scan-"));
	await mkdir(join(tempDir, "node_modules"));
	await mkdir(join(tempDir, "src"));
	await writeFile(join(tempDir, "src", "config.ts"), 'const key = "AKIA";\n');
	await writeFile(join(tempDir, "node_modules", "dep.js"), "AKIA");
	await writeFile(join(tempDir, "image.bin"), new Uint8Array([1, 0, 2]));
	await writeFile(join(tempDir, "big.txt"), "x".repeat(1024 * 1024 + 1));
	const files = await collectScanFiles(tempDir, tempDir);
	expect(files.map((file) => file.path)).toEqual(["src/config.ts"]);

	const cap = makeIo();
	const node = fakeNode({
		"POST /api/vault/scan": {
			findings: [
				{
					rule: "aws-access-key-id",
					description: "AWS access key id",
					source: "src/config.ts",
					line: 1,
					column: 14,
					preview: "AKIA****",
					fingerprint: "fp1",
				},
			],
		},
	});
	const code = await runCli(["secrets", "scan", tempDir, "--allow", "fp0"], {
		api: stubApi(),
		io: cap.io,
		target: node.target,
	});
	expect(code).toBe(1);
	const body = vaultScanRequestObservation.parse(node.calls[0]?.body);
	expect(body.allow).toEqual(["fp0"]);
	expect(body.knownValues).toBe(true);
	expect(body.files).toHaveLength(1);
	expect(cap.out()).toBe("src/config.ts:1:14 aws-access-key-id AKIA****\n");
});

test("scanBatches splits by count and size", () => {
	const files = Array.from({ length: 450 }, (_, index) => ({
		path: `f${index}`,
		content: "x",
	}));
	expect(scanBatches(files).map((batch) => batch.length)).toEqual([
		200, 200, 50,
	]);
	const big = [
		{ path: "a", content: "x".repeat(1_500_000) },
		{ path: "b", content: "x".repeat(1_500_000) },
	];
	expect(scanBatches(big)).toHaveLength(2);
});
