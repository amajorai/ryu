import { describe, expect, it } from "bun:test";
import {
	type CachedEntitlement,
	capabilityTier,
	type DesktopGateInput,
	decideDesktopAccess,
	type Entitlement,
	GATED_CAPABILITIES,
	planLimit,
	usdToMicro,
} from "./plans.ts";

describe("decideDesktopAccess (personal use is free)", () => {
	const NOW = 1_000_000_000_000;
	const DAY = 24 * 60 * 60 * 1000;

	const sub: Entitlement = {
		plan: "pro",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		monthlyCreditPoolMicroUsd: usdToMicro(10),
		seats: 1,
	};
	const licenseEnt: Entitlement = {
		plan: "desktop-license",
		desktopAccess: true,
		marketplaceApps: false,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 1,
	};
	const noneEnt: Entitlement = {
		plan: null,
		desktopAccess: false,
		marketplaceApps: false,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 0,
	};
	const paidCache: CachedEntitlement = {
		cachedAtMs: NOW - 3 * DAY,
		marketplaceApps: true,
		proUnlocked: true,
		managedInference: true,
		plan: "pro",
	};

	// A signed-in account with no plan and no license key.
	const base: DesktopGateInput = {
		liveEntitlement: noneEnt,
		licenseActive: false,
		cached: null,
		nowMs: NOW,
	};

	it("gives an account with no plan every local feature and no managed services", () => {
		const v = decideDesktopAccess(base);
		expect(v).toEqual({
			proUnlocked: true,
			marketplaceApps: false,
			managedInference: false,
			plan: null,
			reason: "free",
		});
	});

	it("has no trial clock: the verdict does not change with time", () => {
		const later = decideDesktopAccess({ ...base, nowMs: NOW + 400 * DAY });
		expect(later).toEqual(decideDesktopAccess(base));
		expect(later).not.toHaveProperty("daysLeftInTrial");
		expect(later).not.toHaveProperty("paywalled");
	});

	it("stays free when the live check failed and nothing was ever cached", () => {
		const v = decideDesktopAccess({ ...base, liveEntitlement: null });
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(false);
		expect(v.reason).toBe("free");
	});

	it("unlocks via an active subscription with managed inference", () => {
		const v = decideDesktopAccess({ ...base, liveEntitlement: sub });
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(true);
		expect(v.marketplaceApps).toBe(true);
		expect(v.plan).toBe("pro");
		expect(v.reason).toBe("subscription");
	});

	it("keeps a desktop license holder's state and withholds managed inference", () => {
		const v = decideDesktopAccess({ ...base, liveEntitlement: licenseEnt });
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(false);
		expect(v.plan).toBe("desktop-license");
		expect(v.reason).toBe("license");
	});

	it("honours a freshly validated license key when the live check lags", () => {
		const v = decideDesktopAccess({ ...base, licenseActive: true });
		expect(v.proUnlocked).toBe(true);
		expect(v.plan).toBe("desktop-license");
		expect(v.managedInference).toBe(false);
		expect(v.reason).toBe("license");
	});

	it("rides the offline grace window on a failed live check with a fresh paid cache", () => {
		const v = decideDesktopAccess({
			...base,
			liveEntitlement: null, // live check failed (offline)
			cached: paidCache,
		});
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(true);
		expect(v.plan).toBe("pro");
		expect(v.reason).toBe("offline-grace");
	});

	it("drops to free, never to a lock, once the offline grace window has lapsed", () => {
		const v = decideDesktopAccess({
			...base,
			liveEntitlement: null,
			cached: { ...paidCache, cachedAtMs: NOW - 10 * DAY },
		});
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(false);
		expect(v.plan).toBe(null);
		expect(v.reason).toBe("free");
	});

	it("does not grant offline grace from a cache without a paid plan", () => {
		const v = decideDesktopAccess({
			...base,
			liveEntitlement: null,
			cached: { ...paidCache, managedInference: false, plan: null },
		});
		expect(v.reason).toBe("free");
		expect(v.managedInference).toBe(false);
	});

	it("does not let a paid cache override a successful un-entitled live check", () => {
		const v = decideDesktopAccess({ ...base, cached: paidCache });
		expect(v.reason).toBe("free");
		expect(v.managedInference).toBe(false);
	});
});

describe("desktop caps are gone for every plan, including none", () => {
	it("puts no limit on open tabs or remote nodes without a plan", () => {
		expect(planLimit(null, "maxOpenTabs")).toBe(Number.POSITIVE_INFINITY);
		expect(planLimit(null, "maxRemoteNodes")).toBe(Number.POSITIVE_INFINITY);
	});

	it("keeps the hosted storage allowance, which costs money per user", () => {
		expect(planLimit(null, "spaceStorageLimitGb")).toBe(1);
		expect(planLimit("pro", "spaceStorageLimitGb")).toBe(10);
	});
});

describe("CAPABILITY_TIERS — free local features and paid managed services", () => {
	it("does not plan-gate local desktop power features", () => {
		for (const capability of [
			"prompt-studio",
			"evals",
			"graphrag",
			"companion-overlay",
			"gateway-governance-ui",
		] as const) {
			expect(GATED_CAPABILITIES).not.toContain(capability);
		}
	});

	it("does not plan-gate Marketplace app and plugin surfaces", () => {
		for (const capability of [
			"council",
			"local-background-runs",
			"fine-tuning",
			"clips",
		] as const) {
			expect(GATED_CAPABILITIES).not.toContain(capability);
		}
	});

	it("keeps cloud capabilities in the subscription band", () => {
		for (const cap of [
			"managed-inference",
			"cloud-sync",
			"cloud-node",
			"hosted-bots",
			"team-seats",
			"agent-mail",
		] as const) {
			expect(capabilityTier(cap)).toBe("subscription");
		}
	});

	it("keeps exactly the six paid capabilities gated", () => {
		expect([...GATED_CAPABILITIES].sort()).toEqual([
			"agent-mail",
			"cloud-node",
			"cloud-sync",
			"hosted-bots",
			"managed-inference",
			"team-seats",
		]);
	});
});
