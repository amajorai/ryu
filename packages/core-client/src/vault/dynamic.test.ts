import { expect, test } from "bun:test";
import { forceRevokeVaultRetryLease } from "./dynamic.ts";

function fakeCore(reply: unknown) {
	const seen: { body: unknown; method: string; url: string }[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		seen.push({
			url: new URL(String(input)).pathname,
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

const lease = {
	id: "lease_a/b",
	role: "db",
	provider: "webhook",
	issuedTo: null,
	createdAt: "2026-11-16T00:00:00Z",
	expiresAt: "2026-11-16T00:00:00Z",
	maxExpiresAt: "2026-11-16T00:00:00Z",
	renewable: false,
	revokedAt: "2026-11-17T00:00:00Z",
	pendingRevoke: true,
};

test("force-revoke posts the acknowledgement to the encoded lease id", async () => {
	const { seen, target } = fakeCore({ lease });
	expect(
		await forceRevokeVaultRetryLease(target, "lease_a/b", {
			acknowledgeCredentialMayBeLive: true,
		})
	).toEqual({ lease });
	expect(seen).toEqual([
		{
			method: "POST",
			url: "/api/vault/sys/leases/force-revoke/lease_a%2Fb",
			body: { acknowledgeCredentialMayBeLive: true },
		},
	]);
});
