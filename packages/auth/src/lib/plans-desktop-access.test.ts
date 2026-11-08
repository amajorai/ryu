import { describe, expect, it } from "bun:test";
import {
	type CachedEntitlement,
	capabilityTier,
	DESKTOP_GATE,
	type DesktopGateConfig,
	type DesktopGateInput,
	decideDesktopAccess,
	desktopGateConfig,
	type Entitlement,
	GATED_CAPABILITIES,
	usdToMicro,
} from "./plans.ts";

describe("decideDesktopAccess (trial + paywall gate)", () => {
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

	const base: DesktopGateInput = {
		firstLaunchMs: NOW - 30 * DAY, // trial long over
		liveEntitlement: noneEnt,
		licenseActive: false,
		cached: null,
		nowMs: NOW,
	};

	// The paid gate. This now equals the shipped default (betaFree: false), but
	// we pin it explicitly so these trial/paywall assertions stay correct even if
	// the break-glass flag is ever flipped on in the default config.
	const PAID_GATE: DesktopGateConfig = { ...DESKTOP_GATE, betaFree: false };

	it("unlocks via an active subscription with managed inference", () => {
		const v = decideDesktopAccess({ ...base, liveEntitlement: sub });
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(true);
		expect(v.paywalled).toBe(false);
		expect(v.reason).toBe("subscription");
	});

	it("unlocks via a desktop license but withholds managed inference", () => {
		const v = decideDesktopAccess({ ...base, liveEntitlement: licenseEnt });
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(false);
		expect(v.reason).toBe("license");
	});

	it("unlocks via a freshly validated license key when live lags", () => {
		const v = decideDesktopAccess({ ...base, licenseActive: true });
		expect(v.proUnlocked).toBe(true);
		expect(v.plan).toBe("desktop-license");
		expect(v.reason).toBe("license");
	});

	it("grants full access inside the 7-day trial", () => {
		const v = decideDesktopAccess(
			{ ...base, firstLaunchMs: NOW - 2 * DAY },
			PAID_GATE
		);
		expect(v.proUnlocked).toBe(true);
		expect(v.paywalled).toBe(false);
		expect(v.reason).toBe("trial");
		expect(v.daysLeftInTrial).toBe(5);
	});

	it("treats a missing first-launch as a fresh trial (no false lockout)", () => {
		const v = decideDesktopAccess({ ...base, firstLaunchMs: null }, PAID_GATE);
		expect(v.proUnlocked).toBe(true);
		expect(v.reason).toBe("trial");
		expect(v.daysLeftInTrial).toBe(7);
	});

	it("paywalls after trial expiry with no sub/license", () => {
		const v = decideDesktopAccess(base, PAID_GATE);
		expect(v.proUnlocked).toBe(false);
		expect(v.paywalled).toBe(true);
		expect(v.reason).toBe("trial-expired");
		expect(v.daysLeftInTrial).toBe(0);
	});

	it("rides the offline grace window on a failed live check with fresh cache", () => {
		const cached: CachedEntitlement = {
			cachedAtMs: NOW - 3 * DAY,
			marketplaceApps: true,
			proUnlocked: true,
			managedInference: true,
			plan: "pro",
		};
		const v = decideDesktopAccess(
			{
				...base,
				liveEntitlement: null, // live check failed (offline)
				cached,
			},
			PAID_GATE
		);
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(true);
		expect(v.reason).toBe("offline-grace");
	});

	it("locks once the offline grace window has lapsed", () => {
		const cached: CachedEntitlement = {
			cachedAtMs: NOW - 10 * DAY, // older than the 7-day grace
			marketplaceApps: true,
			proUnlocked: true,
			managedInference: true,
			plan: "pro",
		};
		const v = decideDesktopAccess(
			{ ...base, liveEntitlement: null, cached },
			PAID_GATE
		);
		expect(v.proUnlocked).toBe(false);
		expect(v.paywalled).toBe(true);
	});

	it("does not grant offline grace from a non-Pro cache", () => {
		const cached: CachedEntitlement = {
			cachedAtMs: NOW - 1 * DAY,
			marketplaceApps: false,
			proUnlocked: false,
			managedInference: false,
			plan: null,
		};
		const v = decideDesktopAccess(
			{ ...base, liveEntitlement: null, cached },
			PAID_GATE
		);
		expect(v.proUnlocked).toBe(false);
		expect(v.paywalled).toBe(true);
	});
});

describe("decideDesktopAccess — betaFree break-glass flag (off by default)", () => {
	const NOW = 1_000_000_000_000;
	const DAY = 24 * 60 * 60 * 1000;

	const noneEnt: Entitlement = {
		plan: null,
		desktopAccess: false,
		marketplaceApps: false,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 0,
	};
	const sub: Entitlement = {
		plan: "pro",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		monthlyCreditPoolMicroUsd: usdToMicro(10),
		seats: 1,
	};

	// Trial long over, no sub/license — paywalled under the shipped default;
	// unlocked only when the break-glass flag is explicitly turned on.
	const expired: DesktopGateInput = {
		firstLaunchMs: NOW - 30 * DAY,
		liveEntitlement: noneEnt,
		licenseActive: false,
		cached: null,
		nowMs: NOW,
	};
	const BETA_ON: DesktopGateConfig = { ...DESKTOP_GATE, betaFree: true };

	it("paywalls an expired user under the shipped default (no free Pro)", () => {
		const v = decideDesktopAccess(expired);
		expect(v.proUnlocked).toBe(false);
		expect(v.paywalled).toBe(true);
		expect(v.reason).toBe("trial-expired");
	});

	it("unlocks Pro for everyone only when the flag is explicitly on", () => {
		const v = decideDesktopAccess(expired, BETA_ON);
		expect(v.proUnlocked).toBe(true);
		expect(v.paywalled).toBe(false);
		expect(v.reason).toBe("beta");
	});

	it("withholds managed inference even under the beta flag (no free cloud spend)", () => {
		const v = decideDesktopAccess(expired, BETA_ON);
		expect(v.managedInference).toBe(false);
		expect(v.plan).toBe(null);
		expect(v.daysLeftInTrial).toBe(0);
	});

	it("maps the desktop trial rollout flag onto betaFree", () => {
		expect(desktopGateConfig(true)).toEqual(DESKTOP_GATE);
		expect(desktopGateConfig(false).betaFree).toBe(true);
		const trialOff = decideDesktopAccess(expired, desktopGateConfig(false));
		expect(trialOff.reason).toBe("beta");
		expect(trialOff.paywalled).toBe(false);
		const paidTrialOff = decideDesktopAccess(
			{ ...expired, liveEntitlement: sub },
			desktopGateConfig(false)
		);
		expect(paidTrialOff.reason).toBe("subscription");
		expect(paidTrialOff.managedInference).toBe(true);
	});

	it("keeps an offline subscriber's cached plan under the beta flag", () => {
		const cached: CachedEntitlement = {
			cachedAtMs: NOW - 1 * DAY,
			marketplaceApps: true,
			proUnlocked: true,
			managedInference: true,
			plan: "pro",
		};
		const offline = decideDesktopAccess(
			{ ...expired, liveEntitlement: null, cached },
			desktopGateConfig(false)
		);
		expect(offline.reason).toBe("offline-grace");
		expect(offline.plan).toBe("pro");
		expect(offline.managedInference).toBe(true);

		const betaCache = decideDesktopAccess(
			{
				...expired,
				liveEntitlement: null,
				cached: { ...cached, managedInference: false, plan: null },
			},
			desktopGateConfig(false)
		);
		expect(betaCache.reason).toBe("beta");
	});

	it("never shows a trial countdown under the beta flag", () => {
		const v = decideDesktopAccess(
			{ ...expired, firstLaunchMs: NOW - 2 * DAY },
			BETA_ON
		);
		expect(v.reason).toBe("beta");
		expect(v.daysLeftInTrial).toBe(0);
	});

	it("still honours a real subscription under the beta flag (keeps managed inference)", () => {
		const v = decideDesktopAccess(
			{ ...expired, liveEntitlement: sub },
			BETA_ON
		);
		expect(v.reason).toBe("subscription");
		expect(v.managedInference).toBe(true);
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
});
