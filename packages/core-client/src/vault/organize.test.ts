import { expect, test } from "bun:test";
import {
	bulkVaultSecrets,
	listVaultNamespaceLocks,
	listVaultSecrets,
	listVaultTags,
	lockVaultNamespace,
	moveVaultFolder,
	moveVaultSecret,
	unlockVaultNamespace,
} from "../vault.ts";

interface Seen {
	body: unknown;
	method: string;
	url: string;
}

function target(reply: unknown, seen: Seen[]) {
	return {
		url: "http://core.test",
		token: null,
		fetch: (input: RequestInfo | URL, init?: RequestInit) => {
			seen.push({
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			return Promise.resolve(Response.json(reply));
		},
	};
}

test("moveVaultFolder posts the folder move and parses the report", async () => {
	const seen: Seen[] = [];
	const report = {
		environment: "dev",
		folders: 1,
		imports: 0,
		path: "/app",
		toEnvironment: "dev",
		toPath: "/svc",
		values: 3,
	};
	const result = await moveVaultFolder(
		target({ move: report, ok: true }, seen),
		{ environment: "dev", path: "/app", toPath: "/svc" }
	);
	expect(result.move.values).toBe(3);
	expect(seen[0]).toEqual({
		url: "http://core.test/api/vault/folders/move",
		method: "POST",
		body: { environment: "dev", path: "/app", toPath: "/svc" },
	});
});

test("moveVaultSecret posts to the value's move route", async () => {
	const seen: Seen[] = [];
	const secret = {
		scope: "user",
		scopeId: "u1",
		environment: "dev",
		path: "/",
		name: "NEW",
		version: 1,
		status: "active",
		metadata: {
			description: "",
			tags: [],
			expiresAt: null,
			rotationPeriodSecs: null,
			generator: null,
			expandReferences: false,
			maxVersions: 10,
		},
		capabilities: ["list"],
		createdAt: null,
		createdBy: null,
		updatedAt: null,
		updatedBy: null,
		rotatedAt: null,
	};
	const result = await moveVaultSecret(
		target({ ok: true, secret }, seen),
		"API KEY",
		{ scope: "user", toName: "NEW" }
	);
	expect(result.secret?.name).toBe("NEW");
	expect(seen[0]?.url).toBe(
		"http://core.test/api/vault/secrets/API%20KEY/move"
	);
	expect(seen[0]?.method).toBe("POST");
});

test("bulkVaultSecrets sends items and returns one result per item", async () => {
	const seen: Seen[] = [];
	const reply = {
		failed: 1,
		ok: false,
		results: [
			{
				index: 0,
				name: "A",
				ok: true,
				op: "set",
				result: { ok: true },
				status: 200,
			},
			{
				error: "vault_denied: no",
				index: 1,
				name: "B",
				ok: false,
				op: "delete",
				status: 403,
			},
		],
	};
	const result = await bulkVaultSecrets(target(reply, seen), [
		{ name: "A", op: "set", scope: "user", value: "1" },
		{ name: "B", op: "delete", scope: "user" },
	]);
	expect(result.results.map((item) => item.status)).toEqual([200, 403]);
	expect(result.results[1]?.error).toBe("vault_denied: no");
	expect(seen[0]?.url).toBe("http://core.test/api/vault/bulk");
	expect((seen[0]?.body as { items: unknown[] }).items).toHaveLength(2);
});

test("listVaultTags parses entities and in-use tags; listing passes the tag filter", async () => {
	const seen: Seen[] = [];
	const tags = await listVaultTags(
		target(
			{
				tags: [
					{ color: "#112233", count: 1, defined: true, slug: "pci" },
					{ count: 2, defined: false, slug: "prod" },
				],
			},
			seen
		)
	);
	expect(tags.tags.map((tag) => [tag.slug, tag.count])).toEqual([
		["pci", 1],
		["prod", 2],
	]);
	await listVaultSecrets(target({}, seen), { tags: ["pci", "prod"] }).catch(
		() => undefined
	);
	expect(seen[1]?.url).toBe(
		"http://core.test/api/vault/secrets?tag=pci%2Cprod"
	);
});

test("namespace locks list, lock and unlock", async () => {
	const seen: Seen[] = [];
	const lock = {
		environment: null,
		id: "vnl_1",
		lockedAt: "2026-11-12T00:00:00+00:00",
		lockedBy: "u1",
		path: null,
		reason: "incident",
		scope: "team",
		scopeId: "t1",
	};
	const listed = await listVaultNamespaceLocks(target({ locks: [lock] }, seen));
	expect(listed.locks[0]?.scopeId).toBe("t1");
	const locked = await lockVaultNamespace(target({ lock, ok: true }, seen), {
		scope: "team",
		scopeId: "t1",
		reason: "incident",
	});
	expect(locked.lock.id).toBe("vnl_1");
	expect(seen[1]?.method).toBe("POST");
	const removed = await unlockVaultNamespace(
		target({ ok: true, removed: true }, seen),
		"vnl_1"
	);
	expect(removed.removed).toBe(true);
	expect(seen[2]).toEqual({
		url: "http://core.test/api/vault/namespace-locks/vnl_1",
		method: "DELETE",
		body: undefined,
	});
});
