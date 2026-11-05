import { describe, expect, test } from "bun:test";
import {
	type CloudEnvironment,
	type CloudEnvironmentRuntime,
	type CloudVaultEntry,
	cloudEnvironmentRuntimeIssue,
} from "./cloud-environments.ts";
import {
	CLOUD_ENVIRONMENT_ISSUE_CODES,
	type CloudEnvironmentIssueCode,
	cloudEnvironmentIssue,
} from "./cloud-environments-issue.ts";

type Input = Pick<
	CloudEnvironment,
	"internet" | "runtime" | "tailscaleVaultKey" | "vaultKeys"
>;
type Vault = Pick<CloudVaultEntry, "key" | "kind">[];

const base: Input = {
	internet: { enabled: true, domainPolicy: "all", allowedDomains: [] },
	tailscaleVaultKey: null,
	vaultKeys: ["OPENAI_API_KEY"],
	runtime: { backend: "box", executor: "codex", lifetimeMinutes: 30 },
};

function withRuntime(change: Partial<CloudEnvironmentRuntime>): Input {
	return {
		...base,
		runtime: {
			backend: "box",
			executor: "codex",
			lifetimeMinutes: 30,
			...change,
		},
	};
}

/** One environment that trips each code, with the vault it needs. */
const CASES: Record<CloudEnvironmentIssueCode, [Input, Vault?]> = {
	unsupported_backend: [
		withRuntime({ backend: "docker" as CloudEnvironmentRuntime["backend"] }),
	],
	unsupported_agent: [
		withRuntime({ executor: "aider" as CloudEnvironmentRuntime["executor"] }),
	],
	lifetime_out_of_range: [withRuntime({ lifetimeMinutes: 4 })],
	managed_agent_requires_box: [withRuntime({ backend: "auto" })],
	managed_agent_requires_internet: [
		{ ...base, internet: { ...base.internet, enabled: false } },
	],
	box_rejects_tailscale: [{ ...base, tailscaleVaultKey: "CLOUD_VPN" }],
	box_rejects_network_secret: [
		base,
		[{ key: "OPENAI_API_KEY", kind: "networkSecret" }],
	],
	box_reserved_names: [
		{ ...base, vaultKeys: ["OPENAI_API_KEY", "USER", "DOCKER_HOST"] },
	],
	box_too_many_variables: [
		{
			...base,
			vaultKeys: Array.from({ length: 65 }, (_, index) => `KEY_${index}`),
		},
	],
};

describe("cloudEnvironmentIssue", () => {
	test("every code has a triggering case and the case yields that code", () => {
		expect(Object.keys(CASES).sort()).toEqual(
			[...CLOUD_ENVIRONMENT_ISSUE_CODES].sort()
		);
		for (const code of CLOUD_ENVIRONMENT_ISSUE_CODES) {
			const [environment, vault] = CASES[code];
			expect(cloudEnvironmentIssue(environment, vault)?.code).toBe(code);
		}
	});

	test("carries the values a whole message needs", () => {
		expect(cloudEnvironmentIssue(...CASES.lifetime_out_of_range)).toEqual({
			code: "lifetime_out_of_range",
			values: { min: 5, max: 240 },
		});
		expect(cloudEnvironmentIssue(...CASES.box_rejects_network_secret)).toEqual({
			code: "box_rejects_network_secret",
			values: { key: "OPENAI_API_KEY" },
		});
		expect(cloudEnvironmentIssue(...CASES.box_reserved_names)).toEqual({
			code: "box_reserved_names",
			values: { names: ["USER", "DOCKER_HOST"] },
		});
		expect(cloudEnvironmentIssue(...CASES.box_too_many_variables)).toEqual({
			code: "box_too_many_variables",
			values: { max: 64 },
		});
	});

	test("valid environments report nothing", () => {
		expect(cloudEnvironmentIssue(base)).toBeNull();
		expect(cloudEnvironmentIssue(withRuntime({ lifetimeMinutes: 240 }))).toBe(
			null
		);
		expect(
			cloudEnvironmentIssue({
				...base,
				runtime: { backend: "auto", executor: "ryu", lifetimeMinutes: 30 },
				vaultKeys: ["USER"],
			})
		).toBeNull();
	});

	test("flags exactly what the English cloudEnvironmentRuntimeIssue flags", () => {
		const valid: [Input, Vault?][] = [
			[base],
			[withRuntime({ backend: "auto", executor: "ryu" })],
		];
		for (const [environment, vault] of [...Object.values(CASES), ...valid]) {
			expect(cloudEnvironmentIssue(environment, vault) === null).toBe(
				cloudEnvironmentRuntimeIssue(environment, vault) === null
			);
		}
	});
});
