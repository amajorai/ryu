import { expect, test } from "bun:test";
import * as vault from "../vault.ts";
import {
	createVaultSshOtp,
	deleteVaultSshOtpRole,
	listVaultSshOtpRoles,
	putVaultSshOtpRole,
} from "./ssh-otp.ts";

const ROLE = {
	name: "web",
	defaultUser: "deploy",
	allowedUsers: ["ops-*"],
	cidrList: ["10.0.0.0/24"],
	excludeCidrList: ["10.0.0.9/32"],
	port: 22,
	ttlSecs: 600,
};
const CREDENTIAL = {
	key: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
	keyType: "otp",
	username: "deploy",
	ip: "10.0.0.5",
	port: 22,
	expiresAt: "2026-11-17T10:10:00+00:00",
};

interface Call {
	body: string | undefined;
	method: string;
	/** The raw request path, before URL decoding. */
	path: string;
}

function fakeCore(reply: unknown, status = 200) {
	const calls: Call[] = [];
	const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			path: new URL(String(input)).pathname,
			method: init?.method ?? "GET",
			body: init?.body === undefined ? undefined : String(init.body),
		});
		return Promise.resolve(Response.json(reply, { status }));
	};
	return {
		calls,
		target: { url: "http://127.0.0.1:7777", token: "node-token", fetch },
	};
}

test("roles are listed from the otp-roles route", async () => {
	const { calls, target } = fakeCore({ roles: [ROLE] });
	expect(await listVaultSshOtpRoles(target)).toEqual({ roles: [ROLE] });
	expect(calls).toEqual([
		{ path: "/api/vault/ssh/otp-roles", method: "GET", body: undefined },
	]);
});

test("a role is PUT under its encoded name with only the given fields", async () => {
	const { calls, target } = fakeCore({ role: ROLE });
	const input = { defaultUser: "deploy", cidrList: ["10.0.0.0/24"] };
	expect(await putVaultSshOtpRole(target, "web", input)).toEqual({
		role: ROLE,
	});
	await putVaultSshOtpRole(target, "a b/c", { ...input, port: 2222 });
	expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
		"PUT /api/vault/ssh/otp-roles/web",
		"PUT /api/vault/ssh/otp-roles/a%20b%2Fc",
	]);
	expect(calls.map((call) => JSON.parse(call.body ?? "null"))).toEqual([
		input,
		{ ...input, port: 2222 },
	]);
});

test("delete sends no body and returns Core's flag", async () => {
	const { calls, target } = fakeCore({ deleted: false });
	expect(await deleteVaultSshOtpRole(target, "web/../x")).toEqual({
		deleted: false,
	});
	expect(calls).toEqual([
		{
			path: "/api/vault/ssh/otp-roles/web%2F..%2Fx",
			method: "DELETE",
			body: undefined,
		},
	]);
});

test("an OTP is requested from creds/ROLE with the ip and optional username", async () => {
	const { calls, target } = fakeCore({ credential: CREDENTIAL });
	expect(await createVaultSshOtp(target, "web", { ip: "10.0.0.5" })).toEqual({
		credential: { ...CREDENTIAL, keyType: "otp" },
	});
	await createVaultSshOtp(target, "w?x", { ip: "::1", username: "ops-1" });
	expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
		"POST /api/vault/ssh/creds/web",
		"POST /api/vault/ssh/creds/w%3Fx",
	]);
	expect(calls.map((call) => JSON.parse(call.body ?? "null"))).toEqual([
		{ ip: "10.0.0.5" },
		{ ip: "::1", username: "ops-1" },
	]);
});

test("replies that do not match Core's shapes are refused", async () => {
	for (const reply of [
		{ credential: { ...CREDENTIAL, keyType: "dynamic" } },
		{ credential: { ...CREDENTIAL, key: undefined } },
	]) {
		const { target } = fakeCore(reply);
		await expect(
			createVaultSshOtp(target, "web", { ip: "10.0.0.5" })
		).rejects.toThrow();
	}
	const { target } = fakeCore({ roles: [{ ...ROLE, cidrList: "10.0.0.0/8" }] });
	await expect(listVaultSshOtpRoles(target)).rejects.toThrow();
});

test("a refused request surfaces Core's error without the node token", async () => {
	const { target } = fakeCore({ error: "vault_denied: no" }, 403);
	const refused = await createVaultSshOtp(target, "web", {
		ip: "10.0.0.5",
	}).catch((error: unknown) => error);
	expect(refused).toBeInstanceOf(Error);
	expect(String((refused as Error).message)).toContain("403");
	expect(String((refused as Error).message)).not.toContain("node-token");
});

test("there is no client for the consuming verify route", () => {
	const names = Object.keys(vault).filter((name) => /SshOtp/.test(name));
	expect(names.sort()).toEqual([
		"createVaultSshOtp",
		"deleteVaultSshOtpRole",
		"listVaultSshOtpRoles",
		"putVaultSshOtpRole",
	]);
});
