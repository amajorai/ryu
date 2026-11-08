// Wire tests for the broker console client: the exact method, path, query and
// JSON body each call puts on a loopback socket, and how replies that break
// the contract (a token without the `rvb_` prefix, an unknown policy) surface
// instead of rendering.

import { afterEach, expect, test } from "bun:test";
import {
	getVaultBrokerEnvironment,
	getVaultBrokerStatus,
	listVaultBrokerDiscoveredHosts,
	listVaultBrokerLogs,
	listVaultBrokerSessions,
	mintVaultBrokerSession,
	putVaultBrokerEnvironment,
	revokeVaultBrokerSession,
} from "./vault-broker-console.ts";

interface Seen {
	body: string;
	method: string;
	target: string;
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

function node(reply: unknown, status = 200) {
	const seen: Seen[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push({
				body: await request.text(),
				method: request.method,
				target: `${url.pathname}${url.search}`,
			});
			return Response.json(reply, { status });
		},
	});
	servers.push(server);
	return {
		seen,
		target: {
			token: "console-node-token",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const SESSION = {
	createdAt: "2026-10-01T00:00:00+00:00",
	environment: "prod",
	expiresAt: "2026-10-01T01:00:00+00:00",
	id: "bs_1",
	label: "deploy",
	mintedBy: "user:u1",
	services: ["stripe"],
};

test("status maps a stopped listener's missing port to null", async () => {
	const { seen, target } = node({
		broker: { caUrl: "/ca.pem", listening: false, portEnv: "RYU_PORT_ENV" },
	});
	expect(await getVaultBrokerStatus(target)).toEqual({
		caUrl: "/ca.pem",
		listening: false,
		port: null,
		portEnv: "RYU_PORT_ENV",
	});
	expect(seen.map((row) => row.target)).toEqual(["/api/vault/broker/status"]);
});

test("sessions list with a bare GET and revoke with a DELETE on the encoded id", async () => {
	const list = node({ sessions: [SESSION] });
	expect(await listVaultBrokerSessions(list.target)).toEqual([SESSION]);
	expect(list.seen[0]).toEqual({
		body: "",
		method: "GET",
		target: "/api/vault/broker/sessions",
	});

	const revoke = node({ revoked: true });
	expect(await revokeVaultBrokerSession(revoke.target, "bs/1")).toBe(true);
	expect(revoke.seen[0]).toMatchObject({
		method: "DELETE",
		target: "/api/vault/broker/sessions/bs%2F1",
	});
});

test("minting sends the environment, services, trimmed label and lifetime, and returns the one-time token", async () => {
	const reply = {
		proxy: {
			caBundlePath: "/ca/bundle.pem",
			caPath: "/ca/ca.pem",
			env: { HTTPS_PROXY: "http://rvb:rvb_secret@127.0.0.1:9" },
			port: 9,
			url: "http://127.0.0.1:9",
		},
		session: SESSION,
		token: "rvb_secret",
	};
	const { seen, target } = node(reply);
	const minted = await mintVaultBrokerSession(target, {
		environment: "prod",
		label: "  deploy ",
		services: ["stripe"],
		ttlSecs: 900,
	});
	expect(minted.token).toBe("rvb_secret");
	expect(minted.proxy?.env.HTTPS_PROXY).toContain("rvb_secret");
	expect(seen[0]?.method).toBe("POST");
	expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
		environment: "prod",
		label: "deploy",
		services: ["stripe"],
		ttlSecs: 900,
	});

	const bare = node({ ...reply, proxy: null });
	await mintVaultBrokerSession(bare.target, {
		environment: "default",
		label: " ",
		services: [],
	});
	expect(JSON.parse(bare.seen[0]?.body ?? "")).toEqual({
		environment: "default",
		services: [],
	});
});

test("a mint reply whose token is not an rvb_ token is refused", async () => {
	const { target } = node({ proxy: null, session: SESSION, token: "plain" });
	await expect(
		mintVaultBrokerSession(target, { environment: "prod", services: [] })
	).rejects.toThrow();
});

test("logs pass only the filters that are set", async () => {
	const row = {
		at: "2026-10-01T00:00:00+00:00",
		environment: "prod",
		host: "api.stripe.com",
		id: 7,
		latencyMs: 12,
		method: "GET",
		outcome: "intercepted",
		path: "/v1/charges",
		port: 443,
		scheme: "https",
		service: "stripe",
		sessionId: null,
		status: 200,
	};
	const { seen, target } = node({ logs: [row] });
	expect(
		await listVaultBrokerLogs(target, {
			before: 40,
			environment: "prod",
			limit: 50,
			statusBucket: "4xx",
		})
	).toEqual([row]);
	await listVaultBrokerLogs(target);
	expect(seen.map((entry) => entry.target)).toEqual([
		"/api/vault/broker/logs?before=40&environment=prod&limit=50&statusBucket=4xx",
		"/api/vault/broker/logs",
	]);
});

test("discovered hosts are listed per environment", async () => {
	const host = {
		environment: "prod",
		host: "api.openai.com",
		lastSeen: 1_700_000_000_000,
		port: 443,
		requests: 4,
		suggestedTemplate: "openai",
	};
	const { seen, target } = node({ hosts: [host] });
	expect(await listVaultBrokerDiscoveredHosts(target, "prod")).toEqual([host]);
	expect(seen[0]?.target).toBe(
		"/api/vault/broker/discovered-hosts?environment=prod"
	);
});

test("environment settings read and write on the encoded slug with only the settable fields", async () => {
	const settings = {
		brokerRunsUnderDeny: true,
		environment: "prod",
		skills: "Use /v1.",
		unmatchedHostPolicy: "passthrough" as const,
		updatedAt: "2026-10-01T00:00:00+00:00",
	};
	const { seen, target } = node({ settings });
	expect(await getVaultBrokerEnvironment(target, "prod")).toEqual(settings);
	await putVaultBrokerEnvironment(target, "prod", {
		...settings,
		unmatchedHostPolicy: "deny",
	} as never);
	expect(seen.map(({ method, target: path }) => [method, path])).toEqual([
		["GET", "/api/vault/broker/environments/prod"],
		["PUT", "/api/vault/broker/environments/prod"],
	]);
	expect(JSON.parse(seen[1]?.body ?? "")).toEqual({
		brokerRunsUnderDeny: true,
		skills: "Use /v1.",
		unmatchedHostPolicy: "deny",
	});

	// A Core that predates the opt-in reads as off.
	const { brokerRunsUnderDeny: _omitted, ...older } = settings;
	const legacy = node({ settings: older });
	expect(
		(await getVaultBrokerEnvironment(legacy.target, "prod")).brokerRunsUnderDeny
	).toBe(false);

	const unknown = node({ settings: { ...settings, unmatchedHostPolicy: "x" } });
	await expect(
		getVaultBrokerEnvironment(unknown.target, "prod")
	).rejects.toThrow();
});
