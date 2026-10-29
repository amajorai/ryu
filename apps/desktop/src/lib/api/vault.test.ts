import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
// Wire tests for the Vault client: query strings, request bodies, the 202
// change-request branch, and defaults for fields an older Core omits.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	decideVaultChangeRequest,
	deleteVaultSecret,
	exportVaultSecrets,
	listVaultAudit,
	listVaultSecrets,
	listVaultVersions,
	normalizeVaultSecret,
	revealVaultSecret,
	rollbackVaultSecret,
	setVaultSecret,
	unsealVault,
	type VaultChangeRequest,
	vaultQueryString,
} from "./vault.ts";

const TARGET: ApiTarget = {
	url: "http://127.0.0.1:7777",
	token: "node-token",
	userJwt: null,
};

interface Captured {
	body: unknown;
	method: string;
	url: string;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** Answer every call with `payload` and `status`, recording each request. */
function stubFetch<TFixture>(payload: TFixture, status = 200): Captured[] {
	const calls: Captured[] = [];
	globalThis.fetch = createFetchFixture(originalFetch, async (input, init) => {
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			body: isNativeText(init?.body) ? JSON.parse(init.body) : undefined,
		});
		const text = JSON.stringify(payload);
		return new Response(text, {
			status,
			headers: { "content-type": "application/json" },
		});
	});
	return calls;
}

const SECRET = {
	name: "API_KEY",
	scope: "user",
	scopeId: "local",
	environment: "prod",
	path: "/payments",
	version: 3,
	status: "active",
	metadata: {
		description: "",
		tags: [],
		expiresAt: null,
		rotationPeriodSecs: null,
		generator: null,
		expandReferences: false,
		maxVersions: 20,
	},
	capabilities: ["list", "read", "write"],
	createdAt: "2026-10-01T00:00:00Z",
	createdBy: null,
	updatedAt: "2026-10-02T00:00:00Z",
	updatedBy: null,
	rotatedAt: "2026-10-02T00:00:00Z",
};

function pendingChangeRequest(id: string): VaultChangeRequest {
	return {
		id,
		status: "pending",
		operation: "write",
		approvals: [],
		coords: {
			environment: "default",
			name: "API_KEY",
			path: "/",
			scope: "user",
			scopeId: "local",
		},
		decidedAt: null,
		decidedBy: null,
		hasValue: true,
		patch: {},
		reason: null,
		requestedAt: "2026-10-09T00:00:00Z",
		requestedBy: "local",
		requiredApprovals: 1,
	};
}

describe("vaultQueryString", () => {
	test("drops undefined and empty values", () => {
		expect(vaultQueryString({})).toBe("");
		expect(
			vaultQueryString({ environment: "prod", path: undefined, limit: 5 })
		).toBe("?environment=prod&limit=5");
		expect(vaultQueryString({ path: "/a b" })).toBe("?path=%2Fa+b");
	});
});

describe("listVaultSecrets", () => {
	test("sends filters and fills defaults for an older Core", async () => {
		const calls = stubFetch({
			secrets: [{ name: "OLD", scope: "node", scopeId: "n1", updatedAt: "x" }],
			node: {
				id: "n1",
				scope: "local",
				orgId: null,
				teamId: null,
				ownerUserId: null,
			},
			caller: null,
			canManageShared: false,
		});
		const state = await listVaultSecrets(TARGET, {
			environment: "prod",
			includeDeleted: true,
		});
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:7777/api/vault/secrets?environment=prod&includeDeleted=true"
		);
		expect(state.activeEnvironment).toBe("default");
		expect(state.sharedRemote).toBe(false);
		expect(state.seal).toBeNull();
		expect(state.secrets[0]).toMatchObject({
			environment: "default",
			path: "/",
			version: 1,
			status: "active",
			capabilities: [],
		});
		expect(state.secrets[0]?.metadata.tags).toEqual([]);
	});

	test("omits includeDeleted when false", async () => {
		const calls = stubFetch({
			secrets: [],
			node: {
				id: "n1",
				scope: "local",
				orgId: null,
				teamId: null,
				ownerUserId: null,
			},
			caller: null,
			canManageShared: false,
		});
		await listVaultSecrets(TARGET, { includeDeleted: false });
		expect(calls[0]?.url).toBe("http://127.0.0.1:7777/api/vault/secrets");
	});
});

test("normalizeVaultSecret marks a value with deletedAt as deleted", () => {
	expect(
		normalizeVaultSecret({ name: "X", deletedAt: "2026-10-01T00:00:00Z" })
			.status
	).toBe("deleted");
});

describe("setVaultSecret", () => {
	test("returns the applied secret on 200", async () => {
		const calls = stubFetch({ ok: true, secret: SECRET });
		const result = await setVaultSecret(TARGET, "API_KEY", {
			scope: "user",
			environment: "prod",
			path: "/payments",
			metadata: { description: "Stripe" },
			expectedVersion: 3,
		});
		expect(result.kind).toBe("applied");
		expect(calls[0]).toMatchObject({
			method: "PUT",
			url: "http://127.0.0.1:7777/api/vault/secrets/API_KEY",
			body: {
				scope: "user",
				environment: "prod",
				path: "/payments",
				metadata: { description: "Stripe" },
				expectedVersion: 3,
			},
		});
	});

	test("returns the change request on 202", async () => {
		stubFetch({ ok: true, changeRequest: pendingChangeRequest("vcr_1") }, 202);
		const result = await setVaultSecret(TARGET, "API_KEY", {
			scope: "node",
			value: "v",
		});
		expect(result.kind).toBe("pending");
		if (result.kind === "pending") {
			expect(result.changeRequest.id).toBe("vcr_1");
		}
	});

	test("surfaces a stale expectedVersion as a 409 ApiError", async () => {
		stubFetch({ error: "vault_conflict: version 4 is current" }, 409);
		await expect(
			setVaultSecret(TARGET, "API_KEY", { scope: "user", expectedVersion: 3 })
		).rejects.toMatchObject({ status: 409 });
	});
});

test("deleteVaultSecret sends coordinates and detects a change request", async () => {
	const calls = stubFetch(
		{ ok: true, changeRequest: pendingChangeRequest("vcr_2") },
		202
	);
	const result = await deleteVaultSecret(TARGET, "API_KEY", {
		scope: "user",
		environment: "prod",
		path: "/",
	});
	expect(result.kind).toBe("pending");
	expect(calls[0]).toMatchObject({
		method: "DELETE",
		body: { scope: "user", environment: "prod", path: "/" },
	});
});

test("listVaultVersions puts coordinates and the MCP binding in the query", async () => {
	const calls = stubFetch({
		versions: [
			{
				version: 2,
				current: true,
				createdAt: "2026-10-09T00:00:00Z",
				createdBy: null,
				destroyed: false,
				source: "write",
			},
		],
	});
	const versions = await listVaultVersions(TARGET, "API_KEY", {
		scope: "user",
		scopeId: "local",
		environment: "prod",
		path: "/payments",
		binding: { kind: "mcp", id: "github" },
	});
	expect(versions).toHaveLength(1);
	expect(calls[0]?.url).toBe(
		"http://127.0.0.1:7777/api/vault/secrets/API_KEY/versions?scope=user&scopeId=local&environment=prod&path=%2Fpayments&mcpId=github"
	);
});

test("revealVaultSecret returns the value and rejects a missing one", async () => {
	const calls = stubFetch({ value: "s3cret" });
	expect(await revealVaultSecret(TARGET, "API_KEY", { scope: "user" })).toBe(
		"s3cret"
	);
	expect(calls[0]).toMatchObject({
		method: "POST",
		url: "http://127.0.0.1:7777/api/vault/secrets/API_KEY/reveal",
		body: { scope: "user" },
	});
	stubFetch({});
	await expect(
		revealVaultSecret(TARGET, "API_KEY", { scope: "user" })
	).rejects.toThrow();
});

test("rollbackVaultSecret sends the version", async () => {
	const calls = stubFetch({ ok: true, secret: SECRET });
	const secret = await rollbackVaultSecret(
		TARGET,
		"API_KEY",
		{ scope: "user" },
		2
	);
	expect(secret.version).toBe(3);
	expect(calls[0]?.body).toEqual({ scope: "user", version: 2 });
});

test("exportVaultSecrets posts the format", async () => {
	const calls = stubFetch({
		content: "A=1\n",
		count: 1,
		format: "dotenv",
		contentType: "text/plain",
		environment: "prod",
		path: "/payments",
	});
	const result = await exportVaultSecrets(TARGET, {
		format: "dotenv",
		environment: "prod",
	});
	expect(result.count).toBe(1);
	expect(calls[0]?.body).toEqual({ format: "dotenv", environment: "prod" });
});

test("decideVaultChangeRequest posts to the decision route", async () => {
	const calls = stubFetch({
		ok: true,
		changeRequest: pendingChangeRequest("vcr_1"),
	});
	await decideVaultChangeRequest(TARGET, "vcr_1", "approve");
	expect(calls[0]?.url).toBe(
		"http://127.0.0.1:7777/api/vault/change-requests/vcr_1/approve"
	);
});

test("listVaultAudit pages and defaults nextBefore", async () => {
	const calls = stubFetch({ events: [] });
	const page = await listVaultAudit(TARGET, { limit: 50, before: 10 });
	expect(page.nextBefore).toBeNull();
	expect(calls[0]?.url).toBe(
		"http://127.0.0.1:7777/api/vault/audit?before=10&limit=50"
	);
});

test("unsealVault sends a share only when given", async () => {
	const calls = stubFetch({
		seal: {
			sealed: true,
			progress: 1,
			activeKeyVersion: 1,
			keyVersions: [1],
			mode: "shamir",
			shares: 3,
			threshold: 2,
		},
	});
	await unsealVault(TARGET, "share-1");
	await unsealVault(TARGET);
	expect(calls[0]?.body).toEqual({ share: "share-1" });
	expect(calls[1]?.body).toEqual({});
});
