// Personal use is free, but the capabilities Ryu pays for per user stay behind
// a subscription. These tests pin both halves at the desktop layer: the verdict
// a free desktop resolves to, and what `canUse` answers for it.

import { expect, test } from "bun:test";
import {
	decideDesktopAccess,
	type Entitlement,
	GATED_CAPABILITIES,
	usdToMicro,
} from "@ryu/auth/lib/plans";
import { verdictAllows } from "./useEntitlement.ts";

const NOW = 1_800_000_000_000;

const unentitled: Entitlement = {
	plan: null,
	desktopAccess: false,
	marketplaceApps: false,
	managedInference: false,
	monthlyCreditPoolMicroUsd: 0,
	seats: 0,
};
const pro: Entitlement = {
	plan: "pro",
	desktopAccess: true,
	marketplaceApps: true,
	managedInference: true,
	monthlyCreditPoolMicroUsd: usdToMicro(10),
	seats: 1,
};
const license: Entitlement = {
	plan: "desktop-license",
	desktopAccess: true,
	marketplaceApps: false,
	managedInference: false,
	monthlyCreditPoolMicroUsd: 0,
	seats: 1,
};

const verdictFor = (liveEntitlement: Entitlement | null) =>
	decideDesktopAccess({
		liveEntitlement,
		licenseActive: false,
		cached: null,
		nowMs: NOW,
	});

test("nothing is unlocked while the verdict is unresolved", () => {
	for (const capability of GATED_CAPABILITIES) {
		expect(verdictAllows(null, capability)).toBe(false);
	}
});

test("a free desktop cannot use any capability that costs money per user", () => {
	const free = verdictFor(unentitled);
	expect(free.reason).toBe("free");
	expect(GATED_CAPABILITIES.length).toBeGreaterThan(0);
	for (const capability of GATED_CAPABILITIES) {
		expect(verdictAllows(free, capability)).toBe(false);
	}
});

test("an offline free desktop stays free and still cannot use paid capabilities", () => {
	const offline = verdictFor(null);
	expect(offline.reason).toBe("free");
	expect(verdictAllows(offline, "managed-inference")).toBe(false);
	expect(verdictAllows(offline, "cloud-node")).toBe(false);
});

test("a desktop license alone does not unlock managed services", () => {
	const licensed = verdictFor(license);
	expect(licensed.reason).toBe("license");
	for (const capability of GATED_CAPABILITIES) {
		expect(verdictAllows(licensed, capability)).toBe(false);
	}
});

test("a subscription with managed access unlocks every paid capability", () => {
	const subscribed = verdictFor(pro);
	expect(subscribed.reason).toBe("subscription");
	for (const capability of GATED_CAPABILITIES) {
		expect(verdictAllows(subscribed, capability)).toBe(true);
	}
});
