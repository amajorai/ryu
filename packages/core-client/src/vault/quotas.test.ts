import { expect, test } from "bun:test";
import { deleteVaultQuota, listVaultQuotas, putVaultQuota } from "./quotas.ts";

interface Seen {
	body: unknown;
	method: string;
	url: string;
}

function fakeCore(reply: unknown) {
	const seen: Seen[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		seen.push({
			url: url.pathname,
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		return Promise.resolve(Response.json(reply));
	};
	return {
		seen,
		target: { url: "http://127.0.0.1:7777", token: "node-token", fetch },
	};
}

// `Quota` flattens the internally tagged `QuotaRule`; `blockIntervalSecs` is
// an `Option` without `skip_serializing_if`, so it is rendered as null.
const builtin = {
	name: "default-login",
	kind: "rate-limit",
	path: "auth/",
	rate: 60,
	intervalSecs: 60,
	blockIntervalSecs: null,
	builtin: true,
	createdAt: "1970-01-01T00:00:00+00:00",
	updatedAt: "1970-01-01T00:00:00+00:00",
};
const leaseCap = {
	name: "db-cap",
	kind: "lease-count",
	role: "db-*",
	maxLeases: 25,
	builtin: false,
	createdAt: "2030-01-01T00:00:00+00:00",
	updatedAt: "2030-01-01T00:00:00+00:00",
};

test("quotas list both rule kinds with live lease counts", async () => {
	const { seen, target } = fakeCore({
		quotas: [builtin, leaseCap],
		leases: { total: 3, byRole: { "db-prod": 3 } },
	});
	const listing = await listVaultQuotas(target);
	expect(seen[0]).toEqual({
		url: "/api/vault/sys/quotas",
		method: "GET",
		body: undefined,
	});
	expect(listing.leases).toEqual({ total: 3, byRole: { "db-prod": 3 } });
	const [first, second] = listing.quotas;
	expect(first?.kind === "rate-limit" && first.blockIntervalSecs).toBeNull();
	expect(second?.kind === "lease-count" && second.maxLeases).toBe(25);
});

test("a quota with an unknown kind is rejected", async () => {
	const { target } = fakeCore({
		quotas: [{ ...leaseCap, kind: "bandwidth" }],
		leases: { total: 0, byRole: {} },
	});
	await expect(listVaultQuotas(target)).rejects.toThrow();
});

test("put sends the tagged rule and delete encodes the name", async () => {
	const put = fakeCore({ quota: leaseCap });
	const saved = await putVaultQuota(put.target, "db cap", {
		kind: "lease-count",
		role: "db-*",
		maxLeases: 25,
	});
	expect(saved.quota.name).toBe("db-cap");
	expect(put.seen[0]).toEqual({
		url: "/api/vault/sys/quotas/db%20cap",
		method: "PUT",
		body: { kind: "lease-count", role: "db-*", maxLeases: 25 },
	});
	const rate = fakeCore({
		quota: { ...builtin, name: "agents", builtin: false },
	});
	await putVaultQuota(rate.target, "agents", {
		kind: "rate-limit",
		path: "agent/",
		rate: 10,
		blockIntervalSecs: 300,
	});
	expect(rate.seen[0]?.body).toEqual({
		kind: "rate-limit",
		path: "agent/",
		rate: 10,
		blockIntervalSecs: 300,
	});
	const removed = fakeCore({ deleted: false });
	expect(await deleteVaultQuota(removed.target, "gone")).toEqual({
		deleted: false,
	});
	expect(removed.seen[0]?.method).toBe("DELETE");
});
