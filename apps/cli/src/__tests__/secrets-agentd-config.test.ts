// `ryu secrets agent` config parsing: defaults, path resolution, and errors
// that name the file and field but never a value.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
	PRIVATE_MODE,
	parseAgentConfig,
} from "../cli/secrets-agentd-config.ts";
import { UsageError } from "../cli/types.ts";

const FILE = resolve("/etc/ryu/agent.json");
const DIR = resolve("/etc/ryu");

function parse(config: unknown) {
	return parseAgentConfig(JSON.stringify(config), FILE);
}

function errorOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (!(error instanceof UsageError)) {
			throw error;
		}
		return error.message;
	}
	throw new Error("expected a UsageError");
}

describe("parseAgentConfig", () => {
	test("a full config resolves paths against the config file and applies defaults", () => {
		const config = parse({
			version: 1,
			environment: "prod",
			path: "/payments",
			auth: {
				method: "approle",
				roleId: "role-1",
				secretIdFile: "secret-id",
			},
			sinks: [{ path: "token" }, { path: "/run/t", mode: "0640" }],
			leases: [{ name: "db", role: "postgres-ro", ttl: "1h" }],
			templates: [
				{
					source: "app.env.tpl",
					destination: "out/app.env",
					command: ["systemctl", "reload", "app"],
					commandTimeout: "2m",
				},
			],
			renderInterval: "10m",
		});
		expect(config.auth).toEqual({
			kind: "approle",
			roleId: "role-1",
			roleIdFile: null,
			secretIdFile: join(DIR, "secret-id"),
		});
		expect(config.defaults).toEqual({ environment: "prod", path: "/payments" });
		expect(config.sinks).toEqual([
			{ path: join(DIR, "token"), mode: PRIVATE_MODE },
			{ path: resolve("/run/t"), mode: 0o640 },
		]);
		expect(config.leases).toEqual([
			{ name: "db", role: "postgres-ro", ttlSecs: 3600 },
		]);
		expect(config.templates).toEqual([
			{
				source: join(DIR, "app.env.tpl"),
				destination: join(DIR, "out", "app.env"),
				mode: PRIVATE_MODE,
				command: ["systemctl", "reload", "app"],
				commandTimeoutMs: 120_000,
			},
		]);
		expect(config.renderIntervalMs).toBe(600_000);
		expect(config.revokeLeasesOnExit).toBe(true);
	});

	test("the other auth methods", () => {
		expect(
			parse({
				version: 1,
				auth: { method: "jwt", identity: "ci", jwtFile: "/var/run/jwt" },
			}).auth
		).toEqual({
			kind: "jwt",
			identity: "ci",
			jwtFile: resolve("/var/run/jwt"),
		});
		expect(
			parse({ version: 1, auth: { method: "token", tokenFile: "t" } }).auth
		).toEqual({ kind: "token", tokenFile: join(DIR, "t") });
		expect(parse({ version: 1, auth: { method: "env" } }).auth).toEqual({
			kind: "env",
		});
	});

	test("invalid JSON names the file", () => {
		expect(errorOf(() => parseAgentConfig("{", FILE))).toBe(
			`${FILE} is not valid JSON.`
		);
	});

	test("schema errors name the field, never the value", () => {
		const secretLooking = "rvt_should_never_be_echoed";
		const message = errorOf(() =>
			parse({
				version: 1,
				auth: { method: "token", tokenFile: "t", token: secretLooking },
			})
		);
		expect(message).toContain(`${FILE} is not a valid agent config`);
		expect(message).not.toContain(secretLooking);
		expect(errorOf(() => parse({ version: 2, auth: { method: "env" } }))).toBe(
			`${FILE} is not a valid agent config: version is invalid.`
		);
		expect(
			errorOf(() =>
				parse({
					version: 1,
					auth: { method: "env" },
					sinks: [{ path: "t", mode: "rw" }],
				})
			)
		).toBe(`${FILE} is not a valid agent config: sinks.0.mode is invalid.`);
		expect(
			errorOf(() =>
				parse({
					version: 1,
					auth: { method: "env" },
					leases: [{ name: "db", role: "r", ttl: "soon" }],
				})
			)
		).toBe(`${FILE} is not a valid agent config: leases.0.ttl is invalid.`);
	});

	test("approle needs exactly one of roleId and roleIdFile", () => {
		const both = {
			method: "approle",
			roleId: "r",
			roleIdFile: "f",
			secretIdFile: "s",
		};
		const neither = { method: "approle", secretIdFile: "s" };
		for (const auth of [both, neither]) {
			expect(errorOf(() => parse({ version: 1, auth }))).toBe(
				`${FILE} is not a valid agent config: auth.roleId is invalid.`
			);
		}
	});

	test("duplicate lease names and template destinations are refused", () => {
		expect(
			errorOf(() =>
				parse({
					version: 1,
					auth: { method: "env" },
					leases: [
						{ name: "db", role: "a" },
						{ name: "db", role: "b" },
					],
				})
			)
		).toContain("leases.name is invalid");
		expect(
			errorOf(() =>
				parse({
					version: 1,
					auth: { method: "env" },
					templates: [
						{ source: "a", destination: "out" },
						{ source: "b", destination: "./out" },
					],
				})
			)
		).toContain("templates.destination is invalid");
	});
});
