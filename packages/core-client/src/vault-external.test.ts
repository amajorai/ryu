import { expect, test } from "bun:test";
import {
	createVaultExternalDestination,
	createVaultExternalStore,
	deleteVaultExternalStore,
	isVaultSyncTarget,
	listVaultExternalDestinations,
	pushVaultExternalDestination,
	testVaultExternalStore,
	VAULT_EXTERNAL_AUTH_METHODS,
} from "./vault-external.ts";

interface Seen {
	body: unknown;
	method: string;
	url: string;
}

function fakeCore(replies: Record<string, unknown>, status = 200) {
	const seen: Seen[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		seen.push({
			url: url.pathname,
			method,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		const body = replies[`${method} ${url.pathname}`] ?? { error: "missing" };
		return Promise.resolve(Response.json(body, { status }));
	};
	return {
		seen,
		target: { url: "http://127.0.0.1:7777", token: "node-token", fetch },
	};
}

const store = {
	id: "xs_1",
	name: "acme-ci",
	kind: "github-actions",
	address: "https://api.github.com",
	authMethod: "token",
	repository: "acme/app",
	mount: "",
	pathPrefix: "",
	projectId: "",
	createdAt: 1,
	updatedAt: 1,
};

test("a sync target is created with write-only credentials and its settings", async () => {
	const { seen, target } = fakeCore({
		"POST /api/vault/external/stores": { store },
	});
	const created = await createVaultExternalStore(target, {
		name: "acme-ci",
		kind: "github-actions",
		authMethod: "token",
		repository: "acme/app",
		githubEnvironment: "production",
		credentials: { token: "ghp_secret" },
	});
	expect(created.store.repository).toBe("acme/app");
	expect(seen[0]).toEqual({
		url: "/api/vault/external/stores",
		method: "POST",
		body: {
			name: "acme-ci",
			kind: "github-actions",
			authMethod: "token",
			repository: "acme/app",
			githubEnvironment: "production",
			credentials: { token: "ghp_secret" },
		},
	});
});

test("destinations push on demand and ids are path-encoded", async () => {
	const destination = {
		id: "xdst/1",
		storeId: "xs_1",
		environment: "prod",
		path: "/web",
		remotePath: "WEB_",
		dirty: true,
		failures: 0,
		intervalSecs: 3600,
		lastCount: 0,
		lastError: null,
		lastPushAt: null,
		lastStatus: null,
	};
	const { seen, target } = fakeCore({
		"POST /api/vault/external/destinations": { destination },
		"GET /api/vault/external/destinations": { destinations: [destination] },
		"POST /api/vault/external/destinations/xdst%2F1/push": { pushed: 2 },
		"POST /api/vault/external/stores/xs_1/test": {
			ok: false,
			error: "GitHub public key failed with HTTP 401",
		},
		"DELETE /api/vault/external/stores/xs_1": { deleted: true },
	});
	await createVaultExternalDestination(target, {
		storeId: "xs_1",
		environment: "prod",
		path: "/web",
		remotePath: "WEB_",
	});
	expect(
		(await listVaultExternalDestinations(target)).destinations[0]?.remotePath
	).toBe("WEB_");
	expect((await pushVaultExternalDestination(target, "xdst/1")).pushed).toBe(2);
	expect(await testVaultExternalStore(target, "xs_1")).toEqual({
		ok: false,
		error: "GitHub public key failed with HTTP 401",
	});
	expect((await deleteVaultExternalStore(target, "xs_1")).deleted).toBe(true);
	expect(seen.map((call) => `${call.method} ${call.url}`)).toEqual([
		"POST /api/vault/external/destinations",
		"GET /api/vault/external/destinations",
		"POST /api/vault/external/destinations/xdst%2F1/push",
		"POST /api/vault/external/stores/xs_1/test",
		"DELETE /api/vault/external/stores/xs_1",
	]);
});

test("errors and malformed replies are rejected", async () => {
	const refused = fakeCore(
		{ "GET /api/vault/external/destinations": { error: "vault_denied: no" } },
		403
	);
	await expect(listVaultExternalDestinations(refused.target)).rejects.toThrow();
	const malformed = fakeCore({
		"GET /api/vault/external/destinations": { destinations: [{ id: 1 }] },
	});
	await expect(
		listVaultExternalDestinations(malformed.target)
	).rejects.toThrow();
});

test("sync targets and their auth methods match Core", () => {
	expect(isVaultSyncTarget("vercel")).toBe(true);
	expect(isVaultSyncTarget("openbao")).toBe(false);
	expect(VAULT_EXTERNAL_AUTH_METHODS["aws-secrets-manager"]).toEqual([
		"access-key",
	]);
	expect(VAULT_EXTERNAL_AUTH_METHODS["gcp-secret-manager"]).toContain(
		"service-account"
	);
});
