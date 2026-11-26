import { describe, expect, test } from "bun:test";
import { printsSecretValues } from "../cli/secrets-agent-guard.ts";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { renderHelpEntries } from "../cli/secrets-help-format.ts";
import { machineHelpEntries } from "../cli/secrets-help-machines.ts";
import { otpRequest, otpRoleInput } from "../cli/secrets-ssh-otp.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

const OTP = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const EXPIRES = "2026-11-17T10:10:00+00:00";
const ROLE = {
	name: "web",
	defaultUser: "deploy",
	allowedUsers: ["ops-*"],
	cidrList: ["10.0.0.0/24"],
	excludeCidrList: [],
	port: 22,
	ttlSecs: 600,
};

function otpNode() {
	return fakeNode({
		"GET /api/vault/ssh/otp-roles": json({ roles: [ROLE] }),
		"PUT /api/vault/ssh/otp-roles/web": (call) =>
			Response.json({
				role: {
					name: "web",
					allowedUsers: [],
					excludeCidrList: [],
					port: 22,
					ttlSecs: 600,
					...JSON.parse(call.body),
				},
			}),
		"DELETE /api/vault/ssh/otp-roles/web": json({ deleted: true }),
		"DELETE /api/vault/ssh/otp-roles/gone": json({ deleted: false }),
		"POST /api/vault/ssh/creds/web": (call) =>
			Response.json({
				credential: {
					key: OTP,
					keyType: "otp",
					username: JSON.parse(call.body).username ?? "deploy",
					ip: JSON.parse(call.body).ip,
					port: 22,
					expiresAt: EXPIRES,
				},
			}),
	});
}

function body(node: ReturnType<typeof otpNode>, route: string) {
	return JSON.parse(
		node.calls.find((call) => call.route === route)?.body ?? "{}"
	);
}

const AGENT = {
	env: { HOME: "/home/me", CLAUDECODE: "1" },
	promptLine: () => Promise.resolve(null),
};

describe("ryu-cli secrets ssh otp roles", () => {
	test("otp-roles lists every field; --json prints the roles", async () => {
		const node = otpNode();
		const listed = await runSecrets(["ssh", "otp-roles"], node);
		expect(listed.code).toBe(0);
		for (const text of ["web", "deploy", "ops-*", "10.0.0.0/24", "600s"]) {
			expect(listed.out).toContain(text);
		}
		const asJson = await runSecrets(
			["ssh", "otp-role", "list", "--json"],
			node
		);
		expect(JSON.parse(asJson.out)).toEqual([ROLE]);
	});

	test("show reads one role from the listing and fails for an unknown one", async () => {
		const node = otpNode();
		const shown = await runSecrets(
			["ssh", "otp-role", "show", "web", "--json"],
			node
		);
		expect(shown.code).toBe(0);
		expect(JSON.parse(shown.out)).toEqual(ROLE);
		const unknown = await runSecrets(["ssh", "otp-role", "show", "nope"], node);
		expect(unknown.code).toBe(1);
		expect(unknown.out).toBe("");
		expect(unknown.err).toContain("No SSH OTP role named nope.");
	});

	test("set sends the role's fields under its name", async () => {
		const node = otpNode();
		const set = await runSecrets(
			[
				"ssh",
				"otp-role",
				"set",
				"web",
				"--default-user",
				"deploy",
				"--cidr",
				"10.0.0.0/24,10.0.1.0/24",
				"--cidr",
				"192.168.1.10/32",
				"--allowed-user",
				"ops-*",
				"--exclude-cidr",
				"10.0.0.9/32",
				"--port",
				"2222",
				"--ttl",
				"5m",
				"--json",
			],
			node
		);
		expect(set.code).toBe(0);
		const sent = {
			defaultUser: "deploy",
			cidrList: ["10.0.0.0/24", "10.0.1.0/24", "192.168.1.10/32"],
			allowedUsers: ["ops-*"],
			excludeCidrList: ["10.0.0.9/32"],
			port: 2222,
			ttlSecs: 300,
		};
		expect(body(node, "PUT /api/vault/ssh/otp-roles/web")).toEqual(sent);
		expect(JSON.parse(set.out)).toEqual({ name: "web", ...sent });
	});

	test("set leaves omitted fields to Core's defaults", () => {
		expect(
			otpRoleInput(
				parseSecretsArgs([
					"ssh",
					"otp-role",
					"set",
					"web",
					"--default-user",
					"deploy",
					"--cidr",
					"10.0.0.0/8",
				])
			)
		).toEqual({ defaultUser: "deploy", cidrList: ["10.0.0.0/8"] });
	});

	test("set refuses missing or out-of-range fields before reaching Core", async () => {
		const node = otpNode();
		const base = ["ssh", "otp-role", "set", "web"];
		const user = ["--default-user", "deploy"];
		const cidr = ["--cidr", "10.0.0.0/24"];
		for (const [flags, message] of [
			[cidr, "--default-user and at least one --cidr"],
			[user, "--default-user and at least one --cidr"],
			[[...user, ...cidr, "--port", "0"], "--port must be 1-65535"],
			[[...user, ...cidr, "--port", "65536"], "--port must be 1-65535"],
			[[...user, ...cidr, "--port", "ssh"], "--port must be an integer"],
			[[...user, ...cidr, "--ttl", "59"], "--ttl must be between 1m and 1h"],
			[[...user, ...cidr, "--ttl", "61m"], "--ttl must be between 1m and 1h"],
		] as const) {
			const refused = await runSecrets([...base, ...flags], node);
			expect(refused.code).not.toBe(0);
			expect(refused.err).toContain(message);
		}
		for (const ttl of ["60", "1h"]) {
			const ok = otpRoleInput(
				parseSecretsArgs([...base, ...user, ...cidr, "--ttl", ttl])
			);
			expect(ok.ttlSecs).toBe(ttl === "60" ? 60 : 3600);
		}
		expect(node.calls).toEqual([]);
	});

	test("delete reports a removed role and fails for a missing one", async () => {
		const node = otpNode();
		const deleted = await runSecrets(
			["ssh", "otp-role", "delete", "web"],
			node
		);
		expect(deleted.code).toBe(0);
		expect(deleted.out).toContain("Deleted web.");
		const asJson = await runSecrets(
			["ssh", "otp-role", "delete", "web", "--json"],
			node
		);
		expect(JSON.parse(asJson.out)).toEqual({ deleted: true });
		const gone = await runSecrets(["ssh", "otp-role", "delete", "gone"], node);
		expect(gone.code).toBe(1);
		expect(gone.err).toContain("No SSH OTP role named gone.");
	});

	test("an unknown otp-role verb or a missing name is a usage error", async () => {
		const node = otpNode();
		for (const argv of [
			["ssh", "otp-role", "rename", "web"],
			["ssh", "otp-role", "delete"],
			["ssh", "otp-role", "show"],
		]) {
			expect((await runSecrets(argv, node)).code).not.toBe(0);
		}
		// An unknown verb is never read as `set`, even with a full set of flags.
		const flags = ["--default-user", "deploy", "--cidr", "10.0.0.0/24"];
		const unknown = await runSecrets(
			["ssh", "otp-role", "replace", "web", ...flags],
			node
		);
		expect(unknown.code).not.toBe(0);
		expect(unknown.err).toContain("ssh otp-role set NAME");
		expect(node.calls).toEqual([]);
	});
});

describe("ryu-cli secrets ssh otp", () => {
	test("prints only the password on stdout and the details on stderr", async () => {
		const node = otpNode();
		const issued = await runSecrets(
			["ssh", "otp", "web", "--ip", "10.0.0.5"],
			node
		);
		expect(issued.code).toBe(0);
		expect(issued.out).toBe(`${OTP}\n`);
		expect(issued.err).toContain("deploy@10.0.0.5 port 22");
		expect(issued.err).toContain(EXPIRES);
		expect(body(node, "POST /api/vault/ssh/creds/web")).toEqual({
			ip: "10.0.0.5",
		});
	});

	test("--json prints the whole credential; --username is sent", async () => {
		const node = otpNode();
		const issued = await runSecrets(
			["ssh", "otp", "web", "--ip", "::1", "--username", "ops-1", "--json"],
			node
		);
		expect(issued.code).toBe(0);
		expect(JSON.parse(issued.out)).toEqual({
			key: OTP,
			keyType: "otp",
			username: "ops-1",
			ip: "::1",
			port: 22,
			expiresAt: EXPIRES,
		});
		expect(body(node, "POST /api/vault/ssh/creds/web")).toEqual({
			ip: "::1",
			username: "ops-1",
		});
	});

	test("a missing role, a missing --ip or a bad address sends nothing", async () => {
		const node = otpNode();
		for (const [argv, message] of [
			[["ssh", "otp"], "ssh otp ROLE"],
			[["ssh", "otp", "web"], "needs --ip"],
			[["ssh", "otp", "web", "--ip", "  "], "needs --ip"],
			[["ssh", "otp", "web", "--ip", "host.example.com"], "IP address"],
			[["ssh", "otp", "web", "--ip", "10.0.0.0/24"], "IP address"],
		] as const) {
			const refused = await runSecrets([...argv], node);
			expect(refused.code).not.toBe(0);
			expect(refused.err).toContain(message);
		}
		expect(node.calls).toEqual([]);
		expect(
			otpRequest(parseSecretsArgs(["ssh", "otp", "web", "--ip", " 10.0.0.5 "]))
		).toEqual({ ip: "10.0.0.5" });
	});

	test("is refused in an AI agent session before reaching Core", async () => {
		const node = otpNode();
		for (const argv of [
			["ssh", "otp", "web", "--ip", "10.0.0.5"],
			["ssh", "--json", "otp", "web", "--ip", "10.0.0.5"],
			["ssh", "otp", "web", "--ip", "10.0.0.5", "--human"],
		]) {
			const refused = await runSecrets(argv, node, AGENT);
			expect(refused.code).not.toBe(0);
			expect(refused.out).not.toContain(OTP);
			expect(refused.err).toContain("Refusing to print secret values");
		}
		expect(node.calls).toEqual([]);
		// Role management prints no secret and stays available.
		const listed = await runSecrets(["ssh", "otp-roles"], node, AGENT);
		expect(listed.code).toBe(0);
		expect(listed.out).toContain("web");
	});

	test("the guard covers otp only among the ssh actions", () => {
		const prints = (...argv: string[]) =>
			printsSecretValues(parseSecretsArgs(["ssh", ...argv]));
		expect(prints("otp", "web")).toBe(true);
		for (const action of ["otp-roles", "otp-role", "roles", "sign", "krl"]) {
			expect(prints(action)).toBe(false);
		}
	});

	test("verify is not a command and not in the help", async () => {
		const node = otpNode();
		const verify = await runSecrets(
			["ssh", "verify", "--otp", OTP],
			node
		).catch(() => null);
		expect(verify?.code ?? 2).not.toBe(0);
		const bare = await runSecrets(["ssh", "verify"], node);
		expect(bare.code).not.toBe(0);
		expect(bare.err).toContain("ssh otp ROLE --ip IP");
		expect(node.calls).toEqual([]);
		const help = renderHelpEntries(machineHelpEntries()).join("\n");
		expect(help).toContain("ssh otp ROLE --ip IP [--username U]");
		expect(help).toContain("ssh otp-role set NAME --default-user U --cidr C");
		expect(help).not.toMatch(/ssh verify|otp verify/);
	});
});
