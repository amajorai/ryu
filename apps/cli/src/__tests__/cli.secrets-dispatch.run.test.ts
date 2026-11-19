// `ryu secrets …` dispatch tests: run, login and the agent-token routes. Core is faked through the
// target's injected `fetch`, child processes through `spawn`, and stdin
// through `readStdin`, so nothing touches a node, spawns, or reads the real
// terminal. Shared fixtures are in `secrets-dispatch-fixture.ts`.

import { expect, test } from "bun:test";
import { runCli } from "../cli/dispatch.ts";

import {
	exportResponse,
	fakeNode,
	issuedToken,
	makeIo,
	type SpawnCapture,
	stubApi,
} from "./secrets-dispatch-fixture.ts";

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
