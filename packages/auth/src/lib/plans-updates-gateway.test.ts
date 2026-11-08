import { describe, expect, it } from "bun:test";
import {
	canRemovePoweredByRyu,
	decideUpdateEligibility,
	type Entitlement,
	gatewayRateCeilingForEntitlement,
	PLAN_IDS,
	PLANS,
	UPDATES_WINDOW,
	updatesCutoffMs,
	updatesWindowApplies,
	updatesWindowEndMs,
} from "./plans.ts";

describe("updatesWindowEndMs — the lifetime updates window", () => {
	const FIRST_BUY = Date.UTC(2026, 0, 1);
	const MID_WINDOW_BUY = Date.UTC(2026, 6, 1);

	it("returns null when there are no orders", () => {
		expect(updatesWindowEndMs([])).toBeNull();
	});

	it("adds one calendar year to a single purchase", () => {
		expect(updatesWindowEndMs([FIRST_BUY])).toBe(Date.UTC(2027, 0, 1));
	});

	it("stacks a second purchase made while the window is still open", () => {
		// Six months left + a re-buy = eighteen months, not a re-anchored twelve.
		expect(updatesWindowEndMs([FIRST_BUY, MID_WINDOW_BUY])).toBe(
			Date.UTC(2028, 0, 1)
		);
	});

	it("anchors to the purchase when the previous window already lapsed", () => {
		expect(updatesWindowEndMs([Date.UTC(2024, 0, 1), MID_WINDOW_BUY])).toBe(
			Date.UTC(2027, 6, 1)
		);
	});

	it("adds approved bonus years on top of the stacked window", () => {
		expect(updatesWindowEndMs([FIRST_BUY, MID_WINDOW_BUY], 2)).toBe(
			Date.UTC(2030, 0, 1)
		);
	});

	it("ignores a negative bonus-year count", () => {
		expect(updatesWindowEndMs([FIRST_BUY], -5)).toBe(Date.UTC(2027, 0, 1));
	});

	it("ignores a non-finite bonus-year count rather than minting a NaN date", () => {
		// A NaN here would become `new Date(NaN).toISOString()` upstream, which
		// THROWS — so the guard degrades to "no bonus", never to a broken window.
		expect(updatesWindowEndMs([FIRST_BUY], Number.NaN)).toBe(
			Date.UTC(2027, 0, 1)
		);
	});

	it("rolls a 29 February purchase forward to 1 March", () => {
		expect(updatesWindowEndMs([Date.UTC(2028, 1, 29)])).toBe(
			Date.UTC(2029, 2, 1)
		);
	});

	it("ignores non-finite order times", () => {
		expect(updatesWindowEndMs([Number.NaN, FIRST_BUY])).toBe(
			Date.UTC(2027, 0, 1)
		);
		expect(updatesWindowEndMs([Number.NaN])).toBeNull();
	});

	it("honours a swapped config rather than a hardcoded year", () => {
		expect(
			updatesWindowEndMs([FIRST_BUY], 0, {
				...UPDATES_WINDOW,
				yearsPerPurchase: 2,
			})
		).toBe(Date.UTC(2028, 0, 1));
	});
});

describe("updatesCutoffMs + updatesWindowApplies", () => {
	const WINDOW_END = Date.UTC(2027, 0, 1);

	it("adds the skew grace exactly once", () => {
		expect(updatesCutoffMs(WINDOW_END)).toBe(
			WINDOW_END + UPDATES_WINDOW.skewGraceMs
		);
		expect(
			updatesCutoffMs(WINDOW_END, { ...UPDATES_WINDOW, skewGraceMs: 0 })
		).toBe(WINDOW_END);
	});

	it("applies the window to a desktop-license holder", () => {
		expect(updatesWindowApplies("desktop-license")).toBe(true);
	});

	it("does not apply the window to a subscriber or to no plan", () => {
		// A lifetime owner who later subscribes resolves to the SUBSCRIPTION plan,
		// and an actively-paying user must never be pinned to old builds.
		for (const plan of ["pro", "max", "teams", null] as const) {
			expect(updatesWindowApplies(plan)).toBe(false);
		}
	});
});

describe("decideUpdateEligibility — which builds a lifetime owner may install", () => {
	const DAY = 24 * 60 * 60 * 1000;
	const WINDOW_END = Date.UTC(2027, 0, 1);
	const CUTOFF = updatesCutoffMs(WINDOW_END);
	const base = {
		cutoffMs: CUTOFF,
		nowMs: WINDOW_END - DAY,
		releasePublishedAtMs: WINDOW_END - DAY,
	};

	it("is unrestricted when no window applies", () => {
		const v = decideUpdateEligibility({ ...base, cutoffMs: null });
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("no-window");
		expect(v.windowLapsed).toBe(false);
	});

	it("allows a release published inside the window", () => {
		const v = decideUpdateEligibility(base);
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("within-window");
		expect(v.windowLapsed).toBe(false);
	});

	it("allows a release published after the window when the date is unknown", () => {
		const v = decideUpdateEligibility({
			...base,
			nowMs: CUTOFF + DAY,
			releasePublishedAtMs: null,
		});
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("unknown-release-date");
		expect(v.windowLapsed).toBe(true);
	});

	it("withholds a release published after the cutoff", () => {
		const v = decideUpdateEligibility({
			...base,
			nowMs: CUTOFF + 10 * DAY,
			releasePublishedAtMs: CUTOFF + DAY,
		});
		expect(v.eligible).toBe(false);
		expect(v.reason).toBe("outside-window");
		expect(v.windowLapsed).toBe(true);
	});

	it("allows a release published exactly at the cutoff", () => {
		const v = decideUpdateEligibility({
			...base,
			releasePublishedAtMs: CUTOFF,
		});
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("within-window");
	});

	it("reports windowLapsed without withholding a release from inside the window", () => {
		// The case that must keep working: a lapsed owner still receives EVERY
		// build their window covers — the lapse only drives the renew prompt.
		const v = decideUpdateEligibility({ ...base, nowMs: CUTOFF + 10 * DAY });
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("within-window");
		expect(v.windowLapsed).toBe(true);
	});

	it("fails open on a NaN publish timestamp", () => {
		const v = decideUpdateEligibility({
			...base,
			releasePublishedAtMs: Number.NaN,
		});
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("unknown-release-date");
	});

	it("fails open on a NaN cutoff", () => {
		const v = decideUpdateEligibility({ ...base, cutoffMs: Number.NaN });
		expect(v.eligible).toBe(true);
		expect(v.reason).toBe("no-window");
		expect(v.windowLapsed).toBe(false);
	});
});

describe("gatewayRateCeilingForEntitlement", () => {
	const managed = (plan: Entitlement["plan"], seats = 1): Entitlement => ({
		desktopAccess: true,
		managedInference: true,
		marketplaceApps: false,
		monthlyCreditPoolMicroUsd: 0,
		plan,
		seats,
	});

	it("gives free, promo, and unreadable entitlements the lowest ceiling", () => {
		const unmanaged = gatewayRateCeilingForEntitlement(null);
		expect(
			gatewayRateCeilingForEntitlement({
				...managed(null),
				managedInference: false,
			})
		).toEqual(unmanaged);
		expect(
			gatewayRateCeilingForEntitlement(managed("max")).rpm
		).toBeGreaterThan(unmanaged.rpm);
	});

	it("scales organization plans by seats and keeps personal plans flat", () => {
		const teamsOne = gatewayRateCeilingForEntitlement(managed("teams", 1));
		const teamsTen = gatewayRateCeilingForEntitlement(managed("teams", 10));
		expect(teamsTen.rpm).toBe(teamsOne.rpm * 10);
		expect(gatewayRateCeilingForEntitlement(managed("pro", 10))).toEqual(
			gatewayRateCeilingForEntitlement(managed("pro", 1))
		);
	});
});

describe("canRemovePoweredByRyu", () => {
	it("keeps the badge for free, trial and one-time plans", () => {
		expect(canRemovePoweredByRyu(null)).toBe(false);
		expect(canRemovePoweredByRyu("desktop-license")).toBe(false);
		expect(canRemovePoweredByRyu("marketplace-membership")).toBe(false);
		expect(canRemovePoweredByRyu("pro")).toBe(true);
	});

	// Core decides the badge for app sidecars from the `managed-inference-entitled`
	// flag the desktop already pushes (`apps/core/src/entitlement.rs`). That is
	// only sound while the two capabilities cover the same plans; a plan that
	// splits them must give Core its own branding signal first.
	it("branding removal tracks managed inference", () => {
		for (const id of PLAN_IDS) {
			expect({ id, removable: canRemovePoweredByRyu(id) }).toEqual({
				id,
				removable: PLANS[id].managedInference,
			});
		}
	});
});
