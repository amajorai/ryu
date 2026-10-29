// Dispatch tests for `ryu secrets …`. Core is faked through the target's
// injected `fetch`, child processes through `spawn`, and stdin through
// `readStdin`, so nothing touches a node, spawns, or reads the real terminal.

import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { z } from "zod";
import { parseArgs, runCli } from "../cli/dispatch.ts";
import {
	collectScanFiles,
	parseDuration,
	parseItemField,
	parseSecretsArgs,
	scanBatches,
} from "../cli/secrets.ts";
import type { CliIO, CoreApi, ProcessRunner } from "../cli/types.ts";
import type { ContainerHost } from "../cli/vaultIsolation.ts";
import { DEFAULT_CORE_URL } from "../core/target.ts";

interface Call {
	body: z.infer<typeof appResponseValueSchema>;
	headers: Headers;
	method: string;
	path: string;
}

function makeIo() {
	let outBuf = "";
	let errBuf = "";
	return {
		io: {
			out: (s) => {
				outBuf += s;
			},
			err: (s) => {
				errBuf += s;
			},
		} satisfies CliIO,
		out: () => outBuf,
		err: () => errBuf,
	};
}

function stubApi(): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		enableApp: notCalled,
		disableApp: notCalled,
		uninstallApp: notCalled,
		execAppCommand: notCalled,
		streamChat: notCalled,
	};
}

// All local responders are statically checked against this fixture callback
// owner. Installed Zod callable admission only selects the callable branch;
// retain the original callback rather than its wrapping function/parser.
type NodeResponder = (call: Call) => Response;
type NodeRoute = z.infer<typeof appRequestValueSchema> | NodeResponder;
interface NodeRoutes {
	[route: string]: NodeRoute;
}
const callableAdmission = z.function();
const nodeResponderAdmission = z.custom<NodeResponder>(
	(value) => callableAdmission.safeParse(value).success
);
interface SpawnObservation {
	cmd: Parameters<ProcessRunner>[0];
	env: Parameters<ProcessRunner>[1];
}
interface SpawnCapture {
	value: SpawnObservation | null;
}
const vaultScanFields = z.looseObject({
	allow: z.array(z.string()),
	files: z.array(z.looseObject({ path: z.string(), content: z.string() })),
	knownValues: z.boolean(),
});
const vaultScanRequestObservation = z.custom<z.infer<typeof vaultScanFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		vaultScanFields.safeParse(value).success
);

/** A fake node: `routes` maps `METHOD /path` (no query) to a JSON body. */
function fakeNode(routes: NodeRoutes, url = "http://node.test") {
	const calls: Call[] = [];
	const target: ApiTarget = {
		url,
		token: "node-token",
		fetch: async (input, init) => {
			const url = new URL(String(input));
			const call: Call = {
				method: init?.method ?? "GET",
				path: `${url.pathname}${url.search}`,
				headers: new Headers(init?.headers),
				body:
					init?.body === undefined
						? undefined
						: appResponseValueSchema.parse(JSON.parse(String(init.body))),
			};
			calls.push(call);
			const route = routes[`${call.method} ${url.pathname}`];
			if (route === undefined) {
				return Response.json({ error: "no route" }, { status: 404 });
			}
			const responder = nodeResponderAdmission.safeParse(route);
			if (responder.success) {
				const respond = responder.data;
				return respond(call);
			}
			return Response.json(route);
		},
	};
	return { calls, target };
}

// Complete native wire models: core-client validates every Core vault reply
// against the vault_api.rs renderer contract, so partial fixtures are refused.
const timestamp = "2026-01-01T00:00:00Z";
const coords = {
	name: "API_KEY",
	scope: "user",
	scopeId: "local",
	environment: "prod",
	path: "/",
};
const secret = {
	...coords,
	version: 3,
	status: "active",
	metadata: {
		description: "Stripe key",
		tags: [],
		expiresAt: null,
		rotationPeriodSecs: null,
		generator: null,
		expandReferences: true,
		maxVersions: 10,
	},
	capabilities: ["read"],
	createdAt: timestamp,
	createdBy: null,
	updatedAt: timestamp,
	updatedBy: null,
	rotatedAt: null,
};
const seal = {
	mode: "auto",
	sealed: false,
	shares: 0,
	threshold: 0,
	progress: 0,
	keyVersions: [1, 2],
	activeKeyVersion: 2,
};
function changeRequest(fields: { id: string; status: string }) {
	return {
		...fields,
		operation: "write",
		coords,
		hasValue: true,
		patch: {},
		requestedBy: "user-1",
		requestedAt: timestamp,
		approvals: [],
		requiredApprovals: 2,
		decidedBy: null,
		decidedAt: null,
		reason: null,
	};
}
function exportResponse(format: string, content: string, count: number) {
	return {
		format,
		contentType: format === "json" ? "application/json" : "text/plain",
		count,
		environment: "prod",
		path: "/",
		content,
	};
}
const issuedToken = {
	accessor: "acc_1",
	identityId: "mid_1",
	policies: ["ci"],
	expiresAt: "2030-01-01T00:00:00Z",
};
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
		"DELETE /api/vault/secrets/API_KEY",
		"GET /api/vault/secrets/API_KEY/versions?scope=user",
		"POST /api/vault/secrets/API_KEY/rollback",
		"POST /api/vault/secrets/API_KEY/restore",
	]);
	expect(node.calls[0]?.body).toEqual({ scope: "user", version: 2 });
	expect(node.calls[1]?.body).toEqual({ scope: "user" });
	expect(node.calls[3]?.body).toEqual({ scope: "user", version: 1 });
});

test("secrets run merges exported values into the child env without printing them", async () => {
	const cap = makeIo();
	const node = fakeNode({
		"POST /api/vault/export": exportResponse(
			"json",
			JSON.stringify({ API_KEY: "sk_live_123", PATH: "/vault" }),
			2
		),
	});
	const spawned: SpawnCapture = { value: null };
	const code = await runCli(
		["secrets", "run", "--env", "prod", "--", "node", "app.js", "--version"],
		{
			api: stubApi(),
			env: { HOME: "/home/me", PATH: "/usr/bin" },
			io: cap.io,
			spawn: (cmd, env) => {
				spawned.value = { cmd, env };
				return Promise.resolve(7);
			},
			target: node.target,
		}
	);
	expect(code).toBe(7);
	expect(node.calls[0]?.body).toEqual({ environment: "prod", format: "json" });
	expect(spawned.value).not.toBeNull();
	const child = spawned.value;
	if (!child) {
		throw new Error("Expected child process invocation");
	}
	expect(child.cmd).toEqual(["node", "app.js", "--version"]);
	expect(child.env).toEqual({
		HOME: "/home/me",
		PATH: "/vault",
		API_KEY: "sk_live_123",
	});
	expect(cap.out()).toBe("");
	expect(cap.err()).toBe("");
});

test("secrets run forwards runtime variables but not unrelated ambient credentials", async () => {
	const node = fakeNode({
		"POST /api/vault/agent/export": exportResponse(
			"json",
			JSON.stringify({ SELECTED_VALUE: "dummy-exported-value" }),
			1
		),
	});
	let childEnv: Record<string, string> = {};
	const code = await runCli(["secrets", "run", "--", "dummy-command"], {
		api: stubApi(),
		env: {
			HOME: "/home/test",
			PATH: "/usr/bin",
			HTTPS_PROXY: "http://proxy.internal:3128",
			no_proxy: "localhost,127.0.0.1",
			HTTP_PROXY: "http://proxy-user:dummy-proxy-marker@proxy.internal:3128",
			ALL_PROXY: "proxy-user:dummy-proxy-marker@proxy.internal:1080",
			ANTHROPIC_API_KEY: "dummy-anthropic-marker",
			AWS_SECRET_ACCESS_KEY: "dummy-aws-marker",
			GITHUB_TOKEN: "dummy-github-marker",
			OPENAI_API_KEY: "dummy-provider-marker",
			RYU_CORE_TOKEN: "dummy-core-marker",
			RYU_GATEWAY_TOKEN: "dummy-gateway-marker",
			RYU_MASTER_KEY: "dummy-master-marker",
			RYU_NODE_TOKEN: "dummy-node-marker",
			RYU_VAULT_TOKEN: "dummy-vault-marker",
		},
		io: makeIo().io,
		spawn: (_command, environment) => {
			childEnv = environment;
			return Promise.resolve(0);
		},
		target: node.target,
	});

	expect(code).toBe(0);
	// The vault token still authenticates the CLI's own export call.
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /api/vault/agent/export",
	]);
	expect(node.calls[0]?.headers.get("x-ryu-vault-token")).toBe(
		"dummy-vault-marker"
	);
	// Credential-free proxy routing survives; credentialed proxy URLs and every
	// ambient token/key do not.
	expect(childEnv).toEqual({
		HOME: "/home/test",
		PATH: "/usr/bin",
		HTTPS_PROXY: "http://proxy.internal:3128",
		no_proxy: "localhost,127.0.0.1",
		SELECTED_VALUE: "dummy-exported-value",
	});
	expect(JSON.stringify(childEnv)).not.toContain("marker");
});

test("RYU_VAULT_TOKEN switches run/export/get to the agent routes", async () => {
	const node = fakeNode({
		"POST /api/vault/agent/export": exportResponse(
			"json",
			JSON.stringify({ DB_URL: "postgres://x" }),
			1
		),
		"GET /api/vault/agent/secrets/DB_URL": { value: "postgres://x" },
	});
	let childEnv: Record<string, string> = {};
	const env = { RYU_VAULT_TOKEN: "rvt_token", HOME: "/h" };
	const runCode = await runCli(["secrets", "run", "--", "migrate"], {
		api: stubApi(),
		env,
		io: makeIo().io,
		spawn: (_cmd, childEnvironment) => {
			childEnv = childEnvironment;
			return Promise.resolve(0);
		},
		target: node.target,
	});
	const getIo = makeIo();
	await runCli(["secrets", "get", "DB_URL", "--env", "ci"], {
		api: stubApi(),
		env,
		io: getIo.io,
		target: node.target,
	});
	expect(runCode).toBe(0);
	expect(childEnv).toEqual({ HOME: "/h", DB_URL: "postgres://x" });
	expect(getIo.out()).toBe("postgres://x\n");
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /api/vault/agent/export",
		"GET /api/vault/agent/secrets/DB_URL?environment=ci",
	]);
	for (const call of node.calls) {
		expect(call.headers.get("x-ryu-vault-token")).toBe("rvt_token");
		expect(call.headers.get("authorization")).toBeNull();
	}
});

test("secrets login prints the token and logout revokes it", async () => {
	const node = fakeNode({
		"POST /api/vault/auth/approle/login": {
			token: { token: "rvt_new", ...issuedToken },
		},
		"POST /api/vault/auth/jwt/login": {
			token: { token: "rvt_jwt", ...issuedToken },
		},
		"POST /api/vault/agent/self/revoke": { revoked: true },
	});
	const login = makeIo();
	expect(
		await runCli(["secrets", "login", "--approle", "role-1", "secret-1"], {
			api: stubApi(),
			io: login.io,
			target: node.target,
		})
	).toBe(0);
	expect(login.out()).toBe("rvt_new\n");
	const jwt = makeIo();
	await runCli(["secrets", "login", "--jwt", "github", "eyJ.x.y", "--json"], {
		api: stubApi(),
		io: jwt.io,
		target: node.target,
	});
	expect(JSON.parse(jwt.out())).toEqual({ token: "rvt_jwt", ...issuedToken });
	const logout = makeIo();
	expect(
		await runCli(["secrets", "logout"], {
			api: stubApi(),
			env: { RYU_VAULT_TOKEN: "rvt_new" },
			io: logout.io,
			target: node.target,
		})
	).toBe(0);
	expect(node.calls[0]?.body).toEqual({
		roleId: "role-1",
		secretId: "secret-1",
	});
	expect(node.calls[1]?.body).toEqual({ identity: "github", jwt: "eyJ.x.y" });
	expect(node.calls[0]?.headers.get("authorization")).toBeNull();
});

test("secrets run warns on stderr when an outage left shared values out", async () => {
	const cap = makeIo();
	const node = fakeNode({
		"POST /api/vault/export": {
			...exportResponse("json", JSON.stringify({ API_KEY: "sk_live_123" }), 1),
			sharedError: "vault_shared_unreachable: the control plane answered 503",
		},
	});
	const spawned: SpawnCapture = { value: null };
	const code = await runCli(["secrets", "run", "--", "node", "app.js"], {
		api: stubApi(),
		env: {},
		io: cap.io,
		spawn: (cmd, env) => {
			spawned.value = { cmd, env };
			return Promise.resolve(0);
		},
		target: node.target,
	});
	expect(code).toBe(0);
	expect(spawned.value?.env.API_KEY).toBe("sk_live_123");
	expect(cap.err()).toContain("Team and Organization values are missing");
	expect(cap.out()).toBe("");
});

test("secrets run warns with what to do when the control plane refused the shared values", async () => {
	const cap = makeIo();
	const node = fakeNode({
		"POST /api/vault/export": {
			...exportResponse("json", JSON.stringify({ API_KEY: "sk_live_123" }), 1),
			sharedError: "vault_shared_refused: org_ip_not_allowed",
		},
	});
	const spawned: SpawnCapture = { value: null };
	const code = await runCli(["secrets", "run", "--", "node", "app.js"], {
		api: stubApi(),
		env: {},
		io: cap.io,
		spawn: (cmd, env) => {
			spawned.value = { cmd, env };
			return Promise.resolve(0);
		},
		target: node.target,
	});
	expect(code).toBe(0);
	expect(spawned.value?.env.API_KEY).toBe("sk_live_123");
	expect(cap.err()).toContain(
		"the control plane refused this request (org_ip_not_allowed)"
	);
	expect(cap.err()).toContain("Ask an organization admin.");
	expect(cap.err()).not.toContain("couldn't be reached");
	expect(cap.out()).toBe("");
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

test("secrets env set merges the existing record", async () => {
	const node = fakeNode({
		"GET /api/vault/environments": {
			active: "default",
			environments: [
				{
					slug: "prod",
					name: "Production",
					protected: true,
					requiredApprovals: 1,
					position: 2,
				},
			],
		},
		"PUT /api/vault/environments/prod": (call: Call) =>
			Response.json({
				ok: true,
				environment: {
					slug: "prod",
					...Object.fromEntries(Object.entries(call.body ?? {})),
				},
			}),
	});
	const code = await runCli(
		["secrets", "env", "set", "prod", "--approvals", "2"],
		{
			api: stubApi(),
			io: makeIo().io,
			target: node.target,
		}
	);
	expect(code).toBe(0);
	expect(node.calls[1]?.body).toEqual({
		name: "Production",
		protected: true,
		requiredApprovals: 2,
		position: 2,
	});
});

test("secrets policy, approvals, audit, and seal subcommands", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ryu-policy-"));
	const policyFile = join(tempDir, "ci.json");
	await writeFile(
		policyFile,
		JSON.stringify({
			description: "CI",
			rules: [{ path: "prod/**", capabilities: ["read"] }],
		})
	);
	const node = fakeNode({
		"PUT /api/vault/policies/ci": {
			ok: true,
			policy: {
				name: "ci",
				description: "CI",
				rules: [{ path: "prod/**", capabilities: ["read"], deny: false }],
			},
		},
		"POST /api/vault/policy-bindings": {
			ok: true,
			binding: {
				id: "pb_1",
				policy: "ci",
				subject: "machine:mid_1",
				expiresAt: "2030-01-01T00:00:00Z",
			},
		},
		"DELETE /api/vault/policy-bindings/pb_1": { ok: true, removed: true },
		"POST /api/vault/change-requests/cr_1/reject": {
			ok: true,
			changeRequest: changeRequest({ id: "cr_1", status: "rejected" }),
		},
		"GET /api/vault/audit/verify": {
			report: { ok: false, rows: 9, firstBadSeq: 4 },
		},
		"POST /api/vault/sys/unseal": {
			seal: {
				...seal,
				mode: "shamir",
				sealed: true,
				shares: 5,
				threshold: 3,
				progress: 1,
			},
		},
		"GET /api/vault/sys/status": {
			seal,
			activeEnvironment: "default",
			sharedRemote: false,
		},
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
	expect((await run(["secrets", "policy", "set", "ci", policyFile])).code).toBe(
		0
	);
	expect(
		(
			await run([
				"secrets",
				"policy",
				"bind",
				"ci",
				"machine:mid_1",
				"--expires-at",
				"2030-01-01T00:00:00Z",
			])
		).out
	).toContain("binding pb_1");
	expect((await run(["secrets", "policy", "unbind", "pb_1"])).code).toBe(0);
	expect(
		(await run(["secrets", "approvals", "reject", "cr_1", "--reason", "no"]))
			.out
	).toContain("rejected");
	const verify = await run(["secrets", "audit", "--verify"]);
	expect(verify.code).toBe(1);
	expect(verify.out).toContain("BROKEN at seq 4");
	expect((await run(["secrets", "unseal", "share-1"])).out).toContain("1/3");
	expect((await run(["secrets", "status"])).out).toContain("Unsealed (auto");
	expect(node.calls[0]?.body).toEqual({
		description: "CI",
		rules: [{ path: "prod/**", capabilities: ["read"] }],
	});
	expect(node.calls[1]?.body).toEqual({
		policy: "ci",
		subject: "machine:mid_1",
		expiresAt: "2030-01-01T00:00:00.000Z",
	});
	expect(node.calls[3]?.body).toEqual({ reason: "no" });
	expect(node.calls[5]?.body).toEqual({ share: "share-1" });
});

test("secrets with no subcommand prints its help; unknown subcommands are usage errors", async () => {
	const help = makeIo();
	expect(
		await runCli(["secrets"], {
			api: stubApi(),
			io: help.io,
			target: fakeNode({}).target,
		})
	).toBe(0);
	expect(help.out()).toContain("ryu-cli secrets — manage the Secret Vault");
	const bad = makeIo();
	expect(
		await runCli(["secrets", "frobnicate"], {
			api: stubApi(),
			io: bad.io,
			target: fakeNode({}).target,
		})
	).toBe(2);
	expect(bad.err()).toContain("Unknown subcommand 'frobnicate'");
});

// ── Broker, TOTP, items, tokens, and wrapping ────────────────────────────────

const T = "2030-01-01T00:00:00Z";
const brokerSession = {
	id: "bs_1",
	environment: "prod",
	services: ["github", "stripe"],
	label: "ryu secrets run node",
	mintedBy: "user:u1",
	createdAt: T,
	expiresAt: T,
};
const CA_PEM =
	"-----BEGIN CERTIFICATE-----\nbroker\n-----END CERTIFICATE-----\n";

function brokerGrant(caPath: string, caBundlePath: string) {
	const proxyUrl = "http://rvb:rvb_session_secret@127.0.0.1:8123";
	return {
		token: "rvb_session_secret",
		session: brokerSession,
		proxy: {
			url: "http://127.0.0.1:8123",
			port: 8123,
			caPath,
			caBundlePath,
			caUrl: "/api/vault/broker/ca.pem",
			env: {
				HTTPS_PROXY: proxyUrl,
				https_proxy: proxyUrl,
				NODE_EXTRA_CA_CERTS: caPath,
				SSL_CERT_FILE: caBundlePath,
			},
		},
	};
}

test("secrets run --broker on the node's host writes a private CA bundle when Core's CA files are unreadable", async () => {
	const cap = makeIo();
	// Same host (loopback target), but Core's CA paths are not readable by
	// this user, e.g. Core runs as a service account.
	const node = fakeNode(
		{
			"POST /api/vault/broker/sessions": brokerGrant(
				"/nonexistent/ryu/ca.pem",
				"/nonexistent/ryu/ca-bundle.pem"
			),
			"GET /api/vault/broker/ca.pem": () => new Response(CA_PEM),
			"DELETE /api/vault/broker/sessions/bs_1": { revoked: true },
		},
		"http://127.0.0.1:7777"
	);
	const observed: {
		bundle: string;
		ca: string;
		env: Record<string, string>;
		mode: number;
	} = { bundle: "", ca: "", env: {}, mode: 0 };
	const code = await runCli(
		[
			"secrets",
			"run",
			"--broker",
			"github,stripe",
			"--env",
			"prod",
			"--ttl",
			"15m",
			"--",
			"node",
			"agent.js",
		],
		{
			api: stubApi(),
			env: {
				HOME: "/home/me",
				NO_PROXY: "localhost,.internal",
				OPENAI_API_KEY: "dummy-provider-marker",
				RYU_CORE_TOKEN: "dummy-core-marker",
				RYU_MASTER_KEY: "dummy-master-marker",
				RYU_VAULT_TOKEN: "",
			},
			io: cap.io,
			spawn: async (_cmd, env) => {
				observed.env = env;
				observed.ca = await readFile(env.NODE_EXTRA_CA_CERTS ?? "", "utf8");
				observed.bundle = await readFile(env.SSL_CERT_FILE ?? "", "utf8");
				observed.mode =
					(await stat(env.NODE_EXTRA_CA_CERTS ?? "")).mode & 0o777;
				return 3;
			},
			target: node.target,
		}
	);
	expect(code).toBe(3);
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /api/vault/broker/sessions",
		"GET /api/vault/broker/ca.pem",
		"DELETE /api/vault/broker/sessions/bs_1",
	]);
	expect(node.calls[0]?.body).toEqual({
		services: ["github", "stripe"],
		label: "ryu secrets run node",
		environment: "prod",
		ttlSecs: 900,
	});
	// No exported values: the child sees only the proxy environment.
	expect(node.calls.some((call) => call.path.includes("/export"))).toBe(false);
	expect(observed.env.HOME).toBe("/home/me");
	// A host child keeps credential-free routing config but none of the CLI's
	// ambient credentials.
	expect(observed.env.NO_PROXY).toBe("localhost,.internal");
	expect(JSON.stringify(observed.env)).not.toContain("marker");
	expect(observed.env.HTTPS_PROXY).toBe(
		"http://rvb:rvb_session_secret@127.0.0.1:8123"
	);
	expect(observed.env.NODE_EXTRA_CA_CERTS).not.toBe("/nonexistent/ryu/ca.pem");
	expect(observed.ca).toBe(CA_PEM);
	expect(observed.bundle.endsWith(CA_PEM)).toBe(true);
	expect(observed.mode).toBe(0o600);
	// The temporary CA directory is removed after the child exits.
	await expect(stat(observed.env.NODE_EXTRA_CA_CERTS ?? "")).rejects.toThrow();
	expect(cap.out()).not.toContain("rvb_session_secret");
	expect(cap.err()).not.toContain("rvb_session_secret");
});

test("secrets run --broker keeps local CA paths and fails when the listener is down", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ryu-broker-ca-"));
	const caPath = join(tempDir, "ca.pem");
	const bundlePath = join(tempDir, "bundle.pem");
	await writeFile(caPath, CA_PEM);
	await writeFile(bundlePath, CA_PEM);
	const local = fakeNode(
		{
			"POST /api/vault/agent/broker/sessions": brokerGrant(caPath, bundlePath),
		},
		"http://localhost:7777"
	);
	let childEnv: Record<string, string> = {};
	const code = await runCli(
		["secrets", "run", "--broker", "github", "--", "deploy"],
		{
			api: stubApi(),
			env: { RYU_VAULT_TOKEN: "rvt_machine" },
			io: makeIo().io,
			spawn: (_cmd, env) => {
				childEnv = env;
				return Promise.resolve(0);
			},
			target: local.target,
		}
	);
	expect(code).toBe(0);
	// Machine mode: the agent route, no CA download, and no human revoke call.
	expect(local.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /api/vault/agent/broker/sessions",
	]);
	expect(local.calls[0]?.headers.get("x-ryu-vault-token")).toBe("rvt_machine");
	expect(childEnv.NODE_EXTRA_CA_CERTS).toBe(caPath);
	expect(childEnv.SSL_CERT_FILE).toBe(bundlePath);
	expect(childEnv.RYU_VAULT_TOKEN).toBeUndefined();

	const down = fakeNode({
		"POST /api/vault/broker/sessions": {
			token: "rvb_x",
			session: brokerSession,
			proxy: null,
		},
		"DELETE /api/vault/broker/sessions/bs_1": { revoked: true },
	});
	const cap = makeIo();
	let spawned = false;
	expect(
		await runCli(["secrets", "run", "--broker", "github", "--", "deploy"], {
			api: stubApi(),
			env: {},
			io: cap.io,
			spawn: () => {
				spawned = true;
				return Promise.resolve(0);
			},
			target: down.target,
		})
	).toBe(1);
	expect(spawned).toBe(false);
	expect(cap.err()).toContain("not listening");
	expect(down.calls.at(-1)?.method).toBe("DELETE");
	expect(
		await runCli(["secrets", "run", "--ttl", "5m", "--", "deploy"], {
			api: stubApi(),
			io: makeIo().io,
			target: down.target,
		})
	).toBe(2);
});

test("secrets run --broker refuses a remote node whose proxy is on loopback", async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ryu-broker-ca-"));
	// The same CA layout exists on this host; it must not be mistaken for the
	// remote node's CA, and the loopback proxy URL must not reach the child.
	const caPath = join(tempDir, "ca.pem");
	const bundlePath = join(tempDir, "bundle.pem");
	await writeFile(caPath, CA_PEM);
	await writeFile(bundlePath, CA_PEM);
	const remote = fakeNode(
		{
			"POST /api/vault/broker/sessions": brokerGrant(caPath, bundlePath),
			"GET /api/vault/broker/ca.pem": () => new Response(CA_PEM),
			"DELETE /api/vault/broker/sessions/bs_1": { revoked: true },
		},
		"https://node.example.com:7777"
	);
	const cap = makeIo();
	let spawned = false;
	const code = await runCli(
		["secrets", "run", "--broker", "github", "--", "deploy"],
		{
			api: stubApi(),
			env: {},
			io: cap.io,
			spawn: () => {
				spawned = true;
				return Promise.resolve(0);
			},
			target: remote.target,
		}
	);
	expect(code).toBe(1);
	expect(spawned).toBe(false);
	expect(cap.err()).toContain("not reachable from this host");
	expect(cap.err()).not.toContain("rvb_session_secret");
	expect(remote.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /api/vault/broker/sessions",
		"DELETE /api/vault/broker/sessions/bs_1",
	]);
});

// A fake signal seam for `run --broker` on the host: tests deliver signals by
// calling `send` instead of signalling the test process.
function signalHost() {
	const signals = {
		disposed: false,
		handler: null as ((signal: string) => void) | null,
	};
	const host: ContainerHost = {
		cwd: () => "/",
		docker: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
		gid: 1000,
		homeDir: "/home/me",
		isTty: false,
		onSignal: (handler) => {
			signals.handler = handler;
			signals.disposed = false;
			return () => {
				signals.disposed = true;
			};
		},
		platform: "linux",
		tmpDir: tmpdir(),
		uid: 1000,
	};
	return { host, send: (signal: string) => signals.handler?.(signal), signals };
}

function hostBrokerNode(onMint?: () => void) {
	return fakeNode(
		{
			"POST /api/vault/broker/sessions": () => {
				onMint?.();
				return Response.json(
					brokerGrant("/nonexistent/ryu/ca.pem", "/nonexistent/ryu/bundle.pem")
				);
			},
			"GET /api/vault/broker/ca.pem": () => new Response(CA_PEM),
			"DELETE /api/vault/broker/sessions/bs_1": { revoked: true },
		},
		"http://127.0.0.1:7777"
	);
}

const brokerRunArgs = ["secrets", "run", "--broker", "github", "--", "dev"];

test("secrets run --broker on the host waits through Ctrl-C, then revokes and removes the CA bundle", async () => {
	const fake = signalHost();
	const node = hostBrokerNode();
	let caPath = "";
	const code = await runCli(brokerRunArgs, {
		api: stubApi(),
		containerHost: fake.host,
		env: {},
		io: makeIo().io,
		spawn: (_cmd, env) => {
			caPath = env.NODE_EXTRA_CA_CERTS ?? "";
			// The terminal delivers Ctrl-C to the child too; the CLI keeps
			// waiting for the child's own exit code.
			fake.send("SIGINT");
			return Promise.resolve(130);
		},
		target: node.target,
	});
	expect(code).toBe(130);
	expect(node.calls.at(-1)?.method).toBe("DELETE");
	await expect(stat(caPath)).rejects.toThrow();
	expect(fake.signals.disposed).toBe(true);
});

test("secrets run --broker on the host revokes and exits 128+n on SIGTERM while the child runs", async () => {
	const fake = signalHost();
	const node = hostBrokerNode();
	const cap = makeIo();
	let caPath = "";
	const code = await runCli(brokerRunArgs, {
		api: stubApi(),
		containerHost: fake.host,
		env: {},
		io: cap.io,
		spawn: (_cmd, env) => {
			caPath = env.NODE_EXTRA_CA_CERTS ?? "";
			fake.send("SIGTERM");
			// A child that never exits must not keep the session alive.
			return new Promise<number>(() => undefined);
		},
		target: node.target,
	});
	expect(code).toBe(143);
	expect(cap.err()).toContain("stopped by SIGTERM");
	expect(node.calls.at(-1)?.method).toBe("DELETE");
	await expect(stat(caPath)).rejects.toThrow();
	expect(fake.signals.disposed).toBe(true);
});

test("secrets run --broker on the host revokes without spawning when a signal arrives while minting", async () => {
	const fake = signalHost();
	const node = hostBrokerNode(() => fake.send("SIGHUP"));
	let spawned = false;
	const code = await runCli(brokerRunArgs, {
		api: stubApi(),
		containerHost: fake.host,
		env: {},
		io: makeIo().io,
		spawn: () => {
			spawned = true;
			return Promise.resolve(0);
		},
		target: node.target,
	});
	expect(code).toBe(129);
	expect(spawned).toBe(false);
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /api/vault/broker/sessions",
		"DELETE /api/vault/broker/sessions/bs_1",
	]);
	expect(fake.signals.disposed).toBe(true);
});

test("secrets broker services, proposals, and ca", async () => {
	const node = fakeNode({
		"GET /api/vault/broker/services": {
			services: [
				{
					name: "github",
					environment: "prod",
					host: "api.github.com",
					pathPrefix: "/",
					auth: { kind: "bearer" },
					enabled: true,
					description: "GitHub API",
					createdAt: T,
					updatedAt: T,
				},
			],
		},
		"GET /api/vault/broker/proposals": {
			proposals: [
				{
					id: "bp_1",
					environment: "prod",
					status: "pending",
					message: "need stripe",
					services: [],
					credentials: [{ ref: "secret:STRIPE" }],
					requestedBy: "machine:m1",
					createdAt: T,
					expiresAt: T,
				},
			],
		},
		"POST /api/vault/broker/proposals/bp_1/approve": {
			approved: true,
			proposal: "bp_1",
		},
		"POST /api/vault/broker/proposals/bp_1/reject": { rejected: true },
		"GET /api/vault/broker/ca.pem": () => new Response(CA_PEM),
	});
	const run = async (args: string[]) => {
		const cap = makeIo();
		const code = await runCli(["secrets", ...args], {
			api: stubApi(),
			io: cap.io,
			target: node.target,
		});
		return { code, out: cap.out() };
	};
	const services = await run(["broker", "services", "--env", "prod"]);
	expect(services.code).toBe(0);
	expect(services.out).toContain("api.github.com");
	const proposals = await run(["broker", "proposals"]);
	expect(proposals.out).toContain("secret:STRIPE");
	expect((await run(["broker", "proposals", "approve", "bp_1"])).out).toBe(
		"Approved proposal bp_1.\n"
	);
	await run(["broker", "proposals", "reject", "bp_1", "--reason", "no"]);
	expect((await run(["broker", "ca"])).out).toBe(CA_PEM);
	expect((await run(["broker", "bogus"])).code).toBe(2);
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"GET /api/vault/broker/services?environment=prod",
		"GET /api/vault/broker/proposals?status=pending",
		"POST /api/vault/broker/proposals/bp_1/approve",
		"POST /api/vault/broker/proposals/bp_1/reject",
		"GET /api/vault/broker/ca.pem",
	]);
	expect(node.calls[2]?.body).toEqual({});
	expect(node.calls[3]?.body).toEqual({ note: "no" });
});

test("secrets totp code and validate", async () => {
	const node = fakeNode({
		"GET /api/vault/totp/code/github": {
			code: "123456",
			period: 30,
			remainingSecs: 9,
		},
		"POST /api/vault/totp/validate/github": (call: Call) =>
			Response.json({
				valid: JSON.stringify(call.body) === JSON.stringify({ code: "123456" }),
			}),
		"GET /api/vault/agent/totp/code/github": {
			code: "999999",
			period: 30,
			remainingSecs: 1,
		},
	});
	const code = makeIo();
	expect(
		await runCli(["secrets", "totp", "code", "github"], {
			api: stubApi(),
			io: code.io,
			target: node.target,
		})
	).toBe(0);
	expect(code.out()).toBe("123456\n");
	const valid = makeIo();
	expect(
		await runCli(["secrets", "totp", "validate", "github", "123456"], {
			api: stubApi(),
			io: valid.io,
			target: node.target,
		})
	).toBe(0);
	expect(valid.out()).toBe("valid\n");
	expect(
		await runCli(["secrets", "totp", "validate", "github", "000000"], {
			api: stubApi(),
			io: makeIo().io,
			target: node.target,
		})
	).toBe(1);
	const agent = makeIo();
	await runCli(["secrets", "totp", "code", "github"], {
		api: stubApi(),
		env: { RYU_VAULT_TOKEN: "rvt_m" },
		io: agent.io,
		target: node.target,
	});
	expect(agent.out()).toBe("999999\n");
});

test("parseItemField infers the field type and keeps colons in values", () => {
	expect(parseItemField("password=hunter2")).toEqual({
		field: { name: "password", type: "password", sensitive: true },
		value: "hunter2",
	});
	expect(parseItemField("url=https://a.example:8443:plain")).toEqual({
		field: { name: "url", type: "url", sensitive: false },
		value: "https://a.example:8443",
	});
	expect(parseItemField("account=acct_1:plain")).toEqual({
		field: { name: "account", type: "text", sensitive: false },
		value: "acct_1",
	});
	expect(parseItemField("api_key=sk:1")).toEqual({
		field: { name: "api_key", type: "password", sensitive: true },
		value: "sk:1",
	});
	expect(() => parseItemField("novalue")).toThrow("--field name=value");
});

test("secrets items put, get, list, and delete", async () => {
	const item = {
		id: "it_1",
		environment: "prod",
		path: "/",
		key: "stripe",
		kind: "api",
		version: 1,
		status: "ready",
		fields: [
			{
				name: "account",
				type: "text",
				required: false,
				sensitive: false,
				hasValue: true,
				value: "acct_1",
			},
			{
				name: "api_key",
				type: "password",
				required: false,
				sensitive: true,
				hasValue: true,
			},
		],
		availableOperations: [],
		createdAt: T,
		updatedAt: T,
	};
	const node = fakeNode({
		"PUT /api/vault/items/stripe": () =>
			Response.json({ item }, { status: 201 }),
		"GET /api/vault/items/stripe": { item },
		"GET /api/vault/items": {
			items: [
				{
					id: "it_1",
					environment: "prod",
					path: "/",
					key: "stripe",
					kind: "api",
					version: 1,
					status: "ready",
					fieldCount: 2,
					updatedAt: T,
				},
			],
		},
		"DELETE /api/vault/items/stripe": { deleted: true },
	});
	const run = async (args: string[]) => {
		const cap = makeIo();
		const code = await runCli(["secrets", ...args], {
			api: stubApi(),
			io: cap.io,
			target: node.target,
		});
		return { code, out: cap.out() };
	};
	const put = await run([
		"items",
		"put",
		"stripe",
		"--env",
		"prod",
		"--type",
		"api",
		"--field",
		"account=acct_1:plain",
		"--field",
		"api_key=sk_live_1",
	]);
	expect(put.code).toBe(0);
	expect(put.out).toBe("Stored item stripe (version 1).\n");
	expect(node.calls[0]?.body).toEqual({
		environment: "prod",
		fields: [
			{ name: "account", type: "text", sensitive: false },
			{ name: "api_key", type: "password", sensitive: true },
		],
		values: { account: "acct_1", api_key: "sk_live_1" },
		kind: "api",
	});
	const get = await run(["items", "get", "stripe"]);
	expect(get.out).toContain("acct_1");
	expect(get.out).toContain("(hidden)");
	expect((await run(["items", "list"])).out).toContain("stripe");
	expect((await run(["items", "delete", "stripe"])).out).toBe(
		"Deleted item stripe.\n"
	);
	expect((await run(["items", "put", "stripe"])).code).toBe(2);
});

const tokenInfo = {
	accessor: "acc_1",
	identityId: "mid_1",
	policies: ["ci"],
	createdAt: T,
	expiresAt: T,
	renewable: true,
	ttlSecs: 3600,
};

test("secrets token lookup/renew, wrap, and unwrap", async () => {
	const node = fakeNode({
		"GET /api/vault/agent/self/lookup": {
			token: tokenInfo,
			effectivePolicies: ["ci"],
		},
		"POST /api/vault/agent/self/renew": { token: tokenInfo },
		"POST /api/vault/tokens/acc_9/renew": { token: tokenInfo },
		"POST /api/vault/secrets/API_KEY/reveal": {
			wrapInfo: {
				token: "rwt_1",
				accessor: "wacc",
				ttlSecs: 300,
				creationPath: "secrets/API_KEY/reveal",
				createdAt: T,
				expiresAt: T,
			},
		},
		"POST /api/vault/sys/wrapping/unwrap": { value: "sk_live_123" },
	});
	const machineEnv = { RYU_VAULT_TOKEN: "rvt_m" };
	const lookup = makeIo();
	expect(
		await runCli(["secrets", "token", "lookup"], {
			api: stubApi(),
			env: machineEnv,
			io: lookup.io,
			target: node.target,
		})
	).toBe(0);
	expect(lookup.out()).toContain("acc_1");
	await runCli(["secrets", "token", "renew", "--increment", "1h"], {
		api: stubApi(),
		env: machineEnv,
		io: makeIo().io,
		target: node.target,
	});
	await runCli(["secrets", "token", "renew", "acc_9"], {
		api: stubApi(),
		env: {},
		io: makeIo().io,
		target: node.target,
	});
	expect(
		await runCli(["secrets", "token", "lookup"], {
			api: stubApi(),
			env: {},
			io: makeIo().io,
			target: node.target,
		})
	).toBe(2);
	const wrapped = makeIo();
	await runCli(["secrets", "wrap", "API_KEY", "--ttl", "5m"], {
		api: stubApi(),
		env: {},
		io: wrapped.io,
		target: node.target,
	});
	expect(wrapped.out()).toBe("rwt_1\n");
	const unwrapped = makeIo();
	await runCli(["secrets", "unwrap", "rwt_1"], {
		api: stubApi(),
		env: {},
		io: unwrapped.io,
		target: node.target,
	});
	expect(unwrapped.out()).toBe("sk_live_123\n");
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"GET /api/vault/agent/self/lookup",
		"POST /api/vault/agent/self/renew",
		"POST /api/vault/tokens/acc_9/renew",
		"POST /api/vault/secrets/API_KEY/reveal",
		"POST /api/vault/sys/wrapping/unwrap",
	]);
	expect(node.calls[1]?.body).toEqual({ incrementSecs: 3600 });
	expect(node.calls[2]?.body).toEqual({});
	expect(node.calls[3]?.headers.get("x-ryu-wrap-ttl")).toBe("5m");
	expect(node.calls[4]?.body).toEqual({ token: "rwt_1" });
	expect(node.calls[4]?.headers.get("authorization")).toBeNull();
});

test("secrets login points vault/bao clients at the /v1 API", async () => {
	const node = fakeNode({
		"POST /api/vault/auth/approle/login": {
			token: {
				token: "rvt_new",
				accessor: "acc_1",
				identityId: "mid_1",
				policies: ["ci"],
				expiresAt: T,
			},
		},
	});
	const cap = makeIo();
	expect(
		await runCli(["secrets", "login", "--approle", "role-1", "secret-1"], {
			api: stubApi(),
			io: cap.io,
			target: node.target,
		})
	).toBe(0);
	expect(cap.out()).toBe("rvt_new\n");
	expect(cap.err()).toContain(
		"export VAULT_ADDR=http://node.test VAULT_TOKEN="
	);
	expect(cap.err()).not.toContain("rvt_new");
});

const cardApproval = {
	id: "cap_1",
	itemId: "itm_1",
	environment: "default",
	path: "/",
	key: "visa",
	brand: "visa",
	last4: "4242",
	channel: "broker",
	merchantHost: "shop.example.com",
	requester: "broker_session:bvs_1",
	agent: "machine:m1",
	status: "pending",
	uses: 0,
	requestedAt: T,
	requestExpiresAt: T,
};

test("secrets items put --type card reads the number and CVC from stdin only", async () => {
	const node = fakeNode({
		"PUT /api/vault/items/visa": () =>
			Response.json(
				{
					item: {
						id: "itm_1",
						environment: "default",
						path: "/",
						key: "visa",
						kind: "card",
						version: 1,
						status: "ready",
						fields: [],
						availableOperations: [],
						card: {
							brand: "visa",
							last4: "4242",
							expired: false,
							merchants: ["shop.example.com"],
							placeholders: {},
						},
						createdAt: T,
						updatedAt: T,
					},
				},
				{ status: 201 }
			),
	});
	const run = async (args: string[], stdin: string | null) => {
		const cap = makeIo();
		const code = await runCli(["secrets", ...args], {
			api: stubApi(),
			io: cap.io,
			readStdin: () => Promise.resolve(stdin),
			target: node.target,
		});
		return { code, out: cap.out(), err: cap.err() };
	};
	const base = [
		"items",
		"put",
		"visa",
		"--type",
		"card",
		"--cardholder",
		"Ada Lovelace",
		"--exp",
		"07/31",
		"--merchant",
		"shop.example.com",
		"--merchant",
		"*.pay.example",
		"--country",
		"us",
	];
	const put = await run(base, "4242 4242 4242 4242\n123\n");
	expect(put.code).toBe(0);
	expect(put.out).toBe("Stored card visa (visa ending 4242, version 1).\n");
	expect(node.calls[0]?.body).toEqual({
		kind: "card",
		merchants: ["shop.example.com", "*.pay.example"],
		values: {
			cardholder: "Ada Lovelace",
			number: "4242 4242 4242 4242",
			expMonth: "07",
			expYear: "31",
			cvc: "123",
			country: "us",
		},
	});
	// A terminal stdin, a card number argument, or --field are refused
	// before anything is sent.
	expect((await run(base, null)).code).toBe(2);
	expect((await run([...base, "--number", "4242"], "x\n")).code).toBe(2);
	expect((await run([...base, "--cvc=123"], "x\n")).code).toBe(2);
	expect((await run([...base, "--field", "a=b"], "x\n")).code).toBe(2);
	expect((await run(base, "1\n2\n3\n")).code).toBe(2);
	expect(node.calls).toHaveLength(1);
});

test("secrets cards approvals list, approve, reject, and revoke", async () => {
	const node = fakeNode({
		"GET /api/vault/cards/approvals": { approvals: [cardApproval] },
		"POST /api/vault/cards/approvals/cap_1/approve": {
			approval: {
				...cardApproval,
				status: "approved",
				mode: "grant",
				grantSubject: "machine:m1",
				maxUses: 3,
			},
		},
		"POST /api/vault/cards/approvals/cap_1/reject": {
			approval: { ...cardApproval, status: "rejected" },
		},
		"POST /api/vault/cards/approvals/cap_1/revoke": {
			approval: { ...cardApproval, status: "revoked" },
		},
		"POST /api/vault/items/visa/reveal": () =>
			Response.json(
				{
					ok: true,
					status: "approval_required",
					approval: { ...cardApproval, channel: "reveal", merchantHost: "" },
					approvePath: "/api/vault/cards/approvals/cap_1/approve",
				},
				{ status: 202 }
			),
	});
	const run = async (args: string[]) => {
		const cap = makeIo();
		const code = await runCli(["secrets", ...args], {
			api: stubApi(),
			io: cap.io,
			target: node.target,
		});
		return { code, out: cap.out(), err: cap.err() };
	};
	const listed = await run(["cards", "approvals", "--env", "default"]);
	expect(listed.code).toBe(0);
	expect(listed.out).toContain("shop.example.com");
	expect(listed.out).toContain("visa 4242");
	const approved = await run([
		"cards",
		"approvals",
		"approve",
		"cap_1",
		"--mode",
		"grant",
		"--subject",
		"agent",
		"--ttl",
		"30m",
		"--max-uses",
		"3",
	]);
	expect(approved.out).toBe(
		"Approved card approval cap_1 (grant for machine:m1 at shop.example.com, 3 uses).\n"
	);
	expect(
		(await run(["cards", "approvals", "reject", "cap_1", "--reason", "no"])).out
	).toBe("Rejected card approval cap_1.\n");
	expect((await run(["cards", "approvals", "revoke", "cap_1"])).code).toBe(0);
	expect(
		(await run(["cards", "approvals", "approve", "cap_1", "--mode", "x"])).code
	).toBe(2);
	const reveal = await run(["items", "reveal", "visa", "number"]);
	expect(reveal.code).toBe(1);
	expect(reveal.out).toBe("");
	expect(reveal.err).toContain("ryu secrets cards approvals approve cap_1");
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"GET /api/vault/cards/approvals?status=pending&environment=default",
		"POST /api/vault/cards/approvals/cap_1/approve",
		"POST /api/vault/cards/approvals/cap_1/reject",
		"POST /api/vault/cards/approvals/cap_1/revoke",
		"POST /api/vault/items/visa/reveal",
	]);
	expect(node.calls[1]?.body).toEqual({
		mode: "grant",
		subject: "agent",
		ttlSecs: 1800,
		maxUses: 3,
	});
	expect(node.calls[2]?.body).toEqual({ note: "no" });
});

const pmAccount = {
	id: "pma_1",
	name: "work",
	provider: "bitwarden-sm",
	address: null,
	binaryPath: "/usr/local/bin/bws",
	state: "connected",
	lastError: null,
	lastCheckedAt: null,
	createdAt: T,
	updatedAt: T,
};
const pmApproval = {
	id: "bpr_1",
	environment: "default",
	status: "pending",
	message: "user:u1 asks to use bws://work@x",
	services: [],
	credentials: [],
	requestedBy: "user:u1",
	createdAt: T,
	expiresAt: T,
	credentialUse: {
		ref: "bws://work@2b7f2c5e-1a3d-4c4e-9b8a-0123456789ab",
		accountId: "pma_1",
		account: "work",
		provider: "bitwarden-sm",
		subject: "user:u1",
	},
};
const pmGrant = {
	id: "pmg_1",
	subject: "user:u1",
	accountId: "pma_1",
	account: "work",
	ref: "bws://work@2b7f2c5e-1a3d-4c4e-9b8a-0123456789ab",
	mode: "24h",
	usesRemaining: null,
	expiresAt: T,
	grantedBy: "operator",
	proposalId: "bpr_1",
	createdAt: T,
	revokedAt: null,
};

test("secrets pm add reads the token from stdin only and manages accounts", async () => {
	const node = fakeNode({
		"GET /api/vault/password-managers/accounts": { accounts: [pmAccount] },
		"POST /api/vault/password-managers/accounts": { account: pmAccount },
		"POST /api/vault/password-managers/accounts/pma_1/test": {
			ok: false,
			error: "`bws` rejected the account token (exited with status 1)",
			account: { ...pmAccount, state: "reconnect_required" },
		},
		"POST /api/vault/password-managers/accounts/pma_1/token": {
			account: pmAccount,
		},
		"DELETE /api/vault/password-managers/accounts/pma_1": { deleted: true },
	});
	const run = async (args: string[], stdin: string | null = null) => {
		const cap = makeIo();
		const code = await runCli(["secrets", "pm", ...args], {
			api: stubApi(),
			io: cap.io,
			readStdin: () => Promise.resolve(stdin),
			target: node.target,
		});
		return { code, out: cap.out(), err: cap.err() };
	};
	// No token on a terminal: refused before any call.
	const tty = await run(["add", "work", "--provider", "bitwarden-sm"]);
	expect(tty.code).toBe(2);
	expect(tty.err).toContain("never accepted as an argument");
	expect(
		(await run(["add", "work", "--provider", "lastpass"], "t\n")).code
	).toBe(2);
	const added = await run(
		["add", "work", "--provider", "bitwarden-sm"],
		"bws-token-1\n"
	);
	expect(added.code).toBe(0);
	expect(added.out).not.toContain("bws-token-1");
	const listed = await run(["accounts"]);
	expect(listed.out).toContain("bitwarden-sm");
	const tested = await run(["test", "work"]);
	expect(tested.code).toBe(1);
	expect(tested.err).toContain("reconnect_required");
	expect((await run(["reconnect", "work"], "bws-token-2\n")).code).toBe(0);
	expect((await run(["remove", "work"])).code).toBe(0);
	expect((await run(["test", "missing"])).code).toBe(2);
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /api/vault/password-managers/accounts",
		"GET /api/vault/password-managers/accounts",
		"GET /api/vault/password-managers/accounts",
		"POST /api/vault/password-managers/accounts/pma_1/test",
		"GET /api/vault/password-managers/accounts",
		"POST /api/vault/password-managers/accounts/pma_1/token",
		"GET /api/vault/password-managers/accounts",
		"DELETE /api/vault/password-managers/accounts/pma_1",
		"GET /api/vault/password-managers/accounts",
	]);
	expect(node.calls[0]?.body).toEqual({
		name: "work",
		provider: "bitwarden-sm",
		token: "bws-token-1",
	});
	expect(node.calls[5]?.body).toEqual({ token: "bws-token-2" });
	expect(node.calls.some((call) => call.path.includes("bws-token"))).toBe(
		false
	);
});

test("secrets pm read waits for approval, and approvals and grants are managed", async () => {
	let approved = false;
	const node = fakeNode({
		"POST /api/vault/password-managers/read": () =>
			approved
				? Response.json({
						value: "bw-secret-value",
						ref: pmGrant.ref,
						account: "work",
						provider: "bitwarden-sm",
					})
				: Response.json(
						{ pending: true, approval: pmApproval },
						{ status: 202 }
					),
		"GET /api/vault/password-managers/approvals": { approvals: [pmApproval] },
		"POST /api/vault/password-managers/approvals/bpr_1/approve": () => {
			approved = true;
			return Response.json({
				approved: true,
				proposal: "bpr_1",
				grant: pmGrant,
			});
		},
		"POST /api/vault/password-managers/approvals/bpr_1/reject": {
			rejected: true,
		},
		"GET /api/vault/password-managers/grants": { grants: [pmGrant] },
		"DELETE /api/vault/password-managers/grants/pmg_1": {
			revoked: true,
			grant: { ...pmGrant, revokedAt: T },
		},
	});
	const run = async (args: string[]) => {
		const cap = makeIo();
		const code = await runCli(["secrets", "pm", ...args], {
			api: stubApi(),
			io: cap.io,
			target: node.target,
		});
		return { code, out: cap.out(), err: cap.err() };
	};
	const ref = "bws://2b7f2c5e-1a3d-4c4e-9b8a-0123456789ab";
	const waiting = await run(["read", ref, "--env", "prod"]);
	expect(waiting.code).toBe(3);
	expect(waiting.out).toBe("");
	expect(waiting.err).toContain("bpr_1");
	const listed = await run(["approvals"]);
	expect(listed.out).toContain("user:u1");
	expect(
		(await run(["approvals", "approve", "bpr_1", "--grant", "weekly"])).code
	).toBe(2);
	const decided = await run([
		"approvals",
		"approve",
		"bpr_1",
		"--grant",
		"24h",
	]);
	expect(decided.out).toContain("(24h)");
	const read = await run(["read", ref]);
	expect(read.code).toBe(0);
	expect(read.out).toBe("bw-secret-value\n");
	await run(["approvals", "reject", "bpr_1", "--reason", "no"]);
	expect((await run(["grants", "--all"])).out).toContain("pmg_1");
	expect((await run(["grants", "revoke", "pmg_1"])).out).toContain(
		"must ask again"
	);
	expect(node.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"POST /api/vault/password-managers/read",
		"GET /api/vault/password-managers/approvals?status=pending",
		"POST /api/vault/password-managers/approvals/bpr_1/approve",
		"POST /api/vault/password-managers/read",
		"POST /api/vault/password-managers/approvals/bpr_1/reject",
		"GET /api/vault/password-managers/grants?all=true",
		"DELETE /api/vault/password-managers/grants/pmg_1",
	]);
	expect(node.calls[0]?.body).toEqual({ ref, environment: "prod" });
	expect(node.calls[2]?.body).toEqual({ grant: "24h" });
	expect(node.calls[4]?.body).toEqual({ note: "no" });
});

// ── Shared values that need a step-up ────────────────────────────────────────

const stepUpRefusal = (): Response =>
	Response.json(
		{
			action: "change or reveal access keys and shared secrets",
			enrolmentRequired: false,
			error: "STEP_UP_REQUIRED",
			message: "Verify your identity to continue",
			methods: ["totp", "otp"],
			scope: "org.credentials",
		},
		{ status: 403 }
	);

test("secrets get, export and run refuse with how to confirm when shared values need a step-up", async () => {
	for (const argv of [
		["secrets", "get", "API_KEY"],
		["secrets", "export"],
		["secrets", "run", "--", "node", "app.js"],
	]) {
		const cap = makeIo();
		const node = fakeNode({
			"POST /api/vault/export": stepUpRefusal,
			"POST /api/vault/secrets/API_KEY/reveal": stepUpRefusal,
		});
		let spawned = false;
		const code = await runCli(argv, {
			api: stubApi(),
			env: {},
			io: cap.io,
			spawn: () => {
				spawned = true;
				return Promise.resolve(0);
			},
			target: node.target,
		});
		expect(code).toBe(1);
		// No partial export: the child never starts without the shared values.
		expect(spawned).toBe(false);
		expect(cap.out()).toBe("");
		expect(cap.err()).toContain("ryu secrets confirm");
	}
});

const sessionEnv = {
	RYU_AUTH_URL: "http://auth.test",
	RYU_IDENTITY_CORE_URL: "http://node.test",
};
const signedIn = {
	authenticated: true,
	pending: false,
	token: "core-session",
	userCode: null,
	verificationUri: null,
};

test("secrets confirm proves a factor on the local Core's session", async () => {
	const cap = makeIo();
	const node = fakeNode({
		"GET /api/auth/status": signedIn,
		"GET /api/step-up/status": {
			enrolmentRequired: false,
			methods: ["otp", "totp"],
			satisfied: false,
			windowMs: 600_000,
		},
		"POST /api/step-up/verify": {
			expiresAt: T,
			scope: "org.credentials",
			verified: true,
		},
	});
	const code = await runCli(
		["secrets", "confirm", "123456", "--method", "totp"],
		{ api: stubApi(), env: sessionEnv, io: cap.io, target: node.target }
	);
	expect(code).toBe(0);
	expect(cap.err()).toContain("Confirmed for the next 10 minutes");
	const verify = node.calls.find((call) => call.path === "/api/step-up/verify");
	expect(verify?.body).toEqual({
		scope: "org.credentials",
		method: "totp",
		code: "123456",
	});
	// The step-up goes to the control plane with the local Core's session.
	expect(verify?.headers.get("authorization")).toBe("Bearer core-session");
	const status = node.calls.find((call) =>
		call.path.startsWith("/api/step-up/status")
	);
	expect(status?.path).toBe("/api/step-up/status?scope=org.credentials");
	// An authenticator code marks the session as two-factor, so the local Core
	// mints a new user JWT that carries organizations requiring it.
	const refreshed = node.calls.find((call) =>
		call.path.startsWith("/api/auth/user-jwt")
	);
	expect(refreshed?.path).toBe("/api/auth/user-jwt?fresh=true");
});

test("secrets confirm emails a code, refuses a password argument, and needs a sign-in", async () => {
	const routes = {
		"GET /api/auth/status": signedIn,
		"GET /api/step-up/status": {
			enrolmentRequired: false,
			methods: ["otp", "password"],
			satisfied: false,
		},
		"POST /api/step-up/challenge": { sent: true },
	};
	const emailed = makeIo();
	const node = fakeNode(routes);
	expect(
		await runCli(["secrets", "confirm"], {
			api: stubApi(),
			env: sessionEnv,
			io: emailed.io,
			readStdin: () => Promise.resolve(null),
			target: node.target,
		})
	).toBe(0);
	expect(emailed.err()).toContain("ryu secrets confirm CODE --method otp");
	expect(
		node.calls.find((call) => call.path === "/api/step-up/challenge")?.body
	).toEqual({ scope: "org.credentials", method: "otp" });
	expect(node.calls.some((call) => call.path === "/api/step-up/verify")).toBe(
		false
	);

	const password = makeIo();
	const passwordNode = fakeNode(routes);
	expect(
		await runCli(["secrets", "confirm", "hunter2", "--method", "password"], {
			api: stubApi(),
			env: sessionEnv,
			io: password.io,
			target: passwordNode.target,
		})
	).toBe(2);
	expect(password.err()).toContain("Pipe the password on stdin");
	expect(
		passwordNode.calls.some((call) => call.path === "/api/step-up/verify")
	).toBe(false);

	const signedOut = makeIo();
	expect(
		await runCli(["secrets", "confirm", "123456"], {
			api: stubApi(),
			env: sessionEnv,
			io: signedOut.io,
			target: fakeNode({
				"GET /api/auth/status": {
					...signedIn,
					authenticated: false,
					token: null,
				},
			}).target,
		})
	).toBe(1);
	expect(signedOut.err()).toContain("ryu login");
});

/** Record each request's full URL and bearer, then answer from `target`. */
function recordingUrls(target: ApiTarget) {
	const seen: { authorization: string | null; url: string }[] = [];
	const inner = target.fetch;
	if (!inner) {
		throw new Error("fakeNode always provides fetch");
	}
	const recorded: ApiTarget = {
		...target,
		fetch: (input, init) => {
			seen.push({
				authorization: new Headers(init?.headers).get("authorization"),
				url: String(input),
			});
			return inner(input, init);
		},
	};
	return { recorded, seen };
}

test("secrets confirm with a remote target proves on this machine's account session", async () => {
	const cap = makeIo();
	const remote = fakeNode(
		{
			"GET /api/auth/status": signedIn,
			"GET /api/step-up/status": {
				enrolmentRequired: false,
				// The emailed code is listed first; a typed numeric code is still
				// an authenticator code.
				methods: ["otp", "totp"],
				satisfied: false,
			},
			"POST /api/step-up/verify": {
				expiresAt: T,
				scope: "org.credentials",
				verified: true,
			},
		},
		"https://remote.example"
	);
	const { recorded, seen } = recordingUrls(remote.target);
	const code = await runCli(["secrets", "confirm", "123456"], {
		api: stubApi(),
		env: { RYU_AUTH_URL: "http://auth.test", RYU_TOKEN: "local-owner" },
		io: cap.io,
		target: recorded,
	});
	expect(code).toBe(0);
	const status = seen.find((call) => call.url.endsWith("/api/auth/status"));
	// The session comes from the local Core with its own token, never from the
	// remote node and never with the remote node's token.
	expect(status?.url).toBe(`${DEFAULT_CORE_URL}/api/auth/status`);
	expect(status?.authorization).toBe("Bearer local-owner");
	expect(
		seen.some((call) => call.url.startsWith("https://remote.example"))
	).toBe(false);
	const verify = seen.find((call) => call.url.endsWith("/api/step-up/verify"));
	expect(verify?.url).toBe("http://auth.test/api/step-up/verify");
	expect(verify?.authorization).toBe("Bearer core-session");
	expect(
		remote.calls.find((call) => call.path === "/api/step-up/verify")?.body
	).toEqual({ scope: "org.credentials", method: "totp", code: "123456" });
});

test("secrets confirm with a remote target falls back to the token the local Core minted", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "ryu-confirm-minted-"));
	try {
		await mkdir(join(dataDir, "secrets"), { recursive: true });
		await writeFile(
			join(dataDir, "secrets", "node-auth.token"),
			"minted-owner\n"
		);
		const remote = fakeNode(
			{
				"GET /api/auth/status": signedIn,
				"GET /api/step-up/status": {
					enrolmentRequired: false,
					methods: ["totp"],
					satisfied: true,
				},
			},
			"https://remote.example"
		);
		const { recorded, seen } = recordingUrls(remote.target);
		expect(
			await runCli(["secrets", "confirm"], {
				api: stubApi(),
				// The same bearer the identity broker gives `get`, `export` and `run`.
				env: { RYU_AUTH_URL: "http://auth.test", RYU_DIR: dataDir },
				io: makeIo().io,
				target: recorded,
			})
		).toBe(0);
		const status = seen.find((call) => call.url.endsWith("/api/auth/status"));
		expect(status?.url).toBe(`${DEFAULT_CORE_URL}/api/auth/status`);
		expect(status?.authorization).toBe("Bearer minted-owner");
	} finally {
		await rm(dataDir, { force: true, recursive: true });
	}
});

test("secrets confirm explains a forwarding tunnel and a refused local Core", async () => {
	const tunnel = makeIo();
	expect(
		await runCli(["secrets", "confirm", "123456"], {
			api: stubApi(),
			env: sessionEnv,
			io: tunnel.io,
			target: fakeNode({
				// What Core answers every caller while a forwarding tunnel runs.
				"GET /api/auth/status": { ...signedIn, token: null },
			}).target,
		})
	).toBe(1);
	expect(tunnel.err()).toContain("forwarding tunnel");
	expect(tunnel.err()).toContain("Stop the tunnel");
	expect(tunnel.err()).not.toContain("ryu login");

	const refused = makeIo();
	expect(
		await runCli(["secrets", "confirm", "123456"], {
			api: stubApi(),
			env: sessionEnv,
			io: refused.io,
			target: fakeNode({
				"GET /api/auth/status": () =>
					Response.json({ error: "unauthorized" }, { status: 401 }),
			}).target,
		})
	).toBe(1);
	expect(refused.err()).toContain("RYU_IDENTITY_CORE_TOKEN");
});

test("secrets confirm keeps a piped password as typed and reads a backup code", async () => {
	const routes = (methods: string[]) => ({
		"GET /api/auth/status": signedIn,
		"GET /api/step-up/status": {
			enrolmentRequired: false,
			methods,
			satisfied: false,
		},
		"POST /api/step-up/verify": {
			expiresAt: T,
			scope: "org.credentials",
			verified: true,
		},
	});
	const passwordNode = fakeNode(routes(["password"]));
	expect(
		await runCli(["secrets", "confirm", "--method", "password"], {
			api: stubApi(),
			env: sessionEnv,
			io: makeIo().io,
			readStdin: () => Promise.resolve("  pass word \n"),
			target: passwordNode.target,
		})
	).toBe(0);
	// Only the line ending the pipe added is dropped.
	expect(
		passwordNode.calls.find((call) => call.path === "/api/step-up/verify")?.body
	).toEqual({
		scope: "org.credentials",
		method: "password",
		code: "  pass word ",
	});

	const backupNode = fakeNode(routes(["otp", "totp", "backup"]));
	expect(
		await runCli(["secrets", "confirm", "abcd-efgh"], {
			api: stubApi(),
			env: sessionEnv,
			io: makeIo().io,
			target: backupNode.target,
		})
	).toBe(0);
	expect(
		backupNode.calls.find((call) => call.path === "/api/step-up/verify")?.body
	).toEqual({ scope: "org.credentials", method: "backup", code: "abcd-efgh" });
});
