import { describe, expect, test } from "bun:test";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { sshCaOptions } from "../cli/secrets-ssh.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

function sshNode() {
	return fakeNode({
		"GET /api/vault/ssh/cas": json({
			cas: [{ name: "users", publicKey: "ssh-ed25519 AAAA users" }],
		}),
		"POST /api/vault/ssh/cas": json({ publicKey: "ssh-rsa AAAB hosts" }),
	});
}

describe("ryu secrets ssh", () => {
	test("cas lists each CA's public key", async () => {
		const { code, out } = await runSecrets(["ssh", "cas"], sshNode());
		expect(code).toBe(0);
		expect(out).toContain("users");
		expect(out).toContain("ssh-ed25519 AAAA users");
	});

	test("ca create passes the key type and size Core accepts", async () => {
		const node = sshNode();
		const { code, out } = await runSecrets(
			[
				"ssh",
				"ca",
				"create",
				"hosts",
				"--key-type",
				"RSA",
				"--key-bits",
				"3072",
			],
			node
		);
		expect(code).toBe(0);
		expect(out).toBe("ssh-rsa AAAB hosts\n");
		expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({
			name: "hosts",
			keyType: "rsa",
			keyBits: 3072,
		});
		await runSecrets(["ssh", "ca", "create", "users"], node);
		expect(JSON.parse(node.calls[1]?.body ?? "{}")).toEqual({ name: "users" });
	});

	test("an unknown key type or bits without a type send nothing", async () => {
		const node = sshNode();
		const dsa = await runSecrets(
			["ssh", "ca", "create", "old", "--key-type", "dsa"],
			node
		);
		expect(dsa.code).not.toBe(0);
		expect(dsa.err).toContain("ed25519, rsa, ecdsa");
		const bits = await runSecrets(
			["ssh", "ca", "create", "old", "--key-bits", "384"],
			node
		);
		expect(bits.code).not.toBe(0);
		expect(node.calls).toEqual([]);
	});

	test("sshCaOptions lowercases the type and leaves defaults to Core", () => {
		expect(sshCaOptions(parseSecretsArgs(["ssh"]))).toEqual({});
		expect(
			sshCaOptions(
				parseSecretsArgs(["ssh", "--key-type", "ECDSA", "--key-bits", "384"])
			)
		).toEqual({ keyType: "ecdsa", keyBits: 384 });
	});
});
