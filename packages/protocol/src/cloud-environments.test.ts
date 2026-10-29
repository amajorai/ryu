import { describe, expect, test } from "bun:test";
import { deepStrictEqual } from "node:assert/strict";
import {
	type CloudEnvironment,
	type CloudVaultEntry,
	cloudEnvironmentRuntimeIssue,
	DEFAULT_CLOUD_ENVIRONMENT_RUNTIME,
	parseCloudEnvironmentLaunchResult,
	parseCloudEnvironmentState,
} from "./cloud-environments.ts";
import cloudEnvironmentFixture from "./fixtures/cloud-environments.json" with {
	type: "json",
};

describe("cloud environment wire boundary", () => {
	test("parses the Core camelCase redacted fixture without changing settings", () => {
		deepStrictEqual(parseCloudEnvironmentState(cloudEnvironmentFixture), {
			...cloudEnvironmentFixture,
			environments: cloudEnvironmentFixture.environments.map((environment) => ({
				...environment,
				runtime: DEFAULT_CLOUD_ENVIRONMENT_RUNTIME,
			})),
		});
	});
	test("rejects leaked secret values and unsupported schema versions", () => {
		expect(() =>
			parseCloudEnvironmentState({
				...cloudEnvironmentFixture,
				vault: [
					{ ...cloudEnvironmentFixture.vault[0], value: "must-never-appear" },
				],
			})
		).toThrow("exposed a value");
		expect(() =>
			parseCloudEnvironmentState({
				...cloudEnvironmentFixture,
				schemaVersion: 2,
			})
		).toThrow();
	});
	test("rejects malformed network controls and unsafe revisions", () => {
		expect(() =>
			parseCloudEnvironmentState({
				...cloudEnvironmentFixture,
				revision: Number.MAX_SAFE_INTEGER + 1,
			})
		).toThrow();
		expect(() =>
			parseCloudEnvironmentState({
				...cloudEnvironmentFixture,
				environments: [
					{
						...cloudEnvironmentFixture.environments[0],
						internet: {
							enabled: "false",
							domainPolicy: "all",
							allowedDomains: [],
						},
					},
				],
			})
		).toThrow();
	});
	test("bounds lists and rejects missing vault metadata", () => {
		expect(() =>
			parseCloudEnvironmentState({
				...cloudEnvironmentFixture,
				vault: Array.from(
					{ length: 101 },
					() => cloudEnvironmentFixture.vault[0]
				),
			})
		).toThrow();
		expect(() =>
			parseCloudEnvironmentState({ ...cloudEnvironmentFixture, vault: [{}] })
		).toThrow();
	});
	test("parses successful and failed setup exit codes without inventing success", () => {
		const result = {
			environmentId: "environment-1",
			status: "failed",
			exitCode: 1,
			stdout: "",
			stderr: "Install failed",
			startInstructions: "",
		};
		expect(parseCloudEnvironmentLaunchResult(result).exitCode).toBe(1);
		expect(parseCloudEnvironmentLaunchResult(result).status).toBe("failed");
		expect(() =>
			parseCloudEnvironmentLaunchResult({ ...result, status: "completed" })
		).toThrow();
		expect(
			parseCloudEnvironmentLaunchResult({
				...result,
				status: "completed",
				exitCode: 0,
			}).status
		).toBe("completed");
		expect(() =>
			parseCloudEnvironmentLaunchResult({ ...result, status: "running" })
		).toThrow();
	});
});

describe("legacy cloud projection details", () => {
	test("preserves native sparse arrays without inventing rows", () => {
		const environments: CloudEnvironment[] = [];
		const vault: CloudVaultEntry[] = [];
		environments.length = 2;
		vault.length = 1;
		const parsed = parseCloudEnvironmentState({
			schemaVersion: 1,
			revision: 0,
			environments,
			vault,
		});
		expect(parsed.environments).toHaveLength(2);
		expect(parsed.vault).toHaveLength(1);
		expect(0 in parsed.environments).toBe(false);
		expect(0 in parsed.vault).toBe(false);
	});
	test("drops inherited and non-enumerable vault values before the public check", () => {
		const entry = Object.assign(
			Object.create({ value: "inherited-secret" }),
			cloudEnvironmentFixture.vault[0]
		);
		Object.defineProperty(entry, "value", {
			value: "non-enumerable-secret",
			enumerable: false,
		});
		const parsed = parseCloudEnvironmentState({
			...cloudEnvironmentFixture,
			vault: [entry],
		});
		deepStrictEqual(parsed.vault, [cloudEnvironmentFixture.vault[0]]);
		expect(Object.hasOwn(parsed.vault[0] ?? {}, "value")).toBe(false);
	});
	test("retains the original admission order and plain error messages", () => {
		expect(() =>
			parseCloudEnvironmentState({
				...cloudEnvironmentFixture,
				revision: -1,
				vault: [{ value: "secret" }],
			})
		).toThrow(new Error("Invalid cloud environment state"));
		expect(() =>
			parseCloudEnvironmentState({
				...cloudEnvironmentFixture,
				environments: [
					{
						...cloudEnvironmentFixture.environments[0],
						id: null,
						internet: null,
					},
				],
			})
		).toThrow(new Error("Invalid cloud environment response"));
	});
});

describe("cloud environment runtime", () => {
	const base = cloudEnvironmentFixture.environments[0];
	const withRuntime = (runtime: unknown) =>
		parseCloudEnvironmentState({
			...cloudEnvironmentFixture,
			environments: [{ ...base, runtime }],
		});
	test("an older document without runtime parses with the defaults", () => {
		const parsed = parseCloudEnvironmentState(cloudEnvironmentFixture);
		for (const environment of parsed.environments) {
			expect(environment.runtime).toEqual({
				backend: "auto",
				executor: "ryu",
				lifetimeMinutes: 30,
			});
		}
	});
	test("a valid Fresh cloud box runtime with a managed agent parses", () => {
		const runtime = {
			backend: "box",
			executor: "codex",
			lifetimeMinutes: 120,
		} as const;
		expect(withRuntime(runtime).environments[0]?.runtime).toEqual(runtime);
	});
	test("rejects an unknown executor and out-of-range lifetimes", () => {
		expect(() =>
			withRuntime({ backend: "box", executor: "devin", lifetimeMinutes: 30 })
		).toThrow("Invalid cloud environment runtime");
		expect(() =>
			withRuntime({ backend: "box", executor: "codex", lifetimeMinutes: 4 })
		).toThrow("Invalid cloud environment runtime");
		expect(() =>
			withRuntime({ backend: "box", executor: "codex", lifetimeMinutes: 241 })
		).toThrow("Invalid cloud environment runtime");
		expect(() =>
			withRuntime({ backend: "docker", executor: "ryu", lifetimeMinutes: 30 })
		).toThrow("Invalid cloud environment runtime");
		expect(() => withRuntime(null)).toThrow();
	});
	test("flags managed agents outside a box and VPN on a box", () => {
		const environment = {
			internet: {
				enabled: true,
				domainPolicy: "all" as const,
				allowedDomains: [],
			},
			tailscaleVaultKey: null,
			vaultKeys: ["OPENAI_API_KEY"],
		};
		expect(
			cloudEnvironmentRuntimeIssue({
				...environment,
				runtime: { backend: "auto", executor: "codex", lifetimeMinutes: 30 },
			})
		).toContain("Fresh cloud box");
		expect(
			cloudEnvironmentRuntimeIssue({
				...environment,
				tailscaleVaultKey: "CLOUD_VPN",
				runtime: { backend: "box", executor: "ryu", lifetimeMinutes: 30 },
			})
		).toContain("VPN");
		expect(
			cloudEnvironmentRuntimeIssue({
				...environment,
				internet: { ...environment.internet, enabled: false },
				runtime: {
					backend: "box",
					executor: "claude-code",
					lifetimeMinutes: 30,
				},
			})
		).toContain("internet");
		expect(
			cloudEnvironmentRuntimeIssue(
				{
					...environment,
					runtime: { backend: "box", executor: "codex", lifetimeMinutes: 30 },
				},
				[{ key: "OPENAI_API_KEY", kind: "networkSecret" }]
			)
		).toContain("network secrets");
		expect(
			cloudEnvironmentRuntimeIssue({
				...environment,
				runtime: { backend: "box", executor: "codex", lifetimeMinutes: 4 },
			})
		).toContain("Session length");
		expect(
			cloudEnvironmentRuntimeIssue({
				...environment,
				runtime: { backend: "box", executor: "codex", lifetimeMinutes: 240 },
			})
		).toBeNull();
		expect(cloudEnvironmentRuntimeIssue(environment)).toBeNull();
	});
	test("flags variables a box reserves or cannot carry", () => {
		const environment = {
			internet: {
				enabled: true,
				domainPolicy: "all" as const,
				allowedDomains: [],
			},
			tailscaleVaultKey: null,
			runtime: {
				backend: "box" as const,
				executor: "codex" as const,
				lifetimeMinutes: 30,
			},
		};
		expect(
			cloudEnvironmentRuntimeIssue({
				...environment,
				vaultKeys: ["OPENAI_API_KEY", "USER", "DOCKER_HOST"],
			})
		).toContain("USER, DOCKER_HOST");
		const keys = Array.from({ length: 65 }, (_, index) => `KEY_${index}`);
		expect(
			cloudEnvironmentRuntimeIssue({ ...environment, vaultKeys: keys })
		).toContain("at most 64");
		expect(
			cloudEnvironmentRuntimeIssue({
				...environment,
				vaultKeys: keys.slice(0, 64),
			})
		).toBeNull();
		expect(
			cloudEnvironmentRuntimeIssue({
				...environment,
				runtime: { backend: "auto", executor: "ryu", lifetimeMinutes: 30 },
				vaultKeys: ["USER"],
			})
		).toBeNull();
	});
});
