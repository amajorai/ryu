import { expect, test } from "bun:test";
import {
	claimVaultShareRequest,
	listVaultShareLinks,
	requestVaultCredential,
	requestVaultSecret,
	revokeVaultShareLink,
	shareVaultSecret,
	shareVaultWrapToken,
} from "./shares.ts";

const link = {
	expiresAt: "2026-11-10T00:00:00.000Z",
	id: "vs_1",
	url: "https://ryu.example/secret/t#k",
};

function target(reply: unknown) {
	const seen: { body: unknown; method: string; path: string }[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		seen.push({
			body: init?.body ? JSON.parse(String(init.body)) : null,
			method: init?.method ?? "GET",
			path: new URL(String(input)).pathname,
		});
		return Promise.resolve(Response.json(reply));
	};
	return {
		seen,
		target: { url: "http://127.0.0.1:7777", token: "node", fetch },
	};
}

test("shares a value or a wrap token and asks for one", async () => {
	const { seen, target: t } = target({ link });
	expect(
		(
			await shareVaultSecret(t, "DB_PASSWORD", {
				label: "Staging",
				ttlSecs: 600,
			})
		).link
	).toEqual(link);
	await shareVaultWrapToken(t, "rvw_abc");
	await requestVaultSecret(t, "STRIPE_KEY", "Your key", {
		environment: "prod",
	});
	expect(seen).toEqual([
		{
			body: { label: "Staging", name: "DB_PASSWORD", ttlSecs: 600 },
			method: "POST",
			path: "/api/vault/shares",
		},
		{
			body: { wrapToken: "rvw_abc" },
			method: "POST",
			path: "/api/vault/shares",
		},
		{
			body: { environment: "prod", label: "Your key", name: "STRIPE_KEY" },
			method: "POST",
			path: "/api/vault/share-requests",
		},
	]);
});

test("asks for an agent's sign-in to a site", async () => {
	const { seen, target: t } = target({ link });
	expect(
		(
			await requestVaultCredential(t, "github.com", "Release bot", {
				agentId: "agent-1",
				totp: true,
			})
		).link
	).toEqual(link);
	expect(seen).toEqual([
		{
			body: {
				agentId: "agent-1",
				label: "Release bot",
				site: "github.com",
				totp: true,
			},
			method: "POST",
			path: "/api/vault/credential-requests",
		},
	]);
});

test("lists, claims and revokes links", async () => {
	const listed = target({
		links: [
			{
				createdAt: "2026-11-09T00:00:00Z",
				createdBy: "u1",
				expiresAt: "2026-11-10T00:00:00Z",
				id: "vr_1",
				kind: "request",
				label: "Key",
				status: "open",
				target: { name: "K" },
			},
		],
	});
	expect((await listVaultShareLinks(listed.target)).links[0]?.id).toBe("vr_1");
	const claim = target({ ok: true });
	expect(await claimVaultShareRequest(claim.target, "vr/1")).toEqual({
		ok: true,
	});
	expect(claim.seen[0]?.path).toBe("/api/vault/shares/vr%2F1/claim");
	const revoke = target({ revoked: true });
	expect(await revokeVaultShareLink(revoke.target, "vs_1")).toEqual({
		revoked: true,
	});
	expect(revoke.seen[0]?.method).toBe("DELETE");
	await expect(shareVaultSecret(target({}).target, "A")).rejects.toThrow();
});
