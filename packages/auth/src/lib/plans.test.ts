import { describe, expect, it } from "bun:test";
import {
	type CachedEntitlement,
	capabilityTier,
	channelUserLimitForEntitlement,
	DEPOSIT_FEE_FIXED_MICRO_USD,
	DESKTOP_GATE,
	type DesktopGateConfig,
	type DesktopGateInput,
	decideDesktopAccess,
	depositFee,
	EMAIL_QUOTA_NONE,
	type Entitlement,
	emailQuotaForPlan,
	FREE_TIER_LIMITS,
	GATED_CAPABILITIES,
	MAIL_LIFECYCLE,
	managedInferenceAvailable,
	PLANS,
	resolveInboxLifecycle,
	type PolarBinding,
	planLimit,
	resolveEntitlement,
	resolveProductId,
	usdToMicro,
} from "./plans.ts";

// A reader that ignores env so tests use the catalog's documented defaults.
const defaultsOnly = (): undefined => undefined;

function requireBinding(
	binding: PolarBinding | undefined,
	name: string
): PolarBinding {
	if (!binding) {
		throw new Error(`Missing plan binding: ${name}`);
	}
	return binding;
}

describe("depositFee (max of 10% or $1.00 floor)", () => {
	it("charges the floor on a zero/negative amount", () => {
		expect(depositFee(0)).toBe(DEPOSIT_FEE_FIXED_MICRO_USD);
		expect(depositFee(-100)).toBe(DEPOSIT_FEE_FIXED_MICRO_USD);
	});

	it("charges the 10% percentage when it exceeds the floor", () => {
		// $100 top-up: 10% = $10.00 (> $1.00 floor) → $10.00.
		expect(depositFee(usdToMicro(100))).toBe(usdToMicro(10));
	});

	it("meets the floor exactly at the $10 break-even", () => {
		// $10 top-up: 10% = $1.00 = the floor.
		expect(depositFee(usdToMicro(10))).toBe(usdToMicro(1));
	});

	it("the $1.00 floor dominates below the break-even (nudges bigger top-ups)", () => {
		// $5 pack: 10% = $0.50, but the floor is $1.00 (20% effective).
		expect(depositFee(usdToMicro(5))).toBe(usdToMicro(1));
		expect(depositFee(usdToMicro(1))).toBe(DEPOSIT_FEE_FIXED_MICRO_USD);
	});
});

describe("emailQuotaForPlan (Agent Inboxes)", () => {
	it("disables email for the free baseline (null plan)", () => {
		expect(emailQuotaForPlan(null)).toEqual(EMAIL_QUOTA_NONE);
		expect(emailQuotaForPlan(null).enabled).toBe(false);
	});

	it("disables email for the desktop license (one-time, no managed cloud)", () => {
		const q = emailQuotaForPlan("desktop-license");
		expect(q.enabled).toBe(false);
		expect(q.inboxLimit).toBe(0);
		expect(q.monthlySendLimit).toBe(0);
	});

	it("enables email on the individual subscription plans (pro, max)", () => {
		for (const plan of ["pro", "max"] as const) {
			const q = emailQuotaForPlan(plan);
			expect(q.enabled).toBe(true);
			expect(q.inboxLimit).toBeGreaterThan(0);
			expect(q.monthlySendLimit).toBeGreaterThan(0);
		}
	});

	it("enables email on the teams plan", () => {
		const q = emailQuotaForPlan("teams");
		expect(q.enabled).toBe(true);
		expect(q.inboxLimit).toBeGreaterThan(0);
	});

	it("mirrors the plan catalog numbers exactly (single source of truth)", () => {
		const q = emailQuotaForPlan("pro");
		expect(q.inboxLimit).toBe(PLANS.pro.emailInboxLimit);
		expect(q.monthlySendLimit).toBe(PLANS.pro.emailMonthlySendLimit);
		expect(q.enabled).toBe(PLANS.pro.emailEnabled);
	});
});

describe("resolveEntitlement — subscriptions", () => {
	it("returns the un-entitled baseline for no inputs", () => {
		const e = resolveEntitlement(null, null, defaultsOnly);
		expect(e.plan).toBeNull();
		expect(e.desktopAccess).toBe(false);
		expect(e.managedInference).toBe(false);
		expect(e.monthlyCreditPoolMicroUsd).toBe(0);
		expect(e.seats).toBe(0);
	});

	it("resolves an active Pro subscription with its credit pool", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.pro.bindings.monthly, "pro.monthly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "active" },
			null,
			defaultsOnly
		);
		expect(e.plan).toBe("pro");
		expect(e.desktopAccess).toBe(true);
		expect(e.managedInference).toBe(true);
		expect(e.monthlyCreditPoolMicroUsd).toBe(usdToMicro(20));
		expect(e.seats).toBe(1);
	});

	it("resolves an active Max yearly subscription", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.max.bindings.yearly, "max.yearly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "trialing" },
			null,
			defaultsOnly
		);
		expect(e.plan).toBe("max");
		expect(e.monthlyCreditPoolMicroUsd).toBe(usdToMicro(150));
	});

	it("ignores an inactive (canceled) subscription", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.pro.bindings.monthly, "pro.monthly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "canceled" },
			null,
			defaultsOnly
		);
		expect(e.plan).toBeNull();
	});

	it("ignores an unknown product id", () => {
		const e = resolveEntitlement(
			{ productId: "not-a-real-product", status: "active" },
			null,
			defaultsOnly
		);
		expect(e.plan).toBeNull();
	});
});

describe("resolveEntitlement — Teams per-seat pool", () => {
	const teamsProduct = () =>
		resolveProductId(
			requireBinding(PLANS.teams.bindings.monthly, "teams.monthly"),
			defaultsOnly
		);

	it("multiplies the pool by the seat count", () => {
		const e = resolveEntitlement(
			{ productId: teamsProduct(), status: "active", seats: 5 },
			null,
			defaultsOnly
		);
		expect(e.plan).toBe("teams");
		expect(e.seats).toBe(5);
		expect(e.monthlyCreditPoolMicroUsd).toBe(usdToMicro(24.5) * 5);
	});

	it("enforces the minimum seat count", () => {
		const e = resolveEntitlement(
			{ productId: teamsProduct(), status: "active", seats: 1 },
			null,
			defaultsOnly
		);
		expect(e.seats).toBe(2);
		expect(e.monthlyCreditPoolMicroUsd).toBe(usdToMicro(24.5) * 2);
	});

	it("falls back to quantity then minimum when seats is absent", () => {
		const e = resolveEntitlement(
			{ productId: teamsProduct(), status: "active", quantity: 4 },
			null,
			defaultsOnly
		);
		expect(e.seats).toBe(4);
	});
});

describe("channelUserLimitForEntitlement", () => {
	it("allows one configured channel user on personal subscription plans", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.max.bindings.monthly, "max.monthly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "active" },
			null,
			defaultsOnly
		);
		expect(channelUserLimitForEntitlement(e)).toBe(1);
	});

	it("uses Teams seats as the configured channel-user limit", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.teams.bindings.monthly, "teams.monthly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "active", seats: 7 },
			null,
			defaultsOnly
		);
		expect(channelUserLimitForEntitlement(e)).toBe(7);
	});

	it("does not grant hosted channel users to free or desktop-license entitlements", () => {
		expect(
			channelUserLimitForEntitlement(
				resolveEntitlement(null, null, defaultsOnly)
			)
		).toBe(0);
		expect(
			channelUserLimitForEntitlement(
				resolveEntitlement(null, { active: true }, defaultsOnly)
			)
		).toBe(0);
	});
});

describe("resolveEntitlement — desktop license", () => {
	it("grants desktop access with no managed inference", () => {
		const e = resolveEntitlement(null, { active: true }, defaultsOnly);
		expect(e.plan).toBe("desktop-license");
		expect(e.desktopAccess).toBe(true);
		expect(e.managedInference).toBe(false);
		expect(e.monthlyCreditPoolMicroUsd).toBe(0);
		expect(e.seats).toBe(1);
	});

	it("ignores an inactive license", () => {
		const e = resolveEntitlement(null, { active: false }, defaultsOnly);
		expect(e.plan).toBeNull();
	});

	it("prefers an active subscription over a license", () => {
		const productId = resolveProductId(
			requireBinding(PLANS.max.bindings.monthly, "max.monthly"),
			defaultsOnly
		);
		const e = resolveEntitlement(
			{ productId, status: "active" },
			{ active: true },
			defaultsOnly
		);
		expect(e.plan).toBe("max");
		expect(e.managedInference).toBe(true);
	});
});

describe("resolveProductId — env override", () => {
	it("prefers the env value over the default", () => {
		const read = (k: string): string | undefined =>
			k === "POLAR_PRODUCT_PRO_MONTHLY" ? "env-override-id" : undefined;
		expect(
			resolveProductId(
				requireBinding(PLANS.pro.bindings.monthly, "pro.monthly"),
				read
			)
		).toBe("env-override-id");
	});

	it("falls back to the documented default when env is unset", () => {
		expect(
			resolveProductId(
				requireBinding(PLANS.pro.bindings.monthly, "pro.monthly"),
				defaultsOnly
			)
		).toBe("ecf08edd-a677-4a6e-a618-53918e282298");
	});
});

describe("decideDesktopAccess (trial + paywall gate)", () => {
	const NOW = 1_000_000_000_000;
	const DAY = 24 * 60 * 60 * 1000;

	const sub: Entitlement = {
		plan: "pro",
		desktopAccess: true,
		managedInference: true,
		monthlyCreditPoolMicroUsd: usdToMicro(10),
		seats: 1,
	};
	const licenseEnt: Entitlement = {
		plan: "desktop-license",
		desktopAccess: true,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 1,
	};
	const noneEnt: Entitlement = {
		plan: null,
		desktopAccess: false,
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
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 0,
	};
	const sub: Entitlement = {
		plan: "pro",
		desktopAccess: true,
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

describe("CAPABILITY_TIERS — Band-2 pro capabilities (2026-07-11)", () => {
	it("maps the new local power features to the pro band", () => {
		for (const cap of [
			"fine-tuning",
			"evals",
			"graphrag",
			"companion-overlay",
			"clips",
		] as const) {
			expect(capabilityTier(cap)).toBe("pro");
		}
	});

	it("keeps the existing pro capabilities in the pro band", () => {
		for (const cap of [
			"council",
			"prompt-studio",
			"local-background-runs",
			"gateway-governance-ui",
		] as const) {
			expect(capabilityTier(cap)).toBe("pro");
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

	it("lists every new capability in GATED_CAPABILITIES", () => {
		for (const cap of [
			"fine-tuning",
			"evals",
			"graphrag",
			"companion-overlay",
			"clips",
		] as const) {
			expect(GATED_CAPABILITIES).toContain(cap);
		}
	});
});

describe("planLimit — numeric caps (free baseline vs paid rows)", () => {
	it("returns the free baseline for a null plan", () => {
		expect(planLimit(null, "maxOpenTabs")).toBe(8);
		expect(planLimit(null, "maxAgents")).toBe(10);
		expect(planLimit(null, "maxWorkflows")).toBe(10);
		expect(planLimit(null, "maxSpaces")).toBe(5);
		expect(planLimit(null, "maxMonitors")).toBe(5);
		expect(planLimit(null, "maxMcpServers")).toBe(5);
		expect(planLimit(null, "maxPlugins")).toBe(10);
		expect(planLimit(null, "maxSkills")).toBe(10);
		expect(planLimit(null, "maxSchedules")).toBe(3);
		expect(planLimit(null, "maxConcurrentRuns")).toBe(1);
		expect(planLimit(null, "maxEvalRunsMonthly")).toBe(20);
		expect(planLimit(null, "meetingRetentionDays")).toBe(30);
		expect(planLimit(null, "spaceStorageLimitGb")).toBe(2);
		expect(planLimit(null, "maxRemoteNodes")).toBe(1);
	});

	it("mirrors FREE_TIER_LIMITS exactly for a null plan (single source)", () => {
		for (const field of Object.keys(FREE_TIER_LIMITS) as Array<
			keyof typeof FREE_TIER_LIMITS
		>) {
			expect(planLimit(null, field)).toBe(FREE_TIER_LIMITS[field]);
		}
	});

	it("gives paid rows unbounded symbolic caps", () => {
		for (const plan of ["desktop-license", "pro", "max", "teams"] as const) {
			expect(planLimit(plan, "maxAgents")).toBe(Number.POSITIVE_INFINITY);
			expect(planLimit(plan, "maxWorkflows")).toBe(Number.POSITIVE_INFINITY);
			expect(planLimit(plan, "maxOpenTabs")).toBe(Number.POSITIVE_INFINITY);
			expect(planLimit(plan, "maxRemoteNodes")).toBe(Number.POSITIVE_INFINITY);
		}
	});

	it("keeps the two real-cost levers finite per plan", () => {
		expect(planLimit("desktop-license", "maxConcurrentRuns")).toBe(3);
		expect(planLimit("pro", "maxConcurrentRuns")).toBe(3);
		expect(planLimit("max", "maxConcurrentRuns")).toBe(3);
		expect(planLimit("teams", "maxConcurrentRuns")).toBe(8);

		expect(planLimit("desktop-license", "spaceStorageLimitGb")).toBe(20);
		expect(planLimit("pro", "spaceStorageLimitGb")).toBe(20);
		expect(planLimit("max", "spaceStorageLimitGb")).toBe(50);
		expect(planLimit("teams", "spaceStorageLimitGb")).toBe(50);
	});
});

describe("Lifetime (desktop-license) bands into the pro capability tier", () => {
	const defaults = (): undefined => undefined;

	it("resolves a live desktop license to pro-unlocked, no managed inference", () => {
		const e = resolveEntitlement(null, { active: true }, defaults);
		expect(e.plan).toBe("desktop-license");
		expect(e.desktopAccess).toBe(true);
		expect(e.managedInference).toBe(false);
	});

	it("unlocks pro features (proUnlocked) for a desktop license", () => {
		const NOW = 1_000_000_000_000;
		const DAY = 24 * 60 * 60 * 1000;
		const licenseEnt: Entitlement = {
			plan: "desktop-license",
			desktopAccess: true,
			managedInference: false,
			monthlyCreditPoolMicroUsd: 0,
			seats: 1,
		};
		const v = decideDesktopAccess({
			firstLaunchMs: NOW - 30 * DAY, // trial long over
			liveEntitlement: licenseEnt,
			licenseActive: false,
			cached: null,
			nowMs: NOW,
		});
		// Band 2 (pro) unlocks; Band 3 (managed inference) stays off.
		expect(v.proUnlocked).toBe(true);
		expect(v.managedInference).toBe(false);
	});
});

describe("managedInferenceAvailable — balance gate, not a pure tier gate", () => {
	const license: Entitlement = {
		plan: "desktop-license",
		desktopAccess: true,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 1,
	};
	const proSub: Entitlement = {
		plan: "pro",
		desktopAccess: true,
		managedInference: true,
		monthlyCreditPoolMicroUsd: usdToMicro(19.5),
		seats: 1,
	};
	const none: Entitlement = {
		plan: null,
		desktopAccess: false,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 0,
	};

	it("lets a Lifetime license spend once it has a PAYG balance (no included pool)", () => {
		expect(managedInferenceAvailable(license, 0)).toBe(false);
		expect(managedInferenceAvailable(license, usdToMicro(5))).toBe(true);
	});

	it("lets a subscription with an included pool spend at zero balance", () => {
		expect(managedInferenceAvailable(proSub, 0)).toBe(true);
	});

	it("never lets the free (no-access) baseline spend, even with a balance", () => {
		expect(managedInferenceAvailable(none, usdToMicro(100))).toBe(false);
	});
});

describe("resolveInboxLifecycle — subscription-lapse policy", () => {
	const DAY = 24 * 60 * 60 * 1000;
	const NOW = 1_800_000_000_000;

	it("is active with cleared anchors while the owner is entitled", () => {
		const v = resolveInboxLifecycle({
			emailEntitled: true,
			lapsedAtMs: NOW - 10 * DAY,
			deactivatedAtMs: NOW - 5 * DAY,
			nowMs: NOW,
		});
		expect(v.state).toBe("active");
		expect(v.lapsedAtMs).toBeNull();
		expect(v.deactivatedAtMs).toBeNull();
		expect(v.acceptsInbound).toBe(true);
		expect(v.agentReadOnly).toBe(false);
		expect(v.eligibleForDeletionAtMs).toBeNull();
	});

	it("enters grace at first observation of a lapse (anchors now)", () => {
		const v = resolveInboxLifecycle({
			emailEntitled: false,
			lapsedAtMs: null,
			deactivatedAtMs: null,
			nowMs: NOW,
		});
		expect(v.state).toBe("grace");
		expect(v.lapsedAtMs).toBe(NOW);
		expect(v.acceptsInbound).toBe(true); // inbound still stored in grace
		expect(v.agentReadOnly).toBe(true); // agent access paused
	});

	it("stays in grace until graceDays elapse, still accepting inbound", () => {
		const lapsedAtMs = NOW - (MAIL_LIFECYCLE.graceDays - 1) * DAY;
		const v = resolveInboxLifecycle({
			emailEntitled: false,
			lapsedAtMs,
			deactivatedAtMs: null,
			nowMs: NOW,
		});
		expect(v.state).toBe("grace");
		expect(v.lapsedAtMs).toBe(lapsedAtMs);
		expect(v.acceptsInbound).toBe(true);
		expect(v.deactivatedAtMs).toBeNull();
	});

	it("deactivates once grace expires: inbound rejected, mail retained", () => {
		const lapsedAtMs = NOW - (MAIL_LIFECYCLE.graceDays + 1) * DAY;
		const v = resolveInboxLifecycle({
			emailEntitled: false,
			lapsedAtMs,
			deactivatedAtMs: null,
			nowMs: NOW,
		});
		expect(v.state).toBe("deactivated");
		expect(v.acceptsInbound).toBe(false);
		expect(v.agentReadOnly).toBe(true);
		// Deactivation anchors at grace end; deletion eligible retentionDays later.
		const graceEnd = lapsedAtMs + MAIL_LIFECYCLE.graceDays * DAY;
		expect(v.deactivatedAtMs).toBe(graceEnd);
		expect(v.eligibleForDeletionAtMs).toBe(
			graceEnd + MAIL_LIFECYCLE.retentionDays * DAY
		);
	});

	it("keeps a stored deactivation anchor stable (retention window doesn't slide)", () => {
		const deactivatedAtMs = NOW - 10 * DAY;
		const v = resolveInboxLifecycle({
			emailEntitled: false,
			lapsedAtMs: NOW - (MAIL_LIFECYCLE.graceDays + 20) * DAY,
			deactivatedAtMs,
			nowMs: NOW,
		});
		expect(v.state).toBe("deactivated");
		expect(v.deactivatedAtMs).toBe(deactivatedAtMs);
		expect(v.eligibleForDeletionAtMs).toBe(
			deactivatedAtMs + MAIL_LIFECYCLE.retentionDays * DAY
		);
	});

	it("restores to active on re-upgrade within retention (anchors cleared)", () => {
		const v = resolveInboxLifecycle({
			emailEntitled: true, // owner re-subscribed
			lapsedAtMs: NOW - (MAIL_LIFECYCLE.graceDays + 5) * DAY,
			deactivatedAtMs: NOW - 5 * DAY,
			nowMs: NOW,
		});
		expect(v.state).toBe("active");
		expect(v.lapsedAtMs).toBeNull();
		expect(v.deactivatedAtMs).toBeNull();
		expect(v.acceptsInbound).toBe(true);
		expect(v.agentReadOnly).toBe(false);
	});
});
