import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { ENGINE_HELP_LINES } from "../cli/secrets-help-engines.ts";
import { issueInput } from "../cli/secrets-pki.ts";
import { fakeNode, json, runSecrets, TIMESTAMP } from "./secrets-fixture.ts";

const CERT = "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----";
const CA = "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----";
const KEY = "-----BEGIN PRIVATE KEY-----\nSECRETKEY\n-----END PRIVATE KEY-----";

const ROLE = {
	name: "web",
	issuer: "root",
	allowedDomains: ["example.com"],
	allowIpSans: false,
	defaultTtlSecs: 86_400,
	maxTtlSecs: 86_400,
	serverFlag: true,
	clientFlag: false,
};

const RECORD = {
	serial: "0a:1b",
	issuer: "root",
	commonName: "api.example.com",
	notAfter: TIMESTAMP,
	revokedAt: null,
};

function pkiNode() {
	return fakeNode({
		"GET /api/vault/pki/issuers": json({
			issuers: [
				{
					name: "root",
					commonName: "Ryu Root",
					certificate: CA,
					notAfter: TIMESTAMP,
				},
			],
		}),
		"POST /api/vault/pki/issuers": (call) =>
			Response.json({
				issuer: {
					...JSON.parse(call.body),
					certificate: CA,
					notAfter: TIMESTAMP,
				},
			}),
		"GET /api/vault/pki/issuers/root/certs": json({ certificates: [RECORD] }),
		"GET /api/vault/pki/issuers/root/crl": () =>
			new Response("-----BEGIN X509 CRL-----\nCRL\n-----END X509 CRL-----\n"),
		"GET /api/vault/pki/roles": json({ roles: [ROLE] }),
		"PUT /api/vault/pki/roles/web": (call) =>
			Response.json({ role: { name: "web", ...JSON.parse(call.body) } }),
		"DELETE /api/vault/pki/roles/web": json({ deleted: true }),
		"POST /api/vault/pki/issue/web": json({
			certificate: {
				certificate: CERT,
				issuingCa: CA,
				notAfter: TIMESTAMP,
				privateKey: KEY,
				serial: "0a:1b",
			},
		}),
		"POST /api/vault/pki/sign/web": json({
			certificate: {
				certificate: CERT,
				issuingCa: CA,
				notAfter: TIMESTAMP,
				serial: "0c",
			},
		}),
		"POST /api/vault/pki/revoke": json({
			certificate: { ...RECORD, revokedAt: TIMESTAMP },
		}),
	});
}

function body(node: ReturnType<typeof pkiNode>, route: string) {
	const call = node.calls.find((entry) => entry.route === route);
	return JSON.parse(call?.body ?? "{}");
}

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { force: true, recursive: true });
	}
});

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ryu-pki-test-"));
	dirs.push(dir);
	return dir;
}

describe("ryu-cli secrets pki", () => {
	test("issuers, certs, crl and revoke", async () => {
		const node = pkiNode();
		const issuers = await runSecrets(["pki", "issuers"], node);
		expect(issuers.out).toContain("Ryu Root");
		const created = await runSecrets(
			[
				"pki",
				"issuer",
				"create",
				"root",
				"--common-name",
				"Ryu Root",
				"--ttl",
				"3650d",
			],
			node
		);
		expect(created.code).toBe(0);
		expect(body(node, "POST /api/vault/pki/issuers")).toEqual({
			name: "root",
			commonName: "Ryu Root",
			ttlSecs: 3650 * 86_400,
		});
		const certs = await runSecrets(["pki", "certs", "root"], node);
		expect(certs.out).toContain("api.example.com");
		const crl = await runSecrets(["pki", "crl", "root"], node);
		expect(crl.out).toContain("BEGIN X509 CRL");
		const revoked = await runSecrets(["pki", "revoke", "0a:1b"], node);
		expect(revoked.out).toContain("Revoked 0a:1b");
		expect(body(node, "POST /api/vault/pki/revoke")).toEqual({
			serial: "0a:1b",
		});
	});

	test("role set sends every field and checks its flags", async () => {
		const node = pkiNode();
		const set = await runSecrets(
			[
				"pki",
				"role",
				"set",
				"web",
				"--issuer",
				"root",
				"--domain",
				"example.com,example.org",
				"--ttl",
				"12h",
				"--max-ttl",
				"30d",
				"--server",
			],
			node
		);
		expect(set.code).toBe(0);
		expect(body(node, "PUT /api/vault/pki/roles/web")).toEqual({
			issuer: "root",
			allowedDomains: ["example.com", "example.org"],
			defaultTtlSecs: 12 * 3600,
			maxTtlSecs: 30 * 86_400,
			allowIpSans: false,
			serverFlag: true,
			clientFlag: false,
		});
		for (const argv of [
			["pki", "role", "set", "web", "--domain", "example.com"],
			["pki", "role", "set", "web", "--issuer", "root"],
			[
				"pki",
				"role",
				"set",
				"web",
				"--issuer",
				"root",
				"--domain",
				"a.com",
				"--ttl",
				"2d",
				"--max-ttl",
				"1d",
			],
		]) {
			const refused = await runSecrets(argv, node);
			expect(refused.code).not.toBe(0);
		}
		const deleted = await runSecrets(["pki", "role", "delete", "web"], node);
		expect(deleted.out).toContain("Deleted web.");
	});

	test("issue writes the new key owner-only to --key-out and never prints it", async () => {
		const dir = await scratch();
		const keyFile = join(dir, "api.key");
		const node = pkiNode();
		const issued = await runSecrets(
			[
				"pki",
				"issue",
				"web",
				"--common-name",
				"api.example.com",
				"--alt-name",
				"www.example.com",
				"--ip-san",
				"10.0.0.1",
				"--key-out",
				keyFile,
			],
			node
		);
		expect(issued.code).toBe(0);
		expect(issued.out).toContain("LEAF");
		expect(issued.out).not.toContain("SECRETKEY");
		expect(issued.err).not.toContain("SECRETKEY");
		expect(await readFile(keyFile, "utf8")).toContain("SECRETKEY");
		expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
		expect(body(node, "POST /api/vault/pki/issue/web")).toEqual({
			commonName: "api.example.com",
			altNames: ["www.example.com"],
			ipSans: ["10.0.0.1"],
		});

		// An existing file is never replaced without --force.
		await writeFile(keyFile, "keep");
		const refused = await runSecrets(
			[
				"pki",
				"issue",
				"web",
				"--common-name",
				"api.example.com",
				"--key-out",
				keyFile,
			],
			node
		);
		expect(refused.code).not.toBe(0);
		expect(await readFile(keyFile, "utf8")).toBe("keep");
		const json = await runSecrets(
			[
				"pki",
				"issue",
				"web",
				"--common-name",
				"a.example.com",
				"--key-out",
				keyFile,
				"--force",
				"--json",
			],
			node
		);
		expect(json.code).toBe(0);
		expect(json.out).not.toContain("SECRETKEY");
		expect(JSON.parse(json.out).keyFile).toBe(keyFile);
	});

	test("issue is refused in an AI agent session before reaching Core", async () => {
		const node = pkiNode();
		const agent = { env: { HOME: "/home/me", CLAUDECODE: "1" } };
		for (const argv of [
			["pki", "issue", "web", "--common-name", "api.example.com"],
			["pki", "--json", "issue", "web", "--common-name", "api.example.com"],
		]) {
			const refused = await runSecrets(argv, node, agent);
			expect(refused.code).not.toBe(0);
			expect(refused.out).not.toContain("SECRETKEY");
		}
		expect(node.calls.some((call) => call.route.includes("/issue/"))).toBe(
			false
		);
		const listed = await runSecrets(["pki", "roles"], node, agent);
		expect(listed.code).toBe(0);
	});

	test("sign reads the CSR from a file or stdin and prints no key", async () => {
		const dir = await scratch();
		const csr = join(dir, "req.csr");
		await writeFile(
			csr,
			"-----BEGIN CERTIFICATE REQUEST-----\nCSR\n-----END CERTIFICATE REQUEST-----\n"
		);
		const node = pkiNode();
		const signed = await runSecrets(
			["pki", "sign", "web", "--csr", csr, "--ttl", "1d"],
			node
		);
		expect(signed.code).toBe(0);
		expect(signed.out).toContain("LEAF");
		expect(body(node, "POST /api/vault/pki/sign/web")).toEqual({
			commonName: "",
			ttlSecs: 86_400,
			csr: "-----BEGIN CERTIFICATE REQUEST-----\nCSR\n-----END CERTIFICATE REQUEST-----\n",
		});
		const piped = await runSecrets(["pki", "sign", "web", "--csr", "-"], node, {
			readStdin: () => Promise.resolve("PIPED CSR"),
		});
		expect(piped.code).toBe(0);
		const missing = await runSecrets(["pki", "sign", "web"], node);
		expect(missing.code).not.toBe(0);
		expect(missing.err).toContain("--csr");
	});

	test("issue needs a common name; help lists the commands", () => {
		const args = parseSecretsArgs(["pki", "issue", "web"]);
		expect(() => issueInput(args, true)).toThrow("--common-name");
		expect(issueInput(args, false)).toEqual({ commonName: "" });
		expect(ENGINE_HELP_LINES.join("\n")).toContain("pki issue ROLE");
	});

	test("--key-out is checked before Core issues and never follows a symlink", async () => {
		const dir = await scratch();
		const node = pkiNode();
		const issueTo = (file: string, ...extra: string[]) =>
			runSecrets(
				[
					"pki",
					"issue",
					"web",
					"--common-name",
					"api.example.com",
					"--key-out",
					file,
					...extra,
				],
				node
			);

		// An existing file without --force: refused, and nothing issued.
		const kept = join(dir, "kept.key");
		await writeFile(kept, "keep");
		expect((await issueTo(kept)).code).not.toBe(0);
		expect(await readFile(kept, "utf8")).toBe("keep");

		// A dangling symlink counts as existing; its target is never created.
		const link = join(dir, "link.key");
		const elsewhere = join(dir, "elsewhere");
		await symlink(elsewhere, link);
		expect((await issueTo(link)).code).not.toBe(0);
		expect(node.calls.some((call) => call.route.includes("/issue/"))).toBe(
			false
		);

		// With --force the link itself is replaced by an owner-only file.
		expect((await issueTo(link, "--force")).code).toBe(0);
		await expect(stat(elsewhere)).rejects.toThrow();
		expect(await readFile(link, "utf8")).toContain("SECRETKEY");
		expect((await stat(link)).mode & 0o777).toBe(0o600);

		// A world-readable file replaced with --force ends up 0600.
		const open = join(dir, "open.key");
		await writeFile(open, "old");
		await chmod(open, 0o644);
		expect((await issueTo(open, "--force")).code).toBe(0);
		expect((await stat(open)).mode & 0o777).toBe(0o600);

		// A directory is refused even with --force.
		expect((await issueTo(dir, "--force")).code).not.toBe(0);
	});

	test("without --key-out the key is printed; sign never prints one", async () => {
		const node = pkiNode();
		const printed = await runSecrets(
			["pki", "issue", "web", "--common-name", "api.example.com"],
			node
		);
		expect(printed.out).toContain("SECRETKEY");
		const leaky = fakeNode({
			"POST /api/vault/pki/sign/web": json({
				certificate: {
					certificate: CERT,
					issuingCa: CA,
					notAfter: TIMESTAMP,
					privateKey: KEY,
					serial: "0d",
				},
			}),
		});
		for (const extra of [[], ["--json"]]) {
			const signed = await runSecrets(
				["pki", "sign", "web", "--csr", "-", ...extra],
				leaky,
				{ readStdin: () => Promise.resolve("CSR") }
			);
			expect(signed.code).toBe(0);
			expect(signed.out).not.toContain("SECRETKEY");
		}
	});

	test("the agent guard holds for --key-out and for --human without a terminal", async () => {
		const node = pkiNode();
		const agent = {
			env: { HOME: "/home/me", CLAUDECODE: "1" },
			promptLine: () => Promise.resolve(null),
		};
		for (const argv of [
			[
				"pki",
				"issue",
				"web",
				"--common-name",
				"a.example.com",
				"--key-out",
				"/tmp/never.key",
			],
			["pki", "issue", "web", "--common-name", "a.example.com", "--human"],
			["pki", "issue", "web", "--common-name", "a.example.com", "--json"],
		]) {
			expect((await runSecrets(argv, node, agent)).code).not.toBe(0);
		}
		expect(node.calls.some((call) => call.route.includes("/issue/"))).toBe(
			false
		);
	});

	test("a missing folder is refused before Core issues anything", async () => {
		const dir = await scratch();
		const node = pkiNode();
		const missing = join(dir, "no-such-dir", "api.key");
		const refused = await runSecrets(
			[
				"pki",
				"issue",
				"web",
				"--common-name",
				"a.example.com",
				"--key-out",
				missing,
			],
			node
		);
		expect(refused.code).not.toBe(0);
		expect(refused.err).toContain("does not exist");
		expect(node.calls.some((call) => call.route.includes("/issue/"))).toBe(
			false
		);
	});

	test("a key that cannot be written after Core issued names the serial to revoke", async () => {
		const dir = await scratch();
		const taken = join(dir, "raced.key");
		// The path is free when checked and taken while Core issues: the
		// exclusive create then fails after the certificate exists.
		const node = fakeNode({
			"POST /api/vault/pki/issue/web": async () => {
				await writeFile(taken, "someone else");
				return Response.json({
					certificate: {
						certificate: CERT,
						issuingCa: CA,
						notAfter: TIMESTAMP,
						privateKey: KEY,
						serial: "0a:1b",
					},
				});
			},
		});
		const failed = await runSecrets(
			[
				"pki",
				"issue",
				"web",
				"--common-name",
				"api.example.com",
				"--key-out",
				taken,
			],
			node
		);
		expect(failed.code).toBe(1);
		expect(failed.err).toContain("serial 0a:1b");
		expect(failed.err).toContain("ryu-cli secrets pki revoke 0a:1b");
		expect(failed.err).toContain("EEXIST");
		expect(failed.out).not.toContain("SECRETKEY");
		expect(failed.err).not.toContain("SECRETKEY");
		expect(await readFile(taken, "utf8")).toBe("someone else");
		// --force replaces through a staging file and leaves no stray file.
		const kept = join(dir, "kept.key");
		await writeFile(kept, "old");
		const forced = await runSecrets(
			[
				"pki",
				"issue",
				"web",
				"--common-name",
				"api.example.com",
				"--key-out",
				kept,
				"--force",
			],
			node
		);
		expect(forced.code).toBe(0);
		expect(await readFile(kept, "utf8")).toContain("SECRETKEY");
		const { readdir } = await import("node:fs/promises");
		expect(
			(await readdir(dir)).filter((name) => name.endsWith(".tmp"))
		).toEqual([]);
	});
});
