// Wire tests for the external-store client: the exact method, path and JSON
// body on a loopback socket, and replies that break the contract.

import { afterEach, expect, test } from "bun:test";
import {
	createVaultExternalDestination,
	createVaultExternalStore,
	listVaultExternalDestinations,
	pushVaultExternalDestination,
	syncVaultExternalSource,
	testVaultExternalStore,
} from "./vault-external.ts";

interface Seen {
	body: string;
	method: string;
	path: string;
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
			seen.push({
				body: await request.text(),
				method: request.method,
				path: new URL(request.url).pathname,
			});
			return Response.json(reply, { status });
		},
	});
	servers.push(server);
	return {
		seen,
		target: {
			token: "external-node-token",
			url: `http://127.0.0.1:${server.port}`,
			userJwt: null,
		},
	};
}

const DESTINATION = {
	dirty: true,
	environment: "prod",
	failures: 0,
	id: "xdst_1",
	intervalSecs: 3600,
	lastCount: 0,
	lastError: null,
	lastPushAt: null,
	lastStatus: null,
	path: "/web",
	remotePath: "WEB_",
	storeId: "xs_1",
};

test("a target is created with its credentials in the body", async () => {
	const { seen, target } = node({
		store: {
			address: "https://api.vercel.com",
			authMethod: "token",
			id: "xs_1",
			kind: "vercel",
			name: "web",
		},
	});
	const store = await createVaultExternalStore(target, {
		authMethod: "token",
		credentials: { token: "vc_token" },
		kind: "vercel",
		name: "web",
		projectId: "prj_1",
	});
	expect(store.id).toBe("xs_1");
	expect(seen[0]?.method).toBe("POST");
	expect(seen[0]?.path).toBe("/api/vault/external/stores");
	expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({
		credentials: { token: "vc_token" },
		projectId: "prj_1",
	});
});

test("destinations are created, listed and pushed", async () => {
	const created = node({ destination: DESTINATION });
	await createVaultExternalDestination(created.target, {
		environment: "prod",
		path: "/web",
		remotePath: "WEB_",
		storeId: "xs_1",
	});
	expect(created.seen[0]?.path).toBe("/api/vault/external/destinations");
	const listed = node({ destinations: [DESTINATION] });
	expect(
		(await listVaultExternalDestinations(listed.target))[0]?.remotePath
	).toBe("WEB_");
	const pushed = node({ pushed: 4 });
	expect(await pushVaultExternalDestination(pushed.target, "xdst/1")).toBe(4);
	expect(pushed.seen[0]?.path).toBe(
		"/api/vault/external/destinations/xdst%2F1/push"
	);
});

test("a refusing store and a malformed reply surface as errors", async () => {
	const refused = node({
		ok: false,
		error: "AWS ListSecrets failed with HTTP 400",
	});
	expect(await testVaultExternalStore(refused.target, "xs_1")).toEqual({
		ok: false,
		error: "AWS ListSecrets failed with HTTP 400",
	});
	const malformed = node({ report: { written: "1" } });
	await expect(
		syncVaultExternalSource(malformed.target, "xsrc_1")
	).rejects.toThrow();
	const denied = node({ error: "vault_denied: admin required" }, 403);
	await expect(listVaultExternalDestinations(denied.target)).rejects.toThrow();
});
