import { afterAll, beforeEach, expect, test } from "bun:test";
import {
	connectMcpOAuth,
	disconnectMcpOAuth,
	fetchMcpOAuth,
	fetchMcpOAuthFlow,
} from "./mcp-oauth.ts";

interface Call {
	body: unknown;
	method: string;
	path: string;
	token: string | null;
}
const calls: Call[] = [];
let payload: unknown = {};
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const text = await request.text();
		calls.push({
			body: text ? JSON.parse(text) : null,
			method: request.method,
			path: request.url.slice(url.origin.length),
			token: request.headers.get("authorization"),
		});
		return Response.json(payload);
	},
});
afterAll(() => server.stop(true));
const target = { url: server.url.toString(), token: "node-token" };
beforeEach(() => {
	calls.length = 0;
});

const startedWire = {
	authorization_url: "https://idp.example/authorize?state=s",
	callback_mode: "loopback",
	expires_at: 1_900_000_000,
	flow_id: "flow-1",
	status: "pending",
};

test("connect posts to the encoded scoped plugin and server path with the default access level", async () => {
	payload = { ...startedWire, access_level: "full", scopes: ["mail.read"] };
	const started = await connectMcpOAuth(
		target,
		"@ryu/x",
		"mail server/1",
		"profile-a"
	);
	expect(calls).toEqual([
		{
			body: {
				access_level: "risk_based",
				callback_mode: "auto",
				profile_id: "profile-a",
			},
			method: "POST",
			path: "/api/plugins/%40ryu%2Fx/auth/mail%20server%2F1/connect",
			token: "Bearer node-token",
		},
	]);
	expect(started).toEqual({
		accessLevel: "full",
		authorizationUrl: "https://idp.example/authorize?state=s",
		callbackMode: "loopback",
		expiresAt: 1_900_000_000,
		flowId: "flow-1",
		scopes: ["mail.read"],
		status: "pending",
	});
});

test("connect forwards an explicit access level and normalizes unknown or missing response levels", async () => {
	payload = { ...startedWire, access_level: "root" };
	const unknown = await connectMcpOAuth(target, "p", "s", "pr", "read_only");
	expect(calls[0]?.body).toEqual({
		access_level: "read_only",
		callback_mode: "auto",
		profile_id: "pr",
	});
	expect(unknown.accessLevel).toBe("risk_based");
	expect(unknown.scopes).toEqual([]);
	payload = { ...startedWire };
	expect((await connectMcpOAuth(target, "p", "s", "pr")).accessLevel).toBe(
		"risk_based"
	);
	payload = { ...startedWire, access_level: { level: "full" } };
	expect((await connectMcpOAuth(target, "p", "s", "pr")).accessLevel).toBe(
		"risk_based"
	);
});

test("fetch maps snake_case wire fields and normalizes each connection's access level", async () => {
	payload = {
		servers: [
			{
				client_id: "client-1",
				connections: [
					{
						access_level: "write",
						account_label: "me@example.com",
						expires_at: 123,
						id: "c1",
						issuer: "https://idp.example",
						profile_id: "p1",
						resource_uri: "https://mcp.example/mcp",
						scopes: ["a"],
						status: "connected",
					},
					{
						access_level: "admin",
						id: "c2",
						issuer: "https://idp.example",
						profile_id: "p2",
						resource_uri: "https://mcp.example/other",
						status: "reauth_required",
					},
				],
				resource: "https://mcp.example/mcp",
				server_name: "mail",
			},
			{ server_name: "bare" },
		],
	};
	const servers = await fetchMcpOAuth(target, "@ryu/x");
	expect(calls[0]).toMatchObject({
		method: "GET",
		path: "/api/plugins/%40ryu%2Fx/auth",
	});
	expect(servers).toEqual([
		{
			clientId: "client-1",
			connections: [
				{
					accessLevel: "write",
					accountLabel: "me@example.com",
					expiresAt: 123,
					id: "c1",
					issuer: "https://idp.example",
					profileId: "p1",
					resource: "https://mcp.example/mcp",
					scopes: ["a"],
					status: "connected",
				},
				{
					accessLevel: "risk_based",
					accountLabel: null,
					expiresAt: null,
					id: "c2",
					issuer: "https://idp.example",
					profileId: "p2",
					resource: "https://mcp.example/other",
					scopes: [],
					status: "reauth_required",
				},
			],
			resource: "https://mcp.example/mcp",
			serverName: "mail",
		},
		{ clientId: null, connections: [], resource: "", serverName: "bare" },
	]);
	payload = {};
	expect(await fetchMcpOAuth(target, "p")).toEqual([]);
});

test("disconnect sends DELETE with an encoded profile query", async () => {
	payload = { deleted: true, revocation: "not_confirmed" };
	expect(
		await disconnectMcpOAuth(target, "@ryu/x", "mail", "work & home")
	).toMatchObject({ deleted: true, revocation: "not_confirmed" });
	expect(calls).toEqual([
		{
			body: null,
			method: "DELETE",
			path: "/api/plugins/%40ryu%2Fx/auth/mail?profile_id=work%20%26%20home",
			token: "Bearer node-token",
		},
	]);
});

test("flow status reads the encoded flow path and normalizes the access level", async () => {
	payload = {
		access_level: "everything",
		callback_mode: "hosted",
		expires_at: 5,
		flow_id: "f/1",
		plugin_id: "@ryu/x",
		profile_id: "p",
		server_name: "mail",
		status: "failed",
		error: "denied",
	};
	const flow = await fetchMcpOAuthFlow(target, "@ryu/x", "f/1");
	expect(calls[0]?.path).toBe("/api/plugins/%40ryu%2Fx/auth/flows/f%2F1");
	expect(flow).toEqual({
		accessLevel: "risk_based",
		callbackMode: "hosted",
		error: "denied",
		expiresAt: 5,
		flowId: "f/1",
		pluginId: "@ryu/x",
		profileId: "p",
		scopes: [],
		serverName: "mail",
		status: "failed",
	});
});
