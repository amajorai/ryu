// `ryu secrets agent` auto-auth: logins per method, when a renewal means
// "log in again", and token sinks.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentContext,
	authenticate,
	canLogInAgain,
	renewToken,
	writeSinks,
} from "../cli/secrets-agentd-auth.ts";
import { issuedToken, tokenInfo } from "./secrets-agentd-fixture.ts";
import { fakeNode, type Responder } from "./secrets-fixture.ts";

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-agentd-auth-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function context(
	routes: Record<string, Responder>,
	env: Record<string, string> = {}
) {
	const node = fakeNode(routes);
	const ctx: AgentContext = {
		env,
		io: { out: () => undefined, err: () => undefined },
		spawn: () => Promise.resolve(0),
		target: node.target,
	};
	return { ctx, node };
}

const lookup: Responder = () =>
	Response.json({ token: tokenInfo(90_000), effectivePolicies: ["app"] });

describe("authenticate", () => {
	test("jwt reads the JWT file and looks up the new token", async () => {
		await writeFile(join(dir, "jwt"), "eyJ.token.sig\n");
		const { ctx, node } = context({
			"POST /api/vault/auth/jwt/login": () =>
				Response.json(issuedToken("rvt_jwt")),
			"GET /api/vault/agent/self/lookup": lookup,
		});
		const state = await authenticate(ctx, {
			kind: "jwt",
			identity: "ci",
			jwtFile: join(dir, "jwt"),
		});
		expect(state).toEqual({
			token: "rvt_jwt",
			renewable: true,
			expiresAtMs: 90_000,
		});
		expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({
			identity: "ci",
			jwt: "eyJ.token.sig",
		});
		expect(node.calls[1]?.headers.get("x-ryu-vault-token")).toBe("rvt_jwt");
	});

	test("token and env methods log in without a login route", async () => {
		await writeFile(join(dir, "token"), "rvt_file\n");
		const { ctx } = context(
			{ "GET /api/vault/agent/self/lookup": lookup },
			{ RYU_VAULT_TOKEN: "rvt_env" }
		);
		expect(
			(
				await authenticate(ctx, {
					kind: "token",
					tokenFile: join(dir, "token"),
				})
			).token
		).toBe("rvt_file");
		expect((await authenticate(ctx, { kind: "env" })).token).toBe("rvt_env");
		expect(canLogInAgain({ kind: "env" })).toBe(false);
		expect(canLogInAgain({ kind: "token", tokenFile: "t" })).toBe(true);
	});

	test("env without RYU_VAULT_TOKEN is a usage error", async () => {
		const { ctx } = context({});
		await expect(authenticate(ctx, { kind: "env" })).rejects.toThrow(
			"RYU_VAULT_TOKEN is not set"
		);
	});
});

describe("renewToken", () => {
	const current = { token: "rvt_1", renewable: true, expiresAtMs: 90_000 };

	test("an extended expiry is the renewed state", async () => {
		const { ctx } = context({
			"POST /api/vault/agent/self/renew": () =>
				Response.json({ token: tokenInfo(150_000) }),
		});
		expect(await renewToken(ctx, current)).toEqual({
			token: "rvt_1",
			renewable: true,
			expiresAtMs: 150_000,
		});
	});

	test("no extension, a refusal or a non-renewable token mean log in again", async () => {
		const { ctx } = context({
			"POST /api/vault/agent/self/renew": () =>
				Response.json({ token: tokenInfo(90_000) }),
		});
		expect(await renewToken(ctx, current)).toBeNull();
		const refused = context({
			"POST /api/vault/agent/self/renew": () =>
				Response.json({ error: "expired" }, { status: 403 }),
		});
		expect(await renewToken(refused.ctx, current)).toBeNull();
		const untouched = context({});
		expect(
			await renewToken(untouched.ctx, { ...current, renewable: false })
		).toBeNull();
		expect(untouched.node.calls).toEqual([]);
	});

	test("an outage is thrown so the caller retries", async () => {
		const { ctx } = context({
			"POST /api/vault/agent/self/renew": () =>
				Response.json({ error: "down" }, { status: 503 }),
		});
		await expect(renewToken(ctx, current)).rejects.toThrow();
	});
});

test("writeSinks writes the token to every sink", async () => {
	const sinks = [
		{ path: join(dir, "a"), mode: 0o600 },
		{ path: join(dir, "b"), mode: 0o600 },
	];
	await writeSinks(sinks, "rvt_x");
	expect(await readFile(join(dir, "a"), "utf8")).toBe("rvt_x");
	expect(await readFile(join(dir, "b"), "utf8")).toBe("rvt_x");
});
