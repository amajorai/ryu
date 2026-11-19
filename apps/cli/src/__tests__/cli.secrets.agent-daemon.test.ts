// `ryu-cli secrets agent`: auto-auth, token sinks, templates, re-render on a
// vault change event, exec only on change, clean stop on SIGINT, and lease and
// token renewal under a fake clock. Core is a fake node (`fakeNode`) whose
// event stream the test controls.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentConfig } from "../cli/secrets-agentd-config.ts";
import { runAgentDaemon } from "../cli/secrets-agentd-daemon.ts";
import type { CliIO, ProcessRunner } from "../cli/types.ts";
import { defaultContainerHost } from "../cli/vaultIsolation.ts";
import {
	agentLease,
	fakeClock,
	issuedToken,
	tokenInfo,
} from "./secrets-agentd-fixture.ts";
import {
	fakeNode,
	jsonExport,
	type NodeCall,
	type Responder,
	runSecrets,
} from "./secrets-fixture.ts";

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-agentd-"));
	await writeFile(join(dir, "secret-id"), "sid-1\n");
	await writeFile(
		join(dir, "app.env.tpl"),
		"API_KEY={{secret:API_KEY}}\nDB_PASSWORD={{lease:db.password}}\n"
	);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeConfig(extra: Record<string, unknown> = {}) {
	const file = join(dir, "agent.json");
	await writeFile(
		file,
		JSON.stringify({
			version: 1,
			environment: "prod",
			auth: { method: "approle", roleId: "role-1", secretIdFile: "secret-id" },
			sinks: [{ path: "vault-token" }],
			leases: [{ name: "db", role: "postgres-ro" }],
			templates: [
				{
					source: "app.env.tpl",
					destination: "app.env",
					command: ["reload-app"],
				},
			],
			...extra,
		})
	);
	return file;
}

function sseStream(signal: AbortSignal | null | undefined) {
	const encoder = new TextEncoder();
	let push: (frame: string) => void = () => undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			push = (frame) => controller.enqueue(encoder.encode(frame));
			signal?.addEventListener("abort", () => controller.close(), {
				once: true,
			});
		},
	});
	return { body, push: (frame: string) => push(frame) };
}

/** A node serving login, lookup, one lease role, export and an event stream. */
function agentNode(
	state: { apiKey: string },
	extra: Record<string, Responder> = {}
) {
	let leases = 0;
	let logins = 0;
	let pushEvent: (frame: string) => void = () => undefined;
	const node = fakeNode({
		"POST /api/vault/auth/approle/login": () => {
			logins += 1;
			return Response.json(issuedToken(`rvt_login${logins}`));
		},
		"GET /api/vault/agent/self/lookup": () =>
			Response.json({
				token: tokenInfo(Date.now() + 3_600_000),
				effectivePolicies: ["app"],
			}),
		"POST /api/vault/agent/dynamic/postgres-ro": () => {
			leases += 1;
			return Response.json({
				credential: {
					data: { username: "u", password: `pw${leases}` },
					lease: agentLease(`lease_${leases}`, Date.now() + 3_600_000),
				},
			});
		},
		"POST /api/vault/agent/export": () =>
			Response.json(jsonExport({ API_KEY: state.apiKey })),
		"POST /api/vault/agent/leases/lease_1/revoke": () =>
			Response.json({
				lease: { ...agentLease("lease_1", 0), revokedAt: 1 },
			}),
		...extra,
	});
	const baseFetch = node.target.fetch;
	const streamTokens: string[] = [];
	node.target.fetch = (input, init) => {
		if (new URL(String(input)).pathname === "/api/vault/agent/events") {
			streamTokens.push(
				new Headers(init?.headers).get("x-ryu-vault-token") ?? ""
			);
			const stream = sseStream(init?.signal);
			pushEvent = stream.push;
			return Promise.resolve(new Response(stream.body));
		}
		return baseFetch?.(input, init) ?? Promise.reject(new Error("no fetch"));
	};
	return { node, push: (frame: string) => pushEvent(frame), streamTokens };
}

function routes(calls: NodeCall[]): string[] {
	return calls.map((call) => call.route);
}

async function until(check: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (check()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("secrets agent --once", () => {
	test("logs in, writes the sink and the template, and runs the command once", async () => {
		const file = await writeConfig();
		const { node } = agentNode({ apiKey: "k1" });
		const commands: { cmd: string[]; env: Record<string, string> }[] = [];
		const spawn: ProcessRunner = (cmd, env) => {
			commands.push({ cmd, env });
			return Promise.resolve(0);
		};
		const first = await runSecrets(
			["agent", "--config", file, "--once"],
			node,
			{
				spawn,
				env: { RYU_VAULT_TOKEN: "rvt_ambient" },
			}
		);
		expect(first.code).toBe(0);
		expect(await readFile(join(dir, "app.env"), "utf8")).toBe(
			"API_KEY=k1\nDB_PASSWORD=pw1\n"
		);
		expect(await readFile(join(dir, "vault-token"), "utf8")).toBe("rvt_login1");
		expect(commands.map((entry) => entry.cmd)).toEqual([["reload-app"]]);
		// The command never inherits the CLI's vault token.
		expect(commands[0]?.env.RYU_VAULT_TOKEN).toBeUndefined();
		const login = node.calls.find(
			(call) => call.route === "POST /api/vault/auth/approle/login"
		);
		expect(JSON.parse(login?.body ?? "{}")).toEqual({
			roleId: "role-1",
			secretId: "sid-1",
		});
		const exported = node.calls.find(
			(call) => call.route === "POST /api/vault/agent/export"
		);
		expect(exported?.headers.get("x-ryu-vault-token")).toBe("rvt_login1");
		expect(JSON.parse(exported?.body ?? "{}")).toMatchObject({
			environment: "prod",
			names: ["API_KEY"],
		});
		// A successful --once keeps the lease its file names.
		expect(routes(node.calls)).not.toContain(
			"POST /api/vault/agent/leases/lease_1/revoke"
		);
		expect(first.out).toBe("");
		expect(first.err).not.toContain("k1");
	});

	test("an unchanged render does not run the command", async () => {
		const file = await writeConfig({ leases: [], templates: [] });
		await writeFile(join(dir, "plain.tpl"), "API_KEY={{secret:API_KEY}}\n");
		await writeFile(
			file,
			(await readFile(file, "utf8")).replace(
				'"templates":[]',
				'"templates":[{"source":"plain.tpl","destination":"plain.env","command":["reload-app"]}]'
			)
		);
		await writeFile(join(dir, "plain.env"), "API_KEY=k1\n");
		const { node } = agentNode({ apiKey: "k1" });
		let commands = 0;
		const result = await runSecrets(
			["agent", "--config", file, "--once"],
			node,
			{
				spawn: () => {
					commands += 1;
					return Promise.resolve(0);
				},
			}
		);
		expect(result.code).toBe(0);
		expect(commands).toBe(0);
	});

	test("a missing value fails, keeps the old file and revokes the lease", async () => {
		const file = await writeConfig();
		await writeFile(join(dir, "app.env"), "previous\n");
		const { node } = agentNode(
			{ apiKey: "k1" },
			{
				"POST /api/vault/agent/export": () => Response.json(jsonExport({})),
			}
		);
		const result = await runSecrets(
			["agent", "--config", file, "--once"],
			node
		);
		expect(result.code).toBe(1);
		expect(result.err).toContain("no value for secret:API_KEY.");
		expect(await readFile(join(dir, "app.env"), "utf8")).toBe("previous\n");
		expect(routes(node.calls)).toContain(
			"POST /api/vault/agent/leases/lease_1/revoke"
		);
	});

	test("an AI agent session is refused before anything is read", async () => {
		const file = await writeConfig();
		const { node } = agentNode({ apiKey: "k1" });
		const result = await runSecrets(["agent", "--config", file], node, {
			env: { CLAUDECODE: "1" },
		});
		expect(result.code).toBe(1);
		expect(result.err).toContain("Refusing to start the vault agent");
		expect(node.calls).toEqual([]);
	});

	test("a missing --config is a usage error", async () => {
		const { node } = agentNode({ apiKey: "k1" });
		const result = await runSecrets(["agent"], node);
		expect(result.code).toBe(2);
		expect(result.err).toContain("secrets agent --config FILE");
	});
});

describe("secrets agent (daemon)", () => {
	test("re-renders on a vault change, runs the command, and stops on SIGINT", async () => {
		const file = await writeConfig();
		const state = { apiKey: "k1" };
		const { node, push } = agentNode(state);
		let signal: ((name: string) => void) | null = null;
		const containerHost = {
			...defaultContainerHost(),
			onSignal: (handler: (name: string) => void) => {
				signal = handler;
				return () => {
					signal = null;
				};
			},
		};
		let commands = 0;
		const running = runSecrets(["agent", "--config", file], node, {
			containerHost,
			spawn: () => {
				commands += 1;
				return Promise.resolve(0);
			},
		});
		await until(() => commands === 1, "the first render");
		state.apiKey = "k2";
		push(
			`event: vault\ndata: ${JSON.stringify({ seq: 1, at: "2026-01-01T00:00:00Z", type: "kv-write", action: "secret.update", environment: "prod", path: "/", name: "API_KEY", version: 2 })}\n\n`
		);
		await until(() => commands === 2, "the re-render");
		expect(await readFile(join(dir, "app.env"), "utf8")).toBe(
			"API_KEY=k2\nDB_PASSWORD=pw1\n"
		);
		expect(signal).not.toBeNull();
		(signal as unknown as (name: string) => void)("SIGINT");
		const result = await running;
		expect(result.code).toBe(0);
		expect(result.err).toContain("stopped by SIGINT");
		expect(routes(node.calls)).toContain(
			"POST /api/vault/agent/leases/lease_1/revoke"
		);
		expect(result.err).not.toContain("k2");
	});

	test("a revoked lease is replaced and the template rendered with the new credential", async () => {
		const file = await writeConfig();
		const { node, push } = agentNode(
			{ apiKey: "k1" },
			{
				"POST /api/vault/agent/leases/lease_2/revoke": () =>
					Response.json({
						lease: { ...agentLease("lease_2", 0), revokedAt: 1 },
					}),
			}
		);
		let stop: ((name: string) => void) | null = null;
		const io: CliIO = { out: () => undefined, err: () => undefined };
		const running = runAgentDaemon(
			{ env: {}, io, spawn: () => Promise.resolve(0), target: node.target },
			parseAgentConfig(await readFile(file, "utf8"), file),
			{
				clock: fakeClock(Date.now()).clock,
				once: false,
				onSignal: (handler) => {
					stop = handler;
					return () => undefined;
				},
				timing: { debounceMs: 0, reconnectMs: [] },
			}
		);
		await until(
			() =>
				existsSync(join(dir, "app.env")) &&
				readFileSync(join(dir, "app.env"), "utf8").includes("pw1"),
			"the first render"
		);
		push(
			`event: vault\ndata: ${JSON.stringify({ seq: 2, at: "2026-01-01T00:00:00Z", type: "lease-revoke", action: "lease.revoke", leaseId: "lease_1" })}\n\n`
		);
		await until(
			() => readFileSync(join(dir, "app.env"), "utf8").includes("pw2"),
			"the render with the replacement credential"
		);
		(stop as unknown as (name: string) => void)("SIGINT");
		expect(await running).toBe(0);
		// Only the lease still held is revoked; the revoked one is not touched.
		expect(routes(node.calls)).toContain(
			"POST /api/vault/agent/leases/lease_2/revoke"
		);
		expect(routes(node.calls)).not.toContain(
			"POST /api/vault/agent/leases/lease_1/revoke"
		);
	});

	test("renews the token and the lease on schedule, logging in again and re-rendering when they run out", async () => {
		const file = await writeConfig();
		const time = fakeClock(0);
		let leaseRenewals = 0;
		let leasesIssued = 0;
		const { node, streamTokens } = agentNode(
			{ apiKey: "k1" },
			{
				"GET /api/vault/agent/self/lookup": () =>
					Response.json({
						token: tokenInfo(90_000),
						effectivePolicies: ["app"],
					}),
				// The first renewal extends to 150s; the second cannot (max TTL).
				"POST /api/vault/agent/self/renew": () =>
					Response.json({ token: tokenInfo(150_000) }),
				"POST /api/vault/agent/dynamic/postgres-ro": () => {
					leasesIssued += 1;
					return Response.json({
						credential: {
							data: { username: "u", password: `pw${leasesIssued}` },
							lease: agentLease(
								`lease_${leasesIssued}`,
								leasesIssued === 1 ? 30_000 : time.clock.now() + 1_000_000
							),
						},
					});
				},
				// The first renewal extends to 60s; the second cannot.
				"POST /api/vault/agent/leases/lease_1/renew": () => {
					leaseRenewals += 1;
					return Response.json({
						lease: agentLease("lease_1", 60_000),
					});
				},
				"POST /api/vault/agent/leases/lease_2/revoke": () =>
					Response.json({
						lease: { ...agentLease("lease_2", 0), revokedAt: 1 },
					}),
			}
		);
		let stop: ((name: string) => void) | null = null;
		const io: CliIO = { out: () => undefined, err: () => undefined };
		const running = runAgentDaemon(
			{ env: {}, io, spawn: () => Promise.resolve(0), target: node.target },
			parseAgentConfig(await readFile(file, "utf8"), file),
			{
				clock: time.clock,
				once: false,
				onSignal: (handler) => {
					stop = handler;
					return () => undefined;
				},
			}
		);
		await until(() => stop !== null && leasesIssued === 1, "start");
		await until(() => streamTokens.length === 1, "the event stream");
		const countOf = (route: string) =>
			routes(node.calls).filter((entry) => entry === route).length;

		// Lease expires at 30s: renewed at 20s (two thirds), to 60s.
		time.advance(19_999);
		await Bun.sleep(10);
		expect(leaseRenewals).toBe(0);
		time.advance(1);
		await until(() => leaseRenewals === 1, "the lease renewal");
		// Next renewal at 20s + 2/3 * 40s = ~46.7s; it no longer extends, so a
		// fresh credential is issued and the template renders again.
		time.advance(26_667);
		await until(() => leasesIssued === 2, "the replacement credential");
		await until(
			() =>
				readFileSync(join(dir, "app.env"), "utf8") ===
				"API_KEY=k1\nDB_PASSWORD=pw2\n",
			"the re-render with the new credential"
		);
		expect(leaseRenewals).toBe(2);

		// Token expires at 90s: renewed at 60s, to 150s.
		time.advance(60_000 - 46_667);
		await until(
			() => countOf("POST /api/vault/agent/self/renew") === 1,
			"the token renewal"
		);
		// The next renewal (at 120s) no longer extends: log in again.
		time.advance(60_000);
		await until(
			() => countOf("POST /api/vault/auth/approle/login") === 2,
			"the second login"
		);
		await until(
			() => readFileSync(join(dir, "vault-token"), "utf8") === "rvt_login2",
			"the sink to hold the new token"
		);
		// The event stream is reopened on the new token.
		await until(() => streamTokens.length === 2, "the reopened stream");
		expect(streamTokens).toEqual(["rvt_login1", "rvt_login2"]);

		(stop as unknown as (name: string) => void)("SIGTERM");
		expect(await running).toBe(0);
		expect(routes(node.calls)).toContain(
			"POST /api/vault/agent/leases/lease_2/revoke"
		);
		expect(time.pending()).toBe(0);
	});
});
