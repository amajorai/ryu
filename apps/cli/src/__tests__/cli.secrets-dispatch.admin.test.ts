// `ryu secrets …` dispatch tests: env, policy, approvals, audit, seal, help, broker admin and TOTP. Core is faked through the
// target's injected `fetch`, child processes through `spawn`, and stdin
// through `readStdin`, so nothing touches a node, spawns, or reads the real
// terminal. Shared fixtures are in `secrets-dispatch-fixture.ts`.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli/dispatch.ts";

import {
	CA_PEM,
	type Call,
	changeRequest,
	fakeNode,
	makeIo,
	seal,
	stubApi,
	T,
} from "./secrets-dispatch-fixture.ts";

let tempDir: string | null = null;
afterEach(async () => {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
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
