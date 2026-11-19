import { describe, expect, test } from "bun:test";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { ENGINE_HELP_LINES } from "../cli/secrets-help-engines.ts";
import { encoded, transitOptions } from "../cli/secrets-transit.ts";
import { fakeNode, json, runSecrets, TIMESTAMP } from "./secrets-fixture.ts";

const KEY = {
	name: "orders",
	type: "aes256-gcm96",
	latestVersion: 2,
	minDecryptionVersion: 1,
	deletionAllowed: false,
	createdAt: TIMESTAMP,
	publicKeys: [],
};

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function transitNode() {
	return fakeNode({
		"GET /api/vault/transit/keys": json({ keys: [KEY] }),
		"POST /api/vault/transit/keys": (call) =>
			Response.json({ key: { ...KEY, ...JSON.parse(call.body) } }),
		"DELETE /api/vault/transit/keys/orders": json({ deleted: true }),
		"POST /api/vault/transit/rotate/orders": json({
			key: { ...KEY, latestVersion: 3 },
		}),
		"POST /api/vault/transit/encrypt/orders": json({
			ciphertext: "vault:v2:abc",
		}),
		"POST /api/vault/transit/decrypt/orders": json({
			plaintext: b64("card 4242"),
		}),
		"POST /api/vault/transit/rewrap/orders": json({
			ciphertext: "vault:v3:def",
		}),
		"POST /api/vault/transit/sign/orders": json({ signature: "vault:v1:sig" }),
		"POST /api/vault/transit/hmac/orders": json({ hmac: "vault:v1:mac" }),
		"POST /api/vault/transit/verify/orders": (call) =>
			Response.json({
				valid: JSON.parse(call.body).signature === "vault:v1:sig",
			}),
		"POST /api/vault/transit/datakey/orders": json({
			plaintext: b64("key material"),
			ciphertext: "vault:v2:wrapped",
		}),
	});
}

function body(node: ReturnType<typeof transitNode>, route: string) {
	const call = node.calls.find((entry) => entry.route === route);
	return JSON.parse(call?.body ?? "{}");
}

describe("ryu-cli secrets transit", () => {
	test("keys lists, creates, rotates and deletes", async () => {
		const node = transitNode();
		const listed = await runSecrets(["transit", "keys"], node);
		expect(listed.code).toBe(0);
		expect(listed.out).toContain("orders");
		expect(listed.out).toContain("aes256-gcm96");

		const created = await runSecrets(
			["transit", "key", "create", "orders", "--type", "ed25519"],
			node
		);
		expect(created.code).toBe(0);
		expect(body(node, "POST /api/vault/transit/keys")).toEqual({
			name: "orders",
			type: "ed25519",
		});
		const rotated = await runSecrets(
			["transit", "key", "rotate", "orders"],
			node
		);
		expect(rotated.out).toContain("v3");
		const deleted = await runSecrets(
			["transit", "key", "delete", "orders"],
			node
		);
		expect(deleted.out).toContain("Deleted orders.");
	});

	test("encrypt sends base64 plaintext and the options; decrypt prints text", async () => {
		const node = transitNode();
		const encrypted = await runSecrets(
			[
				"transit",
				"encrypt",
				"orders",
				"card 4242",
				"--context",
				"tenant-1",
				"--key-version",
				"2",
			],
			node
		);
		expect(encrypted.code).toBe(0);
		expect(encrypted.out.trim()).toBe("vault:v2:abc");
		expect(body(node, "POST /api/vault/transit/encrypt/orders")).toEqual({
			plaintext: b64("card 4242"),
			context: b64("tenant-1"),
			keyVersion: 2,
		});

		const decrypted = await runSecrets(
			["transit", "decrypt", "orders", "vault:v2:abc"],
			node
		);
		expect(decrypted.out.trim()).toBe("card 4242");
		const raw = await runSecrets(
			["transit", "decrypt", "orders", "vault:v2:abc", "--base64"],
			node
		);
		expect(raw.out.trim()).toBe(b64("card 4242"));
	});

	test("text comes from stdin when omitted, without the trailing newline", async () => {
		const node = transitNode();
		const { code } = await runSecrets(["transit", "sign", "orders"], node, {
			readStdin: () => Promise.resolve("payload\n"),
		});
		expect(code).toBe(0);
		expect(body(node, "POST /api/vault/transit/sign/orders").input).toBe(
			b64("payload")
		);
		const terminal = await runSecrets(["transit", "hmac", "orders"], node, {
			readStdin: () => Promise.resolve(null),
		});
		expect(terminal.code).not.toBe(0);
		expect(terminal.err).toContain("pipe it in");
	});

	test("verify exits 1 for an invalid signature and needs exactly one of --signature or --hmac", async () => {
		const node = transitNode();
		const valid = await runSecrets(
			["transit", "verify", "orders", "payload", "--signature", "vault:v1:sig"],
			node
		);
		expect(valid.code).toBe(0);
		expect(valid.out.trim()).toBe("valid");
		const invalid = await runSecrets(
			["transit", "verify", "orders", "payload", "--signature", "vault:v1:bad"],
			node
		);
		expect(invalid.code).toBe(1);
		expect(invalid.out.trim()).toBe("invalid");
		for (const flags of [[], ["--signature", "a", "--hmac", "b"]]) {
			const refused = await runSecrets(
				["transit", "verify", "orders", "payload", ...flags],
				node
			);
			expect(refused.code).not.toBe(0);
			expect(refused.err).toContain("--signature or --hmac");
		}
	});

	test("decrypt and datakey are refused in an AI agent session; encrypt is not", async () => {
		const node = transitNode();
		const agent = { env: { HOME: "/home/me", CLAUDECODE: "1" } };
		for (const argv of [
			["transit", "decrypt", "orders", "vault:v2:abc"],
			["transit", "datakey", "orders"],
		]) {
			const refused = await runSecrets(argv, node, agent);
			expect(refused.code).not.toBe(0);
			expect(refused.out).not.toContain("card 4242");
			expect(refused.out).not.toContain(b64("key material"));
		}
		expect(
			node.calls.some(
				(call) =>
					call.route.includes("/decrypt/") || call.route.includes("/datakey/")
			)
		).toBe(false);
		const allowed = await runSecrets(
			["transit", "encrypt", "orders", "x"],
			node,
			agent
		);
		expect(allowed.code).toBe(0);
	});

	test("--base64 input must be standard base64 and option values are checked", () => {
		const args = (raw: string[]) => parseSecretsArgs(["transit", ...raw]);
		expect(encoded(args([]), "hi")).toBe(b64("hi"));
		expect(encoded(args(["--base64"]), " aGk= ")).toBe("aGk=");
		expect(() => encoded(args(["--base64"]), "not base64!")).toThrow("base64");
		expect(() => transitOptions(args(["--key-version", "0"]))).toThrow(
			"1 or more"
		);
		expect(() =>
			transitOptions(args(["--signature-algorithm", "md5"]))
		).toThrow("pss or pkcs1v15");
		expect(transitOptions(args(["--associated-data", "aad"]))).toEqual({
			associatedData: b64("aad"),
		});
	});

	test("help lists the transit commands", async () => {
		expect(ENGINE_HELP_LINES.join("\n")).toContain("transit encrypt KEY");
		const { out } = await runSecrets(["help"], transitNode());
		expect(out).toContain("transit verify KEY");
	});

	test("flags before the action never let decrypt past the agent guard", async () => {
		const node = transitNode();
		const agent = { env: { HOME: "/home/me", CLAUDECODE: "1" } };
		for (const argv of [
			["transit", "--base64", "decrypt", "orders", "vault:v2:abc"],
			["transit", "--context", "x", "decrypt", "orders", "vault:v2:abc"],
			["transit", "--json", "datakey", "orders"],
		]) {
			const refused = await runSecrets(argv, node, agent);
			expect(refused.code).not.toBe(0);
			expect(refused.out).not.toContain("card 4242");
		}
		expect(node.calls.length).toBe(0);
	});

	test("datakey sends the context and key version", async () => {
		const node = transitNode();
		const { code } = await runSecrets(
			[
				"transit",
				"datakey",
				"orders",
				"--context",
				"tenant-1",
				"--key-version",
				"2",
			],
			node
		);
		expect(code).toBe(0);
		expect(body(node, "POST /api/vault/transit/datakey/orders")).toEqual({
			context: b64("tenant-1"),
			keyVersion: 2,
		});
	});

	test("line-wrapped base64 is accepted and only one trailing newline is dropped", async () => {
		const args = parseSecretsArgs(["transit", "--base64"]);
		const long = b64("x".repeat(120));
		const wrapped = `${long.slice(0, 76)}\n${long.slice(76)}\n`;
		expect(encoded(args, wrapped)).toBe(long);
		expect(encoded(args, "")).toBe("");
		expect(() => encoded(args, "aG=k")).toThrow("base64");

		const node = transitNode();
		await runSecrets(["transit", "encrypt", "orders", "-"], node, {
			readStdin: () => Promise.resolve("line\r\n"),
		});
		expect(body(node, "POST /api/vault/transit/encrypt/orders").plaintext).toBe(
			b64("line")
		);
	});
});
