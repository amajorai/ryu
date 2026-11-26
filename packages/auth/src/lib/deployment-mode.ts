import { env } from "@ryu/env/server";

/**
 * Who operates this control plane, from `RYU_DEPLOYMENT_MODE`.
 *
 * - `cloud` is Ryu's hosted service and the default.
 * - `self-hosted` is a customer-operated install that says so explicitly.
 *
 * Rules that apply only to self-hosted installs must read this, never infer
 * the mode from missing data (no Polar subscription, an empty `ADMIN_EMAILS`):
 * a hosted organization without a plan must keep its hosted behaviour.
 */
export const CLOUD_DEPLOYMENT_MODE = "cloud" as const;
export const SELF_HOSTED_DEPLOYMENT_MODE = "self-hosted" as const;

export type DeploymentMode =
	| typeof CLOUD_DEPLOYMENT_MODE
	| typeof SELF_HOSTED_DEPLOYMENT_MODE;

/**
 * The mode a configured value selects. Only the exact validated value
 * `self-hosted` selects self-hosted; anything else is cloud. That covers an
 * unset variable, a build that skips env validation (`SKIP_ENV_VALIDATION`
 * leaves the raw string, so no default is applied), and a test that stubs the
 * env module with an empty object.
 */
export function deploymentModeFromValue(value: unknown): DeploymentMode {
	return value === SELF_HOSTED_DEPLOYMENT_MODE
		? SELF_HOSTED_DEPLOYMENT_MODE
		: CLOUD_DEPLOYMENT_MODE;
}

/** The deployment mode of this control plane. */
export function deploymentMode(): DeploymentMode {
	return deploymentModeFromValue(env.RYU_DEPLOYMENT_MODE);
}

/** Whether this control plane is an explicitly self-hosted install. */
export function isSelfHostedDeployment(): boolean {
	return deploymentMode() === SELF_HOSTED_DEPLOYMENT_MODE;
}
