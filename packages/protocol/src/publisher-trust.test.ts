import { describe, expect, test } from "bun:test";
import {
	publisherTrustFromOrgFlag,
	publisherTrustLabel,
	publisherTrustTooltip,
	resolvePublisherTrust,
} from "./publisher-trust.ts";

const FULL_GOLD = {
	domainVerified: true,
	goldEligiblePlan: true,
	ryuStaffVerified: true,
	stripeIdentityVerified: true,
} as const;

describe("resolvePublisherTrust", () => {
	test("Business + Stripe + domain + admin approval produces gold", () => {
		expect(resolvePublisherTrust(FULL_GOLD)).toEqual({
			level: "gold",
			source: "ryu_staff",
			verified: true,
		});
	});

	test("first-party listings are gold without any other signal", () => {
		expect(resolvePublisherTrust({ firstParty: true }).level).toBe("gold");
	});

	test("gold drops to blue when any gold prerequisite is missing", () => {
		for (const missing of [
			"domainVerified",
			"goldEligiblePlan",
			"ryuStaffVerified",
			"stripeIdentityVerified",
		] as const) {
			const level = resolvePublisherTrust({
				...FULL_GOLD,
				paidPlan: true,
				[missing]: false,
			}).level;
			expect(level).toBe("blue");
		}
	});

	test("a paid plan needs Stripe identity or a verified domain for blue", () => {
		expect(
			resolvePublisherTrust({ paidPlan: true, stripeIdentityVerified: true })
		).toEqual({ level: "blue", source: "paid_plan", verified: true });
		expect(
			resolvePublisherTrust({ domainVerified: true, paidPlan: true }).level
		).toBe("blue");
		expect(resolvePublisherTrust({ paidPlan: true }).level).toBe("dotted");
	});

	test("identity without a paid plan earns nothing", () => {
		expect(
			resolvePublisherTrust({
				domainVerified: true,
				ryuStaffVerified: true,
				stripeIdentityVerified: true,
			}).level
		).toBe("dotted");
	});

	test("no signals stay dotted", () => {
		expect(resolvePublisherTrust({})).toEqual({
			level: "dotted",
			source: "none",
			verified: false,
		});
	});
});

describe("publisherTrustFromOrgFlag", () => {
	test("maps the legacy server flag straight to gold or dotted", () => {
		expect(publisherTrustFromOrgFlag({ orgVerified: true }).level).toBe("gold");
		expect(publisherTrustFromOrgFlag({ firstParty: true }).level).toBe("gold");
		expect(publisherTrustFromOrgFlag({}).level).toBe("dotted");
	});
});

describe("publisher trust copy", () => {
	test("does not collapse the marks into a generic verified label", () => {
		expect(publisherTrustLabel("gold")).toBe("Verified business");
		expect(publisherTrustLabel("blue")).toBe("Verified paid organization");
		expect(publisherTrustLabel("dotted")).toBe("Unverified publisher");
		expect(publisherTrustTooltip("blue")).toContain("Stripe or a domain");
		expect(publisherTrustTooltip("dotted")).toContain(
			"not a verified publisher"
		);
	});
});
