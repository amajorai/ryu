import { expect, test } from "bun:test";
import { createVaultSshCa } from "./ssh.ts";

function fakeCore() {
	const calls: { body: unknown; method: string; path: string }[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			path: new URL(String(input)).pathname,
			method: init?.method ?? "GET",
			body: JSON.parse(String(init?.body)),
		});
		return Promise.resolve(
			Response.json({ publicKey: "ssh-ed25519 AAAA ryu-ca" })
		);
	};
	return {
		calls,
		target: { url: "http://127.0.0.1:7777", token: "node-token", fetch },
	};
}

test("a CA defaults to Core's Ed25519 and sends only the name", async () => {
	const { calls, target } = fakeCore();
	expect(await createVaultSshCa(target, "users")).toEqual({
		publicKey: "ssh-ed25519 AAAA ryu-ca",
	});
	expect(calls).toEqual([
		{ path: "/api/vault/ssh/cas", method: "POST", body: { name: "users" } },
	]);
});

test("keyType and keyBits are passed through for RSA and ECDSA CAs", async () => {
	const { calls, target } = fakeCore();
	await createVaultSshCa(target, "hosts", { keyType: "rsa", keyBits: 3072 });
	await createVaultSshCa(target, "edge", { keyType: "ecdsa" });
	expect(calls.map((call) => call.body)).toEqual([
		{ name: "hosts", keyType: "rsa", keyBits: 3072 },
		{ name: "edge", keyType: "ecdsa" },
	]);
});

test("certs, revoke and the binary KRL use the CA's routes", async () => {
	const calls: { method: string; path: string; body?: string }[] = [];
	const record = {
		ca: "users",
		serial: "18446744073709551615",
		keyId: "alice",
		validBefore: "2026-01-01T00:00:00Z",
		// Core renders `revokedAt` (epoch ms) as RFC 3339, or omits it.
		revokedAt: "2026-01-02T00:00:00Z",
	};
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		calls.push({
			method: init?.method ?? "GET",
			path,
			body: init?.body as string,
		});
		if (path.endsWith("/krl")) {
			return Promise.resolve(
				new Response(new Uint8Array([0x53, 0x53, 0x48, 0x4b]))
			);
		}
		return Promise.resolve(Response.json({ certificates: [record] }));
	};
	const target = { url: "http://127.0.0.1:7777", token: "t", fetch };
	const {
		listVaultSshCertificates,
		revokeVaultSshCertificates,
		getVaultSshKrl,
	} = await import("./ssh.ts");
	expect(
		(await listVaultSshCertificates(target, "users")).certificates[0]?.serial
	).toBe("18446744073709551615");
	await revokeVaultSshCertificates(target, "users", { keyId: "alice" });
	expect(Array.from(await getVaultSshKrl(target, "users"))).toEqual([
		0x53, 0x53, 0x48, 0x4b,
	]);
	expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"GET /api/vault/ssh/cas/users/certs",
		"POST /api/vault/ssh/cas/users/revoke",
		"GET /api/vault/ssh/cas/users/krl",
	]);
	expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ keyId: "alice" });
});

test("a refused KRL read surfaces Core's error", async () => {
	const fetch = () =>
		Promise.resolve(
			Response.json({ error: "vault_denied: no" }, { status: 403 })
		);
	const { getVaultSshKrl } = await import("./ssh.ts");
	const refused = await getVaultSshKrl(
		{ url: "http://127.0.0.1:7777", token: "node-secret-token", fetch },
		"users"
	).catch((error: unknown) => error);
	expect(refused).toBeInstanceOf(Error);
	expect(String((refused as Error).message)).toContain("403");
	expect(String((refused as Error).message)).not.toContain("node-secret-token");
});
