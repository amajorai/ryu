// Agent-side broker commands: `ryu-cli secrets broker discover`, `propose`,
// and `proposal ID`, authenticated with the agent's broker session (from its
// proxy variables) or a machine token. Core is faked through the target's
// `fetch`.

import { expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { runCli } from "../cli/dispatch.ts";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import {
	proposalInput,
	serviceNameForHost,
} from "../cli/secrets-broker-agent.ts";
import type { CoreApi } from "../cli/types.ts";

const SESSION_ENV = {
	HOME: "/home/me",
	CLAUDECODE: "1",
	HTTPS_PROXY: "http://rvb:rvb_agent_session@127.0.0.1:9000",
};

interface Call {
	auth: string | null;
	body: string;
	route: string;
	vaultToken: string | null;
}

function fakeNode(routes: Record<string, () => Response>) {
	const calls: Call[] = [];
	const target: ApiTarget = {
		url: "http://127.0.0.1:7777",
		token: "node-token",
		fetch: (input, init) => {
			const parsed = new URL(String(input));
			const headers = new Headers(init?.headers);
			const route = `${init?.method ?? "GET"} ${parsed.pathname}`;
			calls.push({
				route,
				body: String(init?.body ?? ""),
				auth: headers.get("authorization"),
				vaultToken: headers.get("x-ryu-vault-token"),
			});
			const respond = routes[route];
			return Promise.resolve(
				respond
					? respond()
					: Response.json({ error: "no route" }, { status: 404 })
			);
		},
	};
	return { calls, target };
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

async function run(
	argv: string[],
	node: ReturnType<typeof fakeNode>,
	env: Record<string, string> = SESSION_ENV
) {
	let out = "";
	let err = "";
	const code = await runCli(argv, {
		api: stubApi(),
		env,
		io: {
			out: (text) => {
				out += text;
			},
			err: (text) => {
				err += text;
			},
		},
		promptLine: () => Promise.resolve(null),
		spawn: () => Promise.resolve(0),
		target: node.target,
	});
	return { code, err, out };
}

function proposal(status: string) {
	return {
		proposal: {
			id: "bp_1",
			environment: "default",
			status,
			message: "need linear",
			services: [],
			credentials: [],
			requestedBy: "broker_session:bvs_1",
			createdAt: "2026-01-01T00:00:00Z",
			expiresAt: "2026-01-08T00:00:00Z",
		},
	};
}

test("discover lists the session's services with its broker session as the bearer", async () => {
	const node = fakeNode({
		"GET /api/vault/agent/broker/discover": () =>
			Response.json({
				environment: "default",
				unmatchedHostPolicy: "deny",
				skills: [],
				services: [
					{
						name: "github",
						host: "api.github.com",
						auth: "bearer",
						placeholders: [{ placeholder: "__GH__", in: ["header"] }],
					},
				],
				proxy: {
					listening: true,
					port: 9000,
					caUrl: "/api/vault/broker/ca.pem",
					portEnv: "RYU_VAULT_BROKER_PORT",
				},
				proposalsEndpoint: "/api/vault/agent/broker/proposals",
			}),
	});
	const { code, out } = await run(["secrets", "broker", "discover"], node);
	expect(code).toBe(0);
	expect(out).toContain("unknown hosts: deny");
	expect(out).toMatch(/github\s+api\.github\.com\s+bearer\s+__GH__/);
	expect(node.calls).toEqual([
		{
			route: "GET /api/vault/agent/broker/discover",
			body: "",
			auth: "Bearer rvb_agent_session",
			vaultToken: null,
		},
	]);
});

test("propose files a service and credential request, never a value", async () => {
	const node = fakeNode({
		"POST /api/vault/agent/broker/proposals": () =>
			Response.json(proposal("pending")),
	});
	const { code, out } = await run(
		[
			"secrets",
			"broker",
			"propose",
			"--host",
			"api.linear.app",
			"--credential",
			"secret:LINEAR_TOKEN",
			"--instructions",
			"Create a personal API key in Linear settings",
			"--message",
			"I need to read Linear issues",
		],
		node
	);
	expect(code).toBe(0);
	expect(out).toContain("Proposal bp_1 is pending");
	expect(node.calls[0]?.auth).toBe("Bearer rvb_agent_session");
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({
		message: "I need to read Linear issues",
		services: [
			{
				name: "api-linear-app",
				host: "api.linear.app",
				auth: { type: "bearer", token: "secret:LINEAR_TOKEN" },
			},
		],
		credentials: [
			{
				ref: "secret:LINEAR_TOKEN",
				obtainInstructions: "Create a personal API key in Linear settings",
			},
		],
	});
});

test("a machine token takes precedence over the broker session", async () => {
	const node = fakeNode({
		"GET /api/vault/agent/broker/proposals/bp_1": () =>
			Response.json(proposal("approved")),
	});
	const { code, out } = await run(
		["secrets", "broker", "proposal", "bp_1"],
		node,
		{
			...SESSION_ENV,
			RYU_VAULT_TOKEN: "rvt_machine",
		}
	);
	expect(code).toBe(0);
	expect(out).toContain("is approved");
	expect(node.calls[0]?.vaultToken).toBe("rvt_machine");
	expect(node.calls[0]?.auth).toBeNull();
});

test("proposal exits 3 while pending and 1 when rejected", async () => {
	for (const [status, expected] of [
		["pending", 3],
		["rejected", 1],
	] as const) {
		const node = fakeNode({
			"GET /api/vault/agent/broker/proposals/bp_1": () =>
				Response.json(proposal(status)),
		});
		const { code } = await run(["secrets", "broker", "proposal", "bp_1"], node);
		expect({ status, code }).toEqual({ status, code: expected });
	}
});

test("without a vault token or broker session the agent commands refuse", async () => {
	const node = fakeNode({});
	const { code, err } = await run(["secrets", "broker", "discover"], node, {
		HOME: "/home/me",
	});
	expect(code).not.toBe(0);
	expect(err).toContain("RYU_VAULT_BROKER_SESSION");
	expect(node.calls).toEqual([]);
});

test("proposalInput rejects values and incomplete requests", () => {
	const parse = (raw: string[]) => proposalInput(parseSecretsArgs(raw));
	expect(() => parse(["--message", "need it"])).toThrow();
	expect(() => parse(["--host", "api.test"])).toThrow();
	expect(() =>
		parse(["--message", "m", "--credential", "sk_live_123456789"])
	).toThrow(/Never pass a value/);
	expect(() =>
		parse(["--message", "m", "--host", "api.test", "--auth", "bearer"])
	).toThrow(/needs a --credential/);
	expect(() =>
		parse([
			"--message",
			"m",
			"--host",
			"api.test",
			"--credential",
			"secret:K",
			"--auth",
			"api_key",
		])
	).toThrow(/--header/);
	expect(
		parse([
			"--message",
			"m",
			"--host",
			"API.Test",
			"--credential",
			"op://dev/Key/token",
			"--auth",
			"api_key",
			"--header",
			"x-api-key",
			"--env",
			"prod",
		])
	).toEqual({
		message: "m",
		environment: "prod",
		services: [
			{
				name: "api-test",
				host: "api.test",
				auth: {
					type: "api_key",
					header: "x-api-key",
					value: "op://dev/Key/token",
				},
			},
		],
		credentials: [{ ref: "op://dev/Key/token", obtainInstructions: "" }],
	});
	// A host alone proposes an uncredentialed (passthrough) service.
	expect(parse(["--message", "m", "--host", "api.test"]).services).toEqual([
		{ name: "api-test", host: "api.test", auth: { type: "passthrough" } },
	]);
});

test("service names derived from hosts stay within the allowed characters", () => {
	expect(serviceNameForHost("api.linear.app")).toBe("api-linear-app");
	expect(serviceNameForHost("*.example.com")).toBe("example-com");
	expect(serviceNameForHost("...")).toBe("service");
	expect(serviceNameForHost(`${"a".repeat(80)}.test`)).toHaveLength(64);
});
