// `ryu secrets …` dispatch tests: `run --broker` on and off the node's host, CA bundles and signals. Core is faked through the
// target's injected `fetch`, child processes through `spawn`, and stdin
// through `readStdin`, so nothing touches a node, spawns, or reads the real
// terminal. Shared fixtures are in `secrets-dispatch-fixture.ts`.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli/dispatch.ts";
import type { ContainerHost } from "../cli/vaultIsolation.ts";

import {
	CA_PEM,
	fakeNode,
	makeIo,
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

// ── Broker, TOTP, items, tokens, and wrapping ────────────────────────────────

const brokerSession = {
	id: "bs_1",
	environment: "prod",
	services: ["github", "stripe"],
	label: "ryu-cli secrets run node",
	mintedBy: "user:u1",
	createdAt: T,
	expiresAt: T,
};

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
		label: "ryu-cli secrets run node",
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
