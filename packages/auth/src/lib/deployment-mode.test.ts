import { afterAll, describe, expect, it, mock } from "bun:test";

// The env module is stubbed so each case states the configured value itself.
const configured: { RYU_DEPLOYMENT_MODE?: unknown } = {};
mock.module("@ryu/env/server", () => ({ env: configured }));

const {
	CLOUD_DEPLOYMENT_MODE,
	deploymentMode,
	deploymentModeFromValue,
	isSelfHostedDeployment,
	SELF_HOSTED_DEPLOYMENT_MODE,
} = await import("./deployment-mode.ts");

afterAll(() => {
	mock.restore();
});

describe("deploymentModeFromValue", () => {
	it("selects self-hosted only for the exact validated value", () => {
		expect(deploymentModeFromValue("self-hosted")).toBe(
			SELF_HOSTED_DEPLOYMENT_MODE
		);
	});

	it("keeps cloud for every other value", () => {
		for (const value of [
			undefined,
			null,
			"",
			"cloud",
			"Self-Hosted",
			" self-hosted ",
			"selfhosted",
			"self_hosted",
			"true",
			1,
			true,
			{},
		]) {
			expect(deploymentModeFromValue(value)).toBe(CLOUD_DEPLOYMENT_MODE);
		}
	});
});

describe("deploymentMode", () => {
	it("is cloud when the variable is not set", () => {
		configured.RYU_DEPLOYMENT_MODE = undefined;
		expect(deploymentMode()).toBe("cloud");
		expect(isSelfHostedDeployment()).toBe(false);
	});

	it("is cloud when the variable says cloud", () => {
		configured.RYU_DEPLOYMENT_MODE = "cloud";
		expect(deploymentMode()).toBe("cloud");
		expect(isSelfHostedDeployment()).toBe(false);
	});

	it("is self-hosted only when the variable says self-hosted", () => {
		configured.RYU_DEPLOYMENT_MODE = "self-hosted";
		expect(deploymentMode()).toBe("self-hosted");
		expect(isSelfHostedDeployment()).toBe(true);
	});

	it("reads the value on every call, not once at import", () => {
		configured.RYU_DEPLOYMENT_MODE = "self-hosted";
		expect(isSelfHostedDeployment()).toBe(true);
		configured.RYU_DEPLOYMENT_MODE = "cloud";
		expect(isSelfHostedDeployment()).toBe(false);
	});
});
