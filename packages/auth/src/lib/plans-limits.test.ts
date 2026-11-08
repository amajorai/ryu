import { describe, expect, it } from "bun:test";
import {
	decideDesktopAccess,
	type Entitlement,
	FREE_TIER_LIMITS,
	KERNEL_QUOTAS,
	MAIL_LIFECYCLE,
	managedInferenceAvailable,
	PLAN_IDS,
	type PlanLimitField,
	planLimit,
	QUOTAS,
	quotaOwner,
	resolveEntitlement,
	resolveInboxLifecycle,
	usdToMicro,
} from "./plans.ts";

describe("planLimit — numeric caps (free baseline vs paid rows)", () => {
	it("returns the free baseline for a null plan", () => {
		expect(planLimit(null, "maxOpenTabs")).toBe(3);
		expect(planLimit(null, "maxAgents")).toBe(Number.POSITIVE_INFINITY);
		expect(planLimit(null, "maxSpaces")).toBe(Number.POSITIVE_INFINITY);
		expect(planLimit(null, "maxConcurrentRuns")).toBe(Number.POSITIVE_INFINITY);
		expect(planLimit(null, "maxEvalRunsMonthly")).toBe(
			Number.POSITIVE_INFINITY
		);
		expect(planLimit(null, "spaceStorageLimitGb")).toBe(1);
		expect(planLimit(null, "maxRemoteNodes")).toBe(1);
	});

	it("mirrors FREE_TIER_LIMITS exactly for a null plan (single source)", () => {
		for (const field of Object.keys(FREE_TIER_LIMITS).filter(
			(key): key is PlanLimitField => Object.hasOwn(QUOTAS, key)
		)) {
			expect(planLimit(null, field)).toBe(FREE_TIER_LIMITS[field]);
		}
	});

	it("gives paid rows unbounded symbolic caps", () => {
		for (const plan of [
			"desktop-license",
			"pro",
			"plus",
			"max",
			"teams",
			"teams-lite",
			"business",
		] as const) {
			expect(planLimit(plan, "maxAgents")).toBe(Number.POSITIVE_INFINITY);
			expect(planLimit(plan, "maxOpenTabs")).toBe(Number.POSITIVE_INFINITY);
			expect(planLimit(plan, "maxRemoteNodes")).toBe(Number.POSITIVE_INFINITY);
		}
	});

	it("keeps hosted storage finite per plan", () => {
		expect(planLimit("desktop-license", "spaceStorageLimitGb")).toBe(20);
		expect(planLimit("pro", "spaceStorageLimitGb")).toBe(10);
		expect(planLimit("plus", "spaceStorageLimitGb")).toBe(10);
		expect(planLimit("max", "spaceStorageLimitGb")).toBe(50);
		expect(planLimit("teams", "spaceStorageLimitGb")).toBe(50);
		expect(planLimit("teams-lite", "spaceStorageLimitGb")).toBe(50);
		expect(planLimit("business", "spaceStorageLimitGb")).toBe(50);
		// A Major Pass adds no hosted storage: it keeps the free baseline rather
		// than falling through to an unbounded default.
		expect(planLimit("marketplace-membership", "spaceStorageLimitGb")).toBe(
			planLimit(null, "spaceStorageLimitGb")
		);
		for (const plan of PLAN_IDS) {
			expect(Number.isFinite(planLimit(plan, "spaceStorageLimitGb"))).toBe(
				true
			);
		}
	});

	/**
	 * The whole tier × key matrix, written out. The registry derives every paid
	 * row from {@link QuotaSpec.paid} defaulting to unbounded, so a mistyped
	 * `paid` map is a REPRICING that no per-key assertion above would catch — this
	 * is the guard that moving a key between registries never moves a number.
	 */
	it("pins every tier × quota number", () => {
		const INF = Number.POSITIVE_INFINITY;
		const matrix = {
			maxAgents: [INF, INF, INF, INF, INF, INF, INF, INF],
			maxConcurrentRuns: [INF, INF, INF, INF, INF, INF, INF, INF],
			maxEvalRunsMonthly: [INF, INF, INF, INF, INF, INF, INF, INF],
			maxOpenTabs: [3, INF, INF, INF, INF, INF, INF, INF],
			maxRemoteNodes: [1, INF, INF, INF, INF, INF, INF, INF],
			maxSpaces: [INF, INF, INF, INF, INF, INF, INF, INF],
			spaceStorageLimitGb: [1, 20, 10, 10, 50, 50, 50, 50],
		} satisfies Record<
			PlanLimitField,
			[
				free: number,
				license: number,
				pro: number,
				plus: number,
				max: number,
				teams: number,
				teamsLite: number,
				business: number,
			]
		>;
		// Every declared key is in the matrix, and vice versa: a new quota that
		// forgot its numbers fails here rather than shipping a silent Infinity.
		expect(Object.keys(matrix).sort()).toEqual(Object.keys(QUOTAS).sort());
		for (const [
			field,
			[free, license, pro, plus, max, teams, teamsLite, business],
		] of Object.entries(matrix)) {
			const quotaField = Object.keys(QUOTAS).find(
				(key): key is PlanLimitField => key === field
			);
			if (!quotaField) {
				throw new Error("Missing quota fixture");
			}
			expect(planLimit(null, quotaField)).toBe(free);
			expect(planLimit("desktop-license", quotaField)).toBe(license);
			expect(planLimit("pro", quotaField)).toBe(pro);
			expect(planLimit("plus", quotaField)).toBe(plus);
			expect(planLimit("max", quotaField)).toBe(max);
			expect(planLimit("teams", quotaField)).toBe(teams);
			expect(planLimit("teams-lite", quotaField)).toBe(teamsLite);
			expect(planLimit("business", quotaField)).toBe(business);
		}
	});
});

describe("quota ownership — Core-owned limits", () => {
	it("leaves shell and Core-subsystem quotas unowned", () => {
		for (const field of [
			"maxOpenTabs",
			"maxRemoteNodes",
			"maxSpaces",
			"maxAgents",
			"maxConcurrentRuns",
			"maxEvalRunsMonthly",
			"spaceStorageLimitGb",
		] as const) {
			expect(quotaOwner(field)).toBeNull();
			expect(KERNEL_QUOTAS).toHaveProperty(field);
		}
	});

	it("does not expose Marketplace app/plugin quota keys", () => {
		for (const field of [
			"maxMcpServers",
			"maxMonitors",
			"maxPlugins",
			"maxSchedules",
			"maxSkills",
			"maxWorkflows",
			"meetingRetentionDays",
		] as const) {
			expect(QUOTAS).not.toHaveProperty(field);
		}
	});

	it("carries a label and a unit on every key, so surfaces need no table", () => {
		for (const spec of Object.values(QUOTAS)) {
			expect(spec.label.trim().length).toBeGreaterThan(0);
			expect(["count", "days", "gigabytes"]).toContain(spec.unit);
		}
		expect(QUOTAS.spaceStorageLimitGb.unit).toBe("gigabytes");
	});

	it("keeps every remaining quota Core-owned", () => {
		for (const field of Object.keys(QUOTAS).filter(
			(key): key is PlanLimitField => Object.hasOwn(QUOTAS, key)
		)) {
			expect(quotaOwner(field)).toBeNull();
		}
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
			marketplaceApps: false,
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
		marketplaceApps: false,
		managedInference: false,
		monthlyCreditPoolMicroUsd: 0,
		seats: 1,
	};
	const proSub: Entitlement = {
		plan: "pro",
		desktopAccess: true,
		marketplaceApps: true,
		managedInference: true,
		monthlyCreditPoolMicroUsd: usdToMicro(19.5),
		seats: 1,
	};
	const none: Entitlement = {
		plan: null,
		desktopAccess: false,
		marketplaceApps: false,
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

	it("opens standalone PAYG only when the wallet has prepaid balance", () => {
		expect(managedInferenceAvailable(none, 0)).toBe(false);
		expect(managedInferenceAvailable(none, -1)).toBe(false);
		expect(managedInferenceAvailable(none, usdToMicro(5))).toBe(true);
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
