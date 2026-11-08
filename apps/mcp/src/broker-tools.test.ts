import { afterEach, expect, test } from "bun:test";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
	type FakeCoreRequest,
	useFakeLoopbackCore,
} from "@ryuhq/core-client/__tests__/fake-loopback-core";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	brokerAgentTarget,
	proposalBody,
	proposeInputSchema,
	registerBrokerTools,
} from "./broker-tools.ts";

type Handler = (input: Record<string, unknown>) => Promise<CallToolResult>;

function fakeServer() {
	const tools = new Map<string, Handler>();
	const server = {
		registerTool: (name: string, _config: unknown, handler: Handler) => {
			tools.set(name, handler);
		},
	} as unknown as McpServer;
	return { server, tools };
}

/** A local Core, faked behind the loopback connector, holding `sessions`. */
function fakeCore(
	seen: FakeCoreRequest[],
	options: { sessions?: string[]; token?: string | null } = {}
): ApiTarget {
	restore?.();
	const token = options.token === undefined ? "node" : options.token;
	restore = useFakeLoopbackCore({
		...(token ? { nodeToken: token } : {}),
		sessions: options.sessions ?? [],
		seen,
	});
	return { url: "http://127.0.0.1:8980", token };
}

/** The requests that reached Core's routes (not the identity challenges). */
function routes(seen: FakeCoreRequest[]) {
	return seen.filter((entry) => entry.path !== "/api/health/identity");
}

let restore: (() => void) | null = null;

afterEach(() => {
	restore?.();
	restore = null;
});

const SESSION_ENV = { HTTPS_PROXY: "http://rvb:rvb_inherited@127.0.0.1:9000" };

test("the tools are offered only to a process holding a session or token", () => {
	const target = fakeCore([]);
	const plain = fakeServer();
	expect(registerBrokerTools(plain.server, target, {})).toBe(false);
	expect(plain.tools.size).toBe(0);
	const brokered = fakeServer();
	expect(registerBrokerTools(brokered.server, target, SESSION_ENV)).toBe(true);
	expect([...brokered.tools.keys()]).toEqual([
		"ryu_broker_discover",
		"ryu_broker_propose",
		"ryu_broker_proposal",
	]);
});

test("propose files the request as the inherited broker session", async () => {
	const seen: FakeCoreRequest[] = [];
	const { server, tools } = fakeServer();
	registerBrokerTools(server, fakeCore(seen), SESSION_ENV);
	const input = proposeInputSchema.parse({
		message: "Need Linear issues",
		services: [
			{
				name: "linear",
				host: "api.linear.app",
				auth: { type: "bearer", token: "secret:LINEAR" },
			},
		],
		credentials: [{ ref: "secret:LINEAR" }],
	});
	const result = await tools.get("ryu_broker_propose")?.(input);
	expect(result?.isError).toBeUndefined();
	const [filed] = routes(seen);
	expect(`${filed?.method} ${filed?.path}`).toBe(
		"POST /api/vault/agent/broker/proposals"
	);
	expect(filed?.authorization).toBe("Bearer rvb_inherited");
	expect(filed?.vaultToken).toBeNull();
	expect(JSON.parse(filed?.body || "{}")).toEqual({
		message: "Need Linear issues",
		services: [
			{
				name: "linear",
				host: "api.linear.app",
				auth: { type: "bearer", token: "secret:LINEAR" },
			},
		],
		credentials: [
			{ ref: "secret:LINEAR", description: "", obtainInstructions: "" },
		],
	});
	const polled = await tools.get("ryu_broker_proposal")?.({ id: "bp_1" });
	expect(routes(seen)[1]?.path).toBe("/api/vault/agent/broker/proposals/bp_1");
	expect(JSON.stringify(polled?.content)).toContain("pending");
});

test("a machine token wins over the session, and values are refused as references", () => {
	const agent = brokerAgentTarget(fakeCore([]), {
		...SESSION_ENV,
		RYU_VAULT_TOKEN: "rvt_machine",
	});
	expect(agent?.vaultToken).toBe("rvt_machine");
	expect(
		proposeInputSchema.safeParse({
			message: "m",
			credentials: [{ ref: "sk_live_123" }],
		}).success
	).toBe(false);
	expect(
		proposalBody(
			proposeInputSchema.parse({ message: "m", environment: "prod" })
		)
	).toEqual({
		message: "m",
		services: [],
		credentials: [],
		environment: "prod",
	});
});

test("a tokenless local Core gets the session only after proving it holds it", async () => {
	const seen: FakeCoreRequest[] = [];
	const { server, tools } = fakeServer();
	const target = fakeCore(seen, { token: null, sessions: ["rvb_inherited"] });
	expect(registerBrokerTools(server, target, SESSION_ENV)).toBe(true);
	const result = await tools.get("ryu_broker_discover")?.({});
	expect(result?.isError).toBeUndefined();
	const [discover] = routes(seen);
	expect(discover?.authorization).toBe("Bearer rvb_inherited");
	const challenge = seen.find(
		(entry) => entry.connection === discover?.connection
	);
	expect(challenge?.path).toBe("/api/health/identity");
	expect(challenge?.authorization).toBeNull();
});

test("a listener that cannot prove the session gets no credential", async () => {
	const seen: FakeCoreRequest[] = [];
	const { server, tools } = fakeServer();
	const target = fakeCore(seen, { token: null, sessions: ["rvb_other"] });
	registerBrokerTools(server, target, SESSION_ENV);
	const result = await tools.get("ryu_broker_discover")?.({});
	expect(result?.isError).toBe(true);
	expect(routes(seen)).toEqual([]);
	expect(seen.some((entry) => entry.authorization !== null)).toBe(false);
});

test("the tools are not registered for a Core that cannot be verified", () => {
	const warnings: string[] = [];
	const warn = (message: string) => warnings.push(message);
	// A vault token with no node token to check a local Core with.
	const local = fakeServer();
	const tokenless = fakeCore([], { token: null });
	expect(
		registerBrokerTools(
			local.server,
			tokenless,
			{ RYU_VAULT_TOKEN: "rvt_machine" },
			warn
		)
	).toBe(false);
	expect(local.tools.size).toBe(0);
	// A remote plain-HTTP Core, whatever the credential.
	const remote = fakeServer();
	const insecure: ApiTarget = {
		url: "http://core.example.com:7980",
		token: null,
	};
	expect(registerBrokerTools(remote.server, insecure, SESSION_ENV, warn)).toBe(
		false
	);
	expect(
		registerBrokerTools(
			remote.server,
			insecure,
			{ RYU_VAULT_TOKEN: "rvt_machine" },
			warn
		)
	).toBe(false);
	expect(remote.tools.size).toBe(0);
	expect(warnings).toHaveLength(3);
	expect(warnings.join("\n")).not.toContain("rvt_machine");
	expect(warnings.join("\n")).not.toContain("rvb_inherited");
});
