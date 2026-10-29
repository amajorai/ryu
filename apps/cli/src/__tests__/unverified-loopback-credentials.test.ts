// Credentials other than the node bearer must not reach a local plain-HTTP
// listener that has not proved it is Core. A target with no node token cannot
// be checked at all, so its transport strips every credential header, and the
// vault machine commands refuse it outright (they would otherwise send the
// vault token, an AppRole secret or a wrapping token, and trust the answers).
// Each test runs a real loopback squatter and asserts what it actually saw.

import { afterEach, expect, test } from "bun:test";
import { type ApiTarget, fetchForTarget } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import type { CliIO, CoreApi } from "../cli/types.ts";
import {
	CORE_IDENTITY_PATH,
	coreIdentityProof,
	setLoopbackConnectorForTests,
	UnverifiableCoreError,
	withCoreIdentityCheck,
} from "../core/coreIdentity.ts";

afterEach(() => {
	setLoopbackConnectorForTests(null);
});

const VAULT_TOKEN = "rvt_victim_vault_token";
const WRAP_TOKEN = "rvw_victim_wrap_token";
const NODE_TOKEN = "victim-node-token";
const SECRET_HEADERS = {
	authorization: "Bearer victim-node-token",
	cookie: "session=victim-cookie",
	"proxy-authorization": "Basic victim-proxy",
	"x-ryu-buyer-token": "victim-buyer-session",
	"x-ryu-node-token": "victim-node-token",
	"x-ryu-user-jwt": "victim-user-jwt",
	"x-ryu-vault-token": VAULT_TOKEN,
	"x-vault-token": "victim-hashicorp-token",
} as const;

interface Seen {
	body: string;
	headers: Record<string, string>;
	path: string;
}

/** A real loopback listener that records every request. With `prove`, it
 *  answers the identity challenge as a Core holding `NODE_TOKEN` would. */
function listener(prove: boolean) {
	const seen: Seen[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request): Promise<Response> {
			const url = new URL(request.url);
			const headers: Record<string, string> = {};
			request.headers.forEach((value, name) => {
				headers[name] = value;
			});
			seen.push({ body: await request.text(), headers, path: url.pathname });
			if (url.pathname === CORE_IDENTITY_PATH && prove) {
				const nonce = url.searchParams.get("nonce") ?? "";
				return Response.json({
					proof: coreIdentityProof(
						NODE_TOKEN,
						"127.0.0.1",
						server.port ?? 0,
						nonce
					),
				});
			}
			if (url.pathname === "/api/vault/agent/secrets/DB_URL") {
				return Response.json({ value: "attacker-chosen-value" });
			}
			return Response.json({ error: "no route" }, { status: 404 });
		},
	});
	return { seen, server, url: `http://127.0.0.1:${server.port}` };
}

function capture() {
	let out = "";
	let err = "";
	const io: CliIO = {
		err: (text) => {
			err += text;
		},
		out: (text) => {
			out += text;
		},
	};
	return { err: () => err, io, out: () => out };
}

function noApi(): CoreApi {
	const notCalled = () => Promise.reject(new Error("unexpected CoreApi call"));
	return {
		disableApp: notCalled,
		enableApp: notCalled,
		execAppCommand: notCalled,
		fetchApps: notCalled,
		fetchAppsCatalog: notCalled,
		installApp: notCalled,
		streamChat: notCalled,
		uninstallApp: notCalled,
	};
}

test("a loopback target with no node token sends no credential header of any kind", async () => {
	const squatter = listener(false);
	try {
		const target = withCoreIdentityCheck<ApiTarget>({
			token: null,
			url: squatter.url,
		});
		await fetchForTarget(target)(`${squatter.url}/api/vault/agent/self`, {
			headers: SECRET_HEADERS,
		});
		await fetchForTarget(target)(
			new Request(`${squatter.url}/api/vault/agent/self`, {
				headers: SECRET_HEADERS,
			})
		);
		// A verified-Core target re-aimed at another origin is stripped the same way.
		const other = withCoreIdentityCheck<ApiTarget>({
			token: NODE_TOKEN,
			url: "http://127.0.0.1:1",
		});
		await fetchForTarget(other)(
			new Request(`${squatter.url}/api/vault/agent/self`, {
				headers: SECRET_HEADERS,
			})
		);
		expect(squatter.seen).toHaveLength(3);
		for (const request of squatter.seen) {
			for (const name of Object.keys(SECRET_HEADERS)) {
				expect(request.headers[name]).toBeUndefined();
			}
			expect(JSON.stringify(request)).not.toContain("victim");
		}
	} finally {
		squatter.server.stop(true);
	}
});

test("RYU_VAULT_TOKEN, wrap tokens and AppRole secrets are not sent to an unverifiable local address", async () => {
	const squatter = listener(false);
	try {
		const target = withCoreIdentityCheck<ApiTarget>({
			token: null,
			url: squatter.url,
		});
		const env = { RYU_VAULT_TOKEN: VAULT_TOKEN };
		const runs = [
			["secrets", "get", "DB_URL"],
			["secrets", "run", "--", "migrate"],
			["secrets", "unwrap", WRAP_TOKEN],
			["secrets", "login", "--approle", "role_victim", "sid_victim_secret"],
		];
		let spawned = false;
		for (const argv of runs) {
			const io = capture();
			const code = await runCli(argv, {
				api: noApi(),
				env,
				io: io.io,
				spawn: () => {
					spawned = true;
					return Promise.resolve(0);
				},
				target,
			});
			expect(code).toBe(1);
			expect(io.out()).not.toContain("attacker-chosen-value");
			expect(io.err()).toContain("cannot check that the process answering");
			expect(io.err()).toContain("RYU_CORE_TOKEN");
		}
		expect(spawned).toBe(false);
		expect(squatter.seen).toEqual([]);
		expect(new UnverifiableCoreError(squatter.url).message).toContain(
			"https://"
		);
	} finally {
		squatter.server.stop(true);
	}
});

test("with a node token, the vault token is sent only to a listener that proved it is Core", async () => {
	const env = { RYU_VAULT_TOKEN: VAULT_TOKEN };
	const squatter = listener(false);
	try {
		const io = capture();
		const code = await runCli(["secrets", "get", "DB_URL"], {
			api: noApi(),
			env,
			io: io.io,
			target: withCoreIdentityCheck({ token: NODE_TOKEN, url: squatter.url }),
		});
		expect(code).toBe(1);
		expect(io.err()).toContain("could not prove it is your Ryu Core");
		expect(squatter.seen.map((request) => request.path)).toEqual([
			CORE_IDENTITY_PATH,
		]);
		expect(JSON.stringify(squatter.seen)).not.toContain(VAULT_TOKEN);
		expect(JSON.stringify(squatter.seen)).not.toContain(NODE_TOKEN);
	} finally {
		squatter.server.stop(true);
	}

	const core = listener(true);
	try {
		const io = capture();
		const code = await runCli(["secrets", "get", "DB_URL"], {
			api: noApi(),
			env,
			io: io.io,
			target: withCoreIdentityCheck({ token: NODE_TOKEN, url: core.url }),
		});
		expect(io.err()).toBe("");
		expect(code).toBe(0);
		expect(core.seen.map((request) => request.path)).toEqual([
			CORE_IDENTITY_PATH,
			"/api/vault/agent/secrets/DB_URL",
		]);
		expect(core.seen[0]?.headers["x-ryu-vault-token"]).toBeUndefined();
		expect(core.seen[1]?.headers["x-ryu-vault-token"]).toBe(VAULT_TOKEN);
	} finally {
		core.server.stop(true);
	}
});
