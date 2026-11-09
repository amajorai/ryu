import { describe, expect, it } from "bun:test";

import { OPERATIONAL_FEATURE_FLAGS } from "./feature-flag-catalog-operational.ts";
import { MOBILE_DEVICE_TOOLS_FLAG as KEY_FROM_KEYS } from "./feature-flag-keys.ts";
import {
	coreClaimFlagKeys,
	coreFlagClaimFromValues,
	defaultFeatureFlags,
	FEATURE_FLAGS,
	featureFlagByKey,
	featureFlagFallback,
	MOBILE_DEVICE_TOOLS_FLAG,
	resolveFeatureFlags,
} from "./feature-flags.ts";

/**
 * Phone app tools ship dark: Core reads the key from the signed `ryu_flags`
 * claim (`apps/core/src/device_tools/flag.rs`), so its wire name, default and
 * claim membership are a contract with Core.
 */
describe("mobile.device_tools", () => {
	it("uses the wire key Core checks and is re-exported from feature-flags", () => {
		expect(MOBILE_DEVICE_TOOLS_FLAG).toBe("mobile.device_tools");
		expect(KEY_FROM_KEYS).toBe(MOBILE_DEVICE_TOOLS_FLAG);
		expect(
			FEATURE_FLAGS.filter((flag) => flag.key === MOBILE_DEVICE_TOOLS_FLAG)
		).toHaveLength(1);
	});

	it("ships off, client-exposed, fail-closed and carried to Core", () => {
		expect(featureFlagByKey(MOBILE_DEVICE_TOOLS_FLAG)).toMatchObject({
			coreClaim: true,
			defaultValue: false,
			exposure: "client",
			failMode: "closed",
		});
		expect(
			featureFlagByKey(MOBILE_DEVICE_TOOLS_FLAG)?.audiences
		).toBeUndefined();
		expect(featureFlagFallback(MOBILE_DEVICE_TOOLS_FLAG)).toBe(false);
		expect(defaultFeatureFlags()[MOBILE_DEVICE_TOOLS_FLAG]).toBe(false);
		expect(resolveFeatureFlags()[MOBILE_DEVICE_TOOLS_FLAG]).toBe(false);
	});

	it("reaches the Core claim only when it evaluates on", () => {
		expect(coreClaimFlagKeys()).toContain(MOBILE_DEVICE_TOOLS_FLAG);
		expect(coreFlagClaimFromValues({})).not.toContain(MOBILE_DEVICE_TOOLS_FLAG);
		expect(
			coreFlagClaimFromValues({ [MOBILE_DEVICE_TOOLS_FLAG]: false })
		).not.toContain(MOBILE_DEVICE_TOOLS_FLAG);
		expect(
			coreFlagClaimFromValues({ [MOBILE_DEVICE_TOOLS_FLAG]: true })
		).toContain(MOBILE_DEVICE_TOOLS_FLAG);
		// A non-boolean override never opens it.
		expect(
			resolveFeatureFlags({
				overrides: { [MOBILE_DEVICE_TOOLS_FLAG]: "true" },
			})[MOBILE_DEVICE_TOOLS_FLAG]
		).toBe(false);
		expect(
			resolveFeatureFlags({ overrides: { [MOBILE_DEVICE_TOOLS_FLAG]: true } })[
				MOBILE_DEVICE_TOOLS_FLAG
			]
		).toBe(true);
	});

	it("appends the operational rows to the catalog, in order, after the split", () => {
		expect(FEATURE_FLAGS.slice(-OPERATIONAL_FEATURE_FLAGS.length)).toEqual(
			OPERATIONAL_FEATURE_FLAGS
		);
		expect(
			OPERATIONAL_FEATURE_FLAGS.every((flag) => flag.exposure === "private")
		).toBe(true);

		for (const key of [
			"services.managed_agents",
			"abuse.jobs",
			"auth.device_limits",
		]) {
			expect(featureFlagByKey(key)?.exposure).toBe("private");
		}
	});
});
