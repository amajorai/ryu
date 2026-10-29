import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { authBackendUrl } from "./controlPlane.ts";
import { fetchManagedNodes } from "./managedNodes.ts";

const realFetch = globalThis.fetch;
const fixtureServers: ReturnType<typeof Bun.serve>[] = [];
const originalUrlHeader = "x-managed-nodes-fixture-original-url";
function fixtureFetch(
	respond: (request: Request) => Promise<Response>
): typeof realFetch {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const originalUrl = request.headers.get(originalUrlHeader);
			if (!originalUrl) {
				throw new Error(
					"The native HTTP fixture requires the original request URL"
				);
			}
			const originalRequest = new Request(originalUrl, request);
			originalRequest.headers.delete(originalUrlHeader);
			return respond(originalRequest);
		},
	});
	fixtureServers.push(server);
	return Object.assign(
		(
			input: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		) => {
			const original = new Request(input, init);
			const url = new URL(original.url);
			const forwarded = new Request(
				new URL(url.pathname + url.search, server.url),
				original
			);
			forwarded.headers.set(originalUrlHeader, original.url);
			return realFetch(forwarded);
		},
		{ preconnect: realFetch.preconnect }
	);
}

const LOCAL_TARGET: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: "core-node-token",
};

const originalAuthUrl = process.env.RYU_AUTH_URL;

beforeEach(() => {
	// Name the local control plane explicitly: the unconfigured loopback
	// default never receives the account bearer (authBackend.ts).
	process.env.RYU_AUTH_URL = "http://localhost:3000";
});

afterEach(() => {
	globalThis.fetch = realFetch;
	if (originalAuthUrl === undefined) {
		delete process.env.RYU_AUTH_URL;
	} else {
		process.env.RYU_AUTH_URL = originalAuthUrl;
	}
	for (const server of fixtureServers.splice(0)) {
		server.stop(true);
	}
});

test("managed nodes use Core's account bearer and the control plane's node-scoped delegation", async () => {
	const requests: Array<{ headers: Headers; url: string }> = [];
	globalThis.fetch = fixtureFetch(async (request) => {
		const url = request.url;
		const headers = request.headers;
		requests.push({ headers, url });
		if (url === `${LOCAL_TARGET.url}/api/auth/status`) {
			return Response.json({ authenticated: true, token: "account-session" });
		}
		if (url.endsWith("/api/control-plane/nodes")) {
			return Response.json({
				nodes: [
					{
						id: "credential-1",
						name: "Primary",
						orgId: "org-1",
						url: "https://cloud.example.test",
						userJwt: "node-audience-delegation",
					},
					{
						id: "credential-2",
						name: "Unusable",
						orgId: "org-1",
						url: "https://missing-delegation.example.test",
						userJwt: null,
					},
					{
						id: "credential-3",
						name: "No URL",
						orgId: "org-1",
						url: " ",
						userJwt: "node-audience-delegation",
					},
				],
			});
		}
		return Response.json({}, { status: 404 });
	});

	const nodes = await fetchManagedNodes(LOCAL_TARGET);
	expect(nodes).toEqual([
		{
			name: "cloud-Primary",
			url: "https://cloud.example.test",
			token: null,
			userJwt: "node-audience-delegation",
			managed: true,
			orgId: "org-1",
		},
	]);
	expect(requests).toHaveLength(2);
	expect(requests[0]?.url).toBe(`${LOCAL_TARGET.url}/api/auth/status`);
	expect(requests[0]?.headers.get("authorization")).toBe(
		"Bearer core-node-token"
	);
	expect(requests[1]?.url).toBe(`${authBackendUrl()}/api/control-plane/nodes`);
	expect(requests[1]?.headers.get("authorization")).toBe(
		"Bearer account-session"
	);
});

test("managed node discovery does not query the control plane without an account session", async () => {
	const requests: string[] = [];
	globalThis.fetch = fixtureFetch(async (request) => {
		const url = request.url;
		requests.push(url);
		return Response.json({ authenticated: false, token: null });
	});

	expect(await fetchManagedNodes(LOCAL_TARGET)).toEqual([]);
	expect(requests).toEqual([`${LOCAL_TARGET.url}/api/auth/status`]);
});

test("managed node discovery distinguishes a control-plane outage from an empty visible-node list", async () => {
	globalThis.fetch = fixtureFetch(async (request) => {
		if (request.url.endsWith("/api/auth/status")) {
			return Response.json({ authenticated: true, token: "account-session" });
		}
		return Response.json({ error: "offline" }, { status: 503 });
	});
	const unavailable = await fetchManagedNodes(LOCAL_TARGET);
	expect(unavailable).toBeNull();

	globalThis.fetch = fixtureFetch(async (request) => {
		if (request.url.endsWith("/api/auth/status")) {
			return Response.json({ authenticated: true, token: "account-session" });
		}
		return Response.json({ nodes: [] });
	});
	expect(await fetchManagedNodes(LOCAL_TARGET)).toEqual([]);
});
