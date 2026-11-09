// Coded sibling of `cloudEnvironmentRuntimeIssue`.
//
// The protocol package carries no display language: this returns a stable code
// plus the values a message needs, and each client maps the code to a whole
// translated sentence (desktop: `CloudEnvironmentsSettings-issue-copy.ts`). The
// English-returning `cloudEnvironmentRuntimeIssue` stays for existing callers and
// must flag exactly the same environments; `cloud-environments-issue.test.ts`
// checks that parity.

import {
	type BoxNetworkSecretProblem,
	boxNetworkSecretProblem,
	CLOUD_ENVIRONMENT_BACKENDS,
	CLOUD_ENVIRONMENT_EXECUTORS,
	CLOUD_ENVIRONMENT_LIFETIME_MINUTES,
	type CloudEnvironment,
	type CloudVaultEntry,
	DEFAULT_CLOUD_ENVIRONMENT_RUNTIME,
	isBoxReservedVariable,
	MAX_BOX_VARIABLES,
} from "./cloud-environments.ts";

/** Every runtime problem the client can detect without the node, one value each. */
export type CloudEnvironmentIssue =
	| { code: "unsupported_backend" }
	| { code: "unsupported_agent" }
	| { code: "lifetime_out_of_range"; values: { min: number; max: number } }
	| { code: "managed_agent_requires_box" }
	| { code: "managed_agent_requires_internet" }
	| { code: "box_rejects_tailscale" }
	| BoxNetworkSecretProblem
	| { code: "box_reserved_names"; values: { names: readonly string[] } }
	| { code: "box_too_many_variables"; values: { max: number } };

export type CloudEnvironmentIssueCode = CloudEnvironmentIssue["code"];

/** All codes, in the order the checks run. */
export const CLOUD_ENVIRONMENT_ISSUE_CODES: readonly CloudEnvironmentIssueCode[] =
	[
		"unsupported_backend",
		"unsupported_agent",
		"lifetime_out_of_range",
		"managed_agent_requires_box",
		"managed_agent_requires_internet",
		"box_rejects_tailscale",
		"box_too_many_network_secrets",
		"box_network_secret_not_host_name",
		"box_network_secret_domain_not_allowed",
		"box_reserved_names",
		"box_too_many_variables",
	];

/**
 * Client-side mirror of the Core runtime rules, as a code. Core remains
 * authoritative (domain allowlists and Box availability are checked there).
 */
export function cloudEnvironmentIssue(
	environment: Pick<
		CloudEnvironment,
		"internet" | "runtime" | "tailscaleVaultKey" | "vaultKeys"
	>,
	vault: readonly SecretVaultEntry[] = []
): CloudEnvironmentIssue | null {
	const runtime = environment.runtime ?? DEFAULT_CLOUD_ENVIRONMENT_RUNTIME;
	if (!CLOUD_ENVIRONMENT_BACKENDS.includes(runtime.backend)) {
		return { code: "unsupported_backend" };
	}
	if (!CLOUD_ENVIRONMENT_EXECUTORS.includes(runtime.executor)) {
		return { code: "unsupported_agent" };
	}
	if (
		!Number.isInteger(runtime.lifetimeMinutes) ||
		runtime.lifetimeMinutes < CLOUD_ENVIRONMENT_LIFETIME_MINUTES.min ||
		runtime.lifetimeMinutes > CLOUD_ENVIRONMENT_LIFETIME_MINUTES.max
	) {
		return {
			code: "lifetime_out_of_range",
			values: {
				min: CLOUD_ENVIRONMENT_LIFETIME_MINUTES.min,
				max: CLOUD_ENVIRONMENT_LIFETIME_MINUTES.max,
			},
		};
	}
	if (runtime.executor !== "ryu" && runtime.backend !== "box") {
		return { code: "managed_agent_requires_box" };
	}
	if (runtime.executor !== "ryu" && !environment.internet.enabled) {
		return { code: "managed_agent_requires_internet" };
	}
	if (runtime.backend !== "box") {
		return null;
	}
	return boxIssue(environment, vault);
}

type SecretVaultEntry = Pick<CloudVaultEntry, "key" | "kind"> &
	Partial<Pick<CloudVaultEntry, "domains">>;

function boxIssue(
	environment: Pick<
		CloudEnvironment,
		"internet" | "tailscaleVaultKey" | "vaultKeys"
	>,
	vault: readonly SecretVaultEntry[]
): CloudEnvironmentIssue | null {
	if (environment.tailscaleVaultKey) {
		return { code: "box_rejects_tailscale" };
	}
	const secretProblem = boxNetworkSecretProblem(environment, vault);
	if (secretProblem) {
		return secretProblem;
	}
	const reserved = environment.vaultKeys.filter(isBoxReservedVariable);
	if (reserved.length > 0) {
		return { code: "box_reserved_names", values: { names: reserved } };
	}
	if (environment.vaultKeys.length > MAX_BOX_VARIABLES) {
		return {
			code: "box_too_many_variables",
			values: { max: MAX_BOX_VARIABLES },
		};
	}
	return null;
}
