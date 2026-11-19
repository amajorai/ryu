import { expect, test } from "bun:test";
import {
	deleteVaultIdentityRole,
	getVaultIdentityConfig,
	getVaultIdentityJwks,
	listVaultIdentityRoles,
	mintVaultIdentityToken,
	putVaultIdentityRole,
	rotateVaultIdentityKey,
	setVaultIdentityConfig,
	vaultAgentIdentityToken,
} from "./identity-tokens.ts";

interface Seen {
	body: unknown;
	headers: Headers;
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
			headers: new Headers(init?.headers),
		});
		return Promise.resolve(Response.json(reply));
	};
	return {
		seen,
		target: { url: "http://127.0.0.1:7777", token: "node-token", fetch },
	};
}

const role = {
	name: "aws-deploy",
	audience: "sts.amazonaws.com",
	ttlSecs: 900,
	template: null,
};

test("issuer config is read and written on /identity/config", async () => {
	const config = {
		issuer: "https://vault.example",
		rotationPeriodSecs: 86_400,
	};
	const { seen, target } = fakeCore({ config });
	expect(await getVaultIdentityConfig(target)).toEqual({ config });
	await setVaultIdentityConfig(target, { issuer: "https://vault.example" });
	expect(seen.map((call) => `${call.method} ${call.url}`)).toEqual([
		"GET /api/vault/identity/config",
		"PUT /api/vault/identity/config",
	]);
	expect(seen[1]?.body).toEqual({ issuer: "https://vault.example" });
	const unset = fakeCore({ config: { issuer: null, rotationPeriodSecs: 1 } });
	expect((await getVaultIdentityConfig(unset.target)).config.issuer).toBeNull();
});

test("roles list, put (name from the path), and delete", async () => {
	const listing = fakeCore({ roles: [role] });
	expect((await listVaultIdentityRoles(listing.target)).roles).toEqual([role]);
	const put = fakeCore({ role });
	await putVaultIdentityRole(put.target, "aws deploy", {
		audience: "sts.amazonaws.com",
		ttlSecs: 900,
	});
	expect(put.seen[0]).toMatchObject({
		method: "PUT",
		url: "/api/vault/identity/roles/aws%20deploy",
		body: { audience: "sts.amazonaws.com", ttlSecs: 900 },
	});
	const deleted = fakeCore({ deleted: true });
	expect(await deleteVaultIdentityRole(deleted.target, "aws-deploy")).toEqual({
		deleted: true,
	});
	expect(deleted.seen[0]?.method).toBe("DELETE");
	const rotated = fakeCore({ kid: "k2" });
	expect(await rotateVaultIdentityKey(rotated.target)).toEqual({ kid: "k2" });
	expect(rotated.seen[0]?.url).toBe("/api/vault/identity/keys/rotate");
});

test("minting as a user sends the node bearer; as a machine only the vault token", async () => {
	const token = {
		token: "eyJ.identity.jwt",
		role: "aws-deploy",
		ttlSecs: 900,
		expiresAt: "2030-01-01T00:15:00Z",
	};
	const human = fakeCore({ token });
	expect(await mintVaultIdentityToken(human.target, "aws-deploy")).toEqual({
		token,
	});
	expect(human.seen[0]?.url).toBe("/api/vault/identity/token/aws-deploy");
	expect(human.seen[0]?.headers.get("authorization")).toBe("Bearer node-token");
	const machine = fakeCore({
		token: { ...token, expiresAt: 1_893_456_900_000 },
	});
	const minted = await vaultAgentIdentityToken(
		{
			url: machine.target.url,
			fetch: machine.target.fetch,
			vaultToken: "rvt_x",
		},
		"aws-deploy"
	);
	expect(minted.token.expiresAt).toBe(1_893_456_900_000);
	expect(machine.seen[0]?.url).toBe(
		"/api/vault/agent/identity/token/aws-deploy"
	);
	expect(machine.seen[0]?.headers.get("x-ryu-vault-token")).toBe("rvt_x");
	expect(machine.seen[0]?.headers.get("authorization")).toBeNull();
});

test("a malformed token reply is rejected, and the JWKS is public", async () => {
	const bad = fakeCore({ token: { role: "x" } });
	await expect(mintVaultIdentityToken(bad.target, "x")).rejects.toThrow();
	const jwks = fakeCore({ keys: [{ kid: "k1", kty: "EC" }] });
	expect(
		await getVaultIdentityJwks({
			url: jwks.target.url,
			fetch: jwks.target.fetch,
		})
	).toEqual({ keys: [{ kid: "k1", kty: "EC" }] });
	expect(jwks.seen[0]?.url).toBe("/api/vault/identity/.well-known/keys");
	expect(jwks.seen[0]?.headers.get("authorization")).toBeNull();
});
