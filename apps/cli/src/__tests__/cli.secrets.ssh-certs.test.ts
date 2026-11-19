import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { publicKeyLine, signInput } from "../cli/secrets-ssh-certs.ts";
import { fakeNode, json, runSecrets, TIMESTAMP } from "./secrets-fixture.ts";

function blob(type: string): string {
	const name = Buffer.from(type, "latin1");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(name.length);
	const key = Buffer.alloc(36, 7);
	key.writeUInt32BE(32);
	return Buffer.concat([length, name, key]).toString("base64");
}
const PUBLIC = `ssh-ed25519 ${blob("ssh-ed25519")} alice@laptop`;
/** What reaches Core: the key without its comment. */
const SENT = `ssh-ed25519 ${blob("ssh-ed25519")}`;
const CERT = "ssh-ed25519-cert-v01@openssh.com AAAAcert alice";
const ROLE = {
	name: "dev",
	ca: "users",
	certType: "user",
	allowedPrincipals: ["alice"],
	defaultTtlSecs: 3600,
	maxTtlSecs: 3600,
	extensions: [],
};
const RECORD = {
	ca: "users",
	serial: "18446744073709551615",
	keyId: "alice",
	validBefore: TIMESTAMP,
};

function sshNode() {
	return fakeNode({
		"GET /api/vault/ssh/roles": json({ roles: [ROLE] }),
		"PUT /api/vault/ssh/roles/dev": (call) =>
			Response.json({ role: { name: "dev", ...JSON.parse(call.body) } }),
		"DELETE /api/vault/ssh/roles/dev": json({ deleted: true }),
		"POST /api/vault/ssh/sign/dev": json({
			certificate: {
				certificate: CERT,
				keyId: "alice",
				principals: ["alice"],
				serial: 7,
				validAfter: TIMESTAMP,
				validBefore: TIMESTAMP,
			},
		}),
		"GET /api/vault/ssh/cas/users/certs": json({ certificates: [RECORD] }),
		"POST /api/vault/ssh/cas/users/revoke": json({
			certificates: [{ ...RECORD, revokedAt: TIMESTAMP }],
		}),
		"GET /api/vault/ssh/cas/users/krl": () =>
			new Response(new Uint8Array([0x53, 0x53, 0x48, 0x4b, 0x52, 0x4c])),
	});
}

function body(node: ReturnType<typeof sshNode>, route: string) {
	return JSON.parse(
		node.calls.find((call) => call.route === route)?.body ?? "{}"
	);
}

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { force: true, recursive: true });
	}
});
async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ryu-ssh-test-"));
	dirs.push(dir);
	return dir;
}

describe("ryu-cli secrets ssh roles, sign and revocation", () => {
	test("role set sends every field; role delete and roles list", async () => {
		const node = sshNode();
		const set = await runSecrets(
			[
				"ssh",
				"role",
				"set",
				"dev",
				"--ca",
				"users",
				"--principal",
				"alice,bob",
				"--ttl",
				"8h",
				"--max-ttl",
				"1d",
				"--extension",
				"permit-pty",
			],
			node
		);
		expect(set.code).toBe(0);
		expect(body(node, "PUT /api/vault/ssh/roles/dev")).toEqual({
			ca: "users",
			certType: "user",
			allowedPrincipals: ["alice", "bob"],
			defaultTtlSecs: 8 * 3600,
			maxTtlSecs: 86_400,
			extensions: ["permit-pty"],
		});
		for (const argv of [
			["ssh", "role", "set", "dev", "--principal", "alice"],
			[
				"ssh",
				"role",
				"set",
				"dev",
				"--ca",
				"users",
				"--principal",
				"a",
				"--cert-type",
				"root",
			],
		]) {
			expect((await runSecrets(argv, node)).code).not.toBe(0);
		}
		expect((await runSecrets(["ssh", "roles"], node)).out).toContain("users");
		expect(
			(await runSecrets(["ssh", "role", "delete", "dev"], node)).out
		).toContain("Deleted dev.");
	});

	test("sign reads the public key from a file or stdin and never a private key", async () => {
		const dir = await scratch();
		const pub = join(dir, "id.pub");
		await writeFile(pub, `${PUBLIC}\n`);
		const node = sshNode();
		const signed = await runSecrets(
			[
				"ssh",
				"sign",
				"dev",
				"--public-key",
				pub,
				"--principal",
				"alice",
				"--key-id",
				"alice",
				"--ttl",
				"1h",
			],
			node
		);
		expect(signed.code).toBe(0);
		expect(signed.out.trim()).toBe(CERT);
		expect(body(node, "POST /api/vault/ssh/sign/dev")).toEqual({
			publicKey: SENT,
			principals: ["alice"],
			keyId: "alice",
			ttlSecs: 3600,
		});
		const piped = await runSecrets(
			["ssh", "sign", "dev", "--public-key", "-"],
			node,
			{
				readStdin: () => Promise.resolve(PUBLIC),
			}
		);
		expect(piped.code).toBe(0);

		const before = node.calls.length;
		const refused = await runSecrets(
			["ssh", "sign", "dev", "--public-key", "-"],
			node,
			{
				readStdin: () =>
					Promise.resolve(
						"-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----"
					),
			}
		);
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain("never a private key");
		expect(node.calls.length).toBe(before);
	});

	test("certs and revoke by serial or key ID", async () => {
		const node = sshNode();
		expect((await runSecrets(["ssh", "certs", "users"], node)).out).toContain(
			"18446744073709551615"
		);
		const revoked = await runSecrets(
			["ssh", "revoke", "users", "--key-id", "alice"],
			node
		);
		expect(revoked.out).toContain("Revoked 1 certificate.");
		expect(body(node, "POST /api/vault/ssh/cas/users/revoke")).toEqual({
			keyId: "alice",
		});
		for (const flags of [[], ["--serial", "7", "--key-id", "alice"]]) {
			expect(
				(await runSecrets(["ssh", "revoke", "users", ...flags], node)).code
			).not.toBe(0);
		}
	});

	test("the KRL is written only to --out, never over an existing path without --force", async () => {
		const dir = await scratch();
		const node = sshNode();
		expect((await runSecrets(["ssh", "krl", "users"], node)).code).not.toBe(0);
		const file = join(dir, "revoked.krl");
		const written = await runSecrets(
			["ssh", "krl", "users", "--out", file],
			node
		);
		expect(written.code).toBe(0);
		expect(Array.from(await readFile(file))).toEqual([
			0x53, 0x53, 0x48, 0x4b, 0x52, 0x4c,
		]);
		expect(
			(await runSecrets(["ssh", "krl", "users", "--out", file], node)).code
		).not.toBe(0);
		const link = join(dir, "link.krl");
		await symlink(join(dir, "elsewhere"), link);
		expect(
			(await runSecrets(["ssh", "krl", "users", "--out", link], node)).code
		).not.toBe(0);
		expect(
			(
				await runSecrets(
					["ssh", "krl", "users", "--out", file, "--force"],
					node
				)
			).code
		).toBe(0);
	});

	test("signInput keeps only the given fields", () => {
		const args = parseSecretsArgs(["ssh", "sign", "dev"]);
		expect(signInput(args, PUBLIC)).toEqual({ publicKey: SENT });
		expect(() => signInput(args, "-----BEGIN RSA PRIVATE KEY-----")).toThrow(
			"private key"
		);
	});

	test("only one OpenSSH public key line is ever sent", () => {
		expect(publicKeyLine(`\r\n${PUBLIC}\r\n`)).toBe(SENT);
		expect(publicKeyLine(`${SENT} trailing words here`)).toBe(SENT);
		const rsa = `ssh-rsa ${blob("ssh-rsa")}`;
		expect(publicKeyLine(rsa)).toBe(rsa);
		for (const bad of [
			"PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nPrivate-Lines: 1\nAAAA",
			"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQ",
			"-----begin openssh private key-----",
			`${PUBLIC}\n${PUBLIC}`,
			`ssh-dss ${blob("ssh-dss")}`,
			`ssh-ed25519 ${blob("ssh-rsa")}`,
			"ssh-ed25519 not-base64!",
		]) {
			expect(() => publicKeyLine(bad)).toThrow("never a private key");
		}
	});

	test("sign checks --out before Core signs and never removes a path without --force", async () => {
		const dir = await scratch();
		const pub = join(dir, "id.pub");
		await writeFile(pub, PUBLIC);
		const existing = join(dir, "cert.pub");
		await writeFile(existing, "keep");
		const node = sshNode();
		const refused = await runSecrets(
			["ssh", "sign", "dev", "--public-key", pub, "--out", existing],
			node
		);
		expect(refused.code).not.toBe(0);
		expect(await readFile(existing, "utf8")).toBe("keep");
		expect(node.calls.some((call) => call.route.includes("/sign/"))).toBe(
			false
		);
		const fresh = join(dir, "new-cert.pub");
		const written = await runSecrets(
			["ssh", "sign", "dev", "--public-key", pub, "--out", fresh],
			node
		);
		expect(written.code).toBe(0);
		expect((await readFile(fresh, "utf8")).trim()).toBe(CERT);
		// The KRL bytes never reach stdout.
		const krl = await runSecrets(
			["ssh", "krl", "users", "--out", join(dir, "k.krl"), "--json"],
			node
		);
		expect(krl.out).not.toContain("SSHK");
		expect(JSON.parse(krl.out).bytes).toBe(6);
		expect(
			(await runSecrets(["ssh", "krl", "users", "--out", dir, "--force"], node))
				.code
		).not.toBe(0);
	});

	test("a missing folder is refused before Core signs; a write that fails after hands the certificate over", async () => {
		const dir = await scratch();
		const pub = join(dir, "id.pub");
		await writeFile(pub, PUBLIC);
		const node = sshNode();
		const missing = join(dir, "no-such-dir", "cert.pub");
		const refused = await runSecrets(
			["ssh", "sign", "dev", "--public-key", pub, "--out", missing],
			node
		);
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain("does not exist");
		expect(node.calls.some((call) => call.route.includes("/sign/"))).toBe(
			false
		);

		// Free when checked, taken while Core signs.
		const taken = join(dir, "raced-cert.pub");
		const racing = fakeNode({
			"POST /api/vault/ssh/sign/dev": async () => {
				await writeFile(taken, "someone else");
				return Response.json({
					certificate: {
						certificate: CERT,
						keyId: "alice",
						principals: ["alice"],
						serial: 7,
						validAfter: TIMESTAMP,
						validBefore: TIMESTAMP,
					},
				});
			},
		});
		const failed = await runSecrets(
			["ssh", "sign", "dev", "--public-key", pub, "--out", taken],
			racing
		);
		expect(failed.code).toBe(1);
		expect(failed.out.trim()).toBe(CERT);
		expect(failed.err).toContain("serial 7");
		expect(failed.err).toContain("EEXIST");
		expect(await readFile(taken, "utf8")).toBe("someone else");
		// A KRL read has no server-side effect: a failed write just fails.
		const krl = await runSecrets(
			["ssh", "krl", "users", "--out", missing],
			node
		);
		expect(krl.code).not.toBe(0);
		const { readdir } = await import("node:fs/promises");
		expect(
			(await readdir(dir)).filter((name) => name.endsWith(".tmp"))
		).toEqual([]);
	});
});
