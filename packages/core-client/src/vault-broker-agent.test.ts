import { expect, test } from "bun:test";
import { vaultAgentBrokerDiscover, vaultAgentBrokerPropose } from "./vault.ts";
import {
	BROKER_SESSION_ENV,
	brokerSessionFromEnv,
	brokerSessionTarget,
} from "./vault-broker-agent.ts";

test("the broker session comes from the explicit variable, then the proxy URL", () => {
	expect(
		brokerSessionFromEnv({
			[BROKER_SESSION_ENV]: " rvb_explicit ",
			HTTPS_PROXY: "http://rvb:rvb_proxy@127.0.0.1:9000",
		})
	).toBe("rvb_explicit");
	expect(
		brokerSessionFromEnv({ https_proxy: "http://rvb:rvb_proxy@127.0.0.1:9000" })
	).toBe("rvb_proxy");
	expect(
		brokerSessionFromEnv({ HTTP_PROXY: "http://rvb:rvb_a%2Bb@127.0.0.1:9000" })
	).toBe("rvb_a+b");
});

test("a proxy without a broker session, or a malformed one, yields nothing", () => {
	expect(brokerSessionFromEnv({})).toBeNull();
	expect(
		brokerSessionFromEnv({ HTTPS_PROXY: "http://user:hunter2@proxy.corp:3128" })
	).toBeNull();
	expect(brokerSessionFromEnv({ HTTPS_PROXY: "not a url" })).toBeNull();
	expect(brokerSessionFromEnv({ [BROKER_SESSION_ENV]: "rvb_" })).toBeNull();
	expect(
		brokerSessionFromEnv({ [BROKER_SESSION_ENV]: "rvt_token" })
	).toBeNull();
});

test("a session target sends the session as the bearer and no vault token", async () => {
	const seen: { auth: string | null; token: string | null; url: string }[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		seen.push({
			url: String(input),
			auth: headers.get("authorization"),
			token: headers.get("x-ryu-vault-token"),
		});
		const path = new URL(String(input)).pathname;
		const body =
			path === "/api/vault/agent/broker/discover"
				? {
						environment: "prod",
						unmatchedHostPolicy: "deny",
						skills: [],
						services: [],
						proxy: {
							listening: true,
							port: 9000,
							caUrl: "/api/vault/broker/ca.pem",
							portEnv: "RYU_VAULT_BROKER_PORT",
						},
						proposalsEndpoint: "/api/vault/agent/broker/proposals",
					}
				: {
						proposal: {
							id: "bp_1",
							environment: "prod",
							status: "pending",
							message: "need linear",
							services: [],
							credentials: [],
							requestedBy: "broker_session:bvs_1",
							createdAt: 1,
							expiresAt: 2,
						},
					};
		return Promise.resolve(Response.json(body));
	};
	const target = brokerSessionTarget(
		{ url: "http://127.0.0.1:7777/", fetch },
		"rvb_session"
	);
	expect((await vaultAgentBrokerDiscover(target)).environment).toBe("prod");
	const { proposal } = await vaultAgentBrokerPropose(target, {
		message: "need linear",
	});
	expect(proposal.id).toBe("bp_1");
	expect(seen).toEqual([
		{
			url: "http://127.0.0.1:7777/api/vault/agent/broker/discover",
			auth: "Bearer rvb_session",
			token: null,
		},
		{
			url: "http://127.0.0.1:7777/api/vault/agent/broker/proposals",
			auth: "Bearer rvb_session",
			token: null,
		},
	]);
});
