// `ryu secrets …` dispatch tests: typed items, tokens, wrapping and the /v1 login hint. Core is faked through the
// target's injected `fetch`, child processes through `spawn`, and stdin
// through `readStdin`, so nothing touches a node, spawns, or reads the real
// terminal. Shared fixtures are in `secrets-dispatch-fixture.ts`.

import { expect, test } from "bun:test";
import { runCli } from "../cli/dispatch.ts";
import { parseItemField } from "../cli/secrets.ts";

import { fakeNode, makeIo, stubApi, T } from "./secrets-dispatch-fixture.ts";

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
