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
type Vault = (Pick<CloudVaultEntry, "key" | "kind"> &
	Partial<Pick<CloudVaultEntry, "domains">>)[];

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

const secretKeys = Array.from({ length: 17 }, (_, index) => `SECRET_${index}`);

/** A network secret bound to a host name, which a Fresh cloud box substitutes. */
const hostSecret: [Input, Vault] = [
	base,
	[
		{
			key: "OPENAI_API_KEY",
			kind: "networkSecret",
			domains: ["api.openai.com"],
		},
	],
];

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
	box_too_many_network_secrets: [
		{ ...base, vaultKeys: secretKeys },
		secretKeys.map((key) => ({
			key,
			kind: "networkSecret" as const,
			domains: ["api.example.com"],
		})),
	],
	box_network_secret_not_host_name: [
		base,
		[{ key: "OPENAI_API_KEY", kind: "networkSecret", domains: ["10.0.0.1"] }],
	],
	box_network_secret_domain_not_allowed: [
		{
			...base,
			internet: {
				enabled: true,
				domainPolicy: "custom",
				allowedDomains: ["*.github.com"],
			},
		},
		[
			{
				key: "OPENAI_API_KEY",
				kind: "networkSecret",
				domains: ["api.openai.com"],
			},
		],
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
		expect(
			cloudEnvironmentIssue(...CASES.box_too_many_network_secrets)
		).toEqual({ code: "box_too_many_network_secrets", values: { max: 16 } });
		expect(
			cloudEnvironmentIssue(...CASES.box_network_secret_not_host_name)
		).toEqual({
			code: "box_network_secret_not_host_name",
			values: { key: "OPENAI_API_KEY", domain: "10.0.0.1" },
		});
		expect(
			cloudEnvironmentIssue(...CASES.box_network_secret_domain_not_allowed)
		).toEqual({
			code: "box_network_secret_domain_not_allowed",
			values: { key: "OPENAI_API_KEY", domain: "api.openai.com" },
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

	test("a Fresh cloud box accepts a network secret bound to a host name", () => {
		expect(cloudEnvironmentIssue(...hostSecret)).toBeNull();
	});

	test("flags exactly what the English cloudEnvironmentRuntimeIssue flags", () => {
		const valid: [Input, Vault?][] = [
			[base],
			[withRuntime({ backend: "auto", executor: "ryu" })],
			hostSecret,
		];
		for (const [environment, vault] of [...Object.values(CASES), ...valid]) {
			expect(cloudEnvironmentIssue(environment, vault) === null).toBe(
				cloudEnvironmentRuntimeIssue(environment, vault) === null
			);
		}
	});
});
