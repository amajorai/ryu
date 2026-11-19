import { describe, expect, test } from "bun:test";
import { parseSecretsArgs } from "../cli/secrets-args.ts";
import { lockoutConfigFrom } from "../cli/secrets-lockouts.ts";
import { fakeNode, json, runSecrets } from "./secrets-fixture.ts";

const CONFIG = {
	enabled: true,
	threshold: 5,
	windowSecs: 900,
	durationSecs: 900,
};

const LOCKED = {
	identity: "ci",
	failures: 5,
	lockedAt: "2026-11-12T00:00:00Z",
	lockedUntil: "2026-11-12T00:15:00Z",
};

function lockoutNode(locked = [LOCKED]) {
	return fakeNode({
		"GET /api/vault/sys/lockouts": json({ config: CONFIG, locked }),
		"PUT /api/vault/sys/lockouts/config": (call) =>
			Response.json({ config: JSON.parse(call.body) }),
		"POST /api/vault/sys/lockouts/ci%2Frunner/unlock": json({
			wasLocked: true,
		}),
		"POST /api/vault/sys/lockouts/web/unlock": json({ wasLocked: false }),
	});
}

describe("ryu secrets lockout", () => {
	test("list shows the settings and each locked identity", async () => {
		const node = lockoutNode();
		const { code, out } = await runSecrets(["lockout", "list"], node);
		expect(code).toBe(0);
		expect(out).toContain(
			"Lockout on: 5 failed logins within 900s lock an identity for 900s."
		);
		expect(out).toContain("ci");
		expect(out).toContain("2026-11-12T00:15:00Z");
		const empty = await runSecrets(["lockouts"], lockoutNode([]));
		expect(empty.out).toContain("No identity is locked.");
	});

	test("config merges the flags into the current settings and sends every field", async () => {
		const node = lockoutNode();
		const { code, out } = await runSecrets(
			["lockout", "config", "--threshold", "3", "--duration", "1h"],
			node
		);
		expect(code).toBe(0);
		const put = node.calls.find((call) => call.route.startsWith("PUT"));
		expect(JSON.parse(put?.body ?? "{}")).toEqual({
			enabled: true,
			threshold: 3,
			windowSecs: 900,
			durationSecs: 3600,
		});
		expect(out).toContain("3 failed logins within 900s");

		const off = lockoutNode();
		await runSecrets(["lockout", "config", "--disable"], off);
		expect(
			JSON.parse(
				off.calls.find((call) => call.route.startsWith("PUT"))?.body ?? "{}"
			)
		).toEqual({ ...CONFIG, enabled: false });
	});

	test("config without flags only reads, and bad flags send nothing", async () => {
		const node = lockoutNode();
		expect((await runSecrets(["lockout", "config"], node)).code).toBe(0);
		expect(node.calls.map((call) => call.route)).toEqual([
			"GET /api/vault/sys/lockouts",
		]);
		const both = await runSecrets(
			["lockout", "config", "--enable", "--disable"],
			node
		);
		expect(both.code).not.toBe(0);
		expect(both.err).toContain("--enable or --disable");
		const zero = await runSecrets(
			["lockout", "config", "--threshold", "0"],
			node
		);
		expect(zero.code).not.toBe(0);
		expect(node.calls.some((call) => call.route.startsWith("PUT"))).toBe(false);
	});

	test("unlock encodes the identity and reports whether it was locked", async () => {
		const node = lockoutNode();
		const unlocked = await runSecrets(["lockout", "unlock", "ci/runner"], node);
		expect(unlocked.out).toContain("Unlocked ci/runner.");
		const already = await runSecrets(["lockout", "unlock", "web"], node);
		expect(already.out).toContain("web was not locked.");
	});

	test("lockoutConfigFrom keeps every unset field", () => {
		const config = (argv: string[]) =>
			lockoutConfigFrom(parseSecretsArgs(argv), CONFIG);
		expect(config(["lockout", "config"])).toBeNull();
		expect(config(["lockout", "config", "--window", "30m"])).toEqual({
			...CONFIG,
			windowSecs: 1800,
		});
	});
});
