import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	adminEmails,
	generateReferralCode,
	invitesPerWeek,
	isAdminEmail,
	isWaitlistBypassed,
	isWaitlisted,
	referralUrlFor,
	waitlistEtaLabel,
	webOrigin,
} from "./waitlist.ts";

const ENV_KEYS = [
	"ADMIN_EMAILS",
	"FRONTEND_URL",
	"WAITLIST_INVITES_PER_WEEK",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = saved[key];
		}
	}
});

describe("adminEmails / isAdminEmail", () => {
	it("parses a comma-separated allowlist, trimmed and lower-cased", () => {
		process.env.ADMIN_EMAILS = " Alice@Example.com , BOB@x.io ";
		const set = adminEmails();
		expect(set.has("alice@example.com")).toBe(true);
		expect(set.has("bob@x.io")).toBe(true);
		expect(set.size).toBe(2);
	});

	it("returns an empty set for an unset or blank var", () => {
		expect(adminEmails().size).toBe(0);
		process.env.ADMIN_EMAILS = " , , ";
		expect(adminEmails().size).toBe(0);
	});

	it("isAdminEmail is case-insensitive and null-safe", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		expect(isAdminEmail("ADMIN@ryu.dev")).toBe(true);
		expect(isAdminEmail("nope@ryu.dev")).toBe(false);
		expect(isAdminEmail(null)).toBe(false);
		expect(isAdminEmail(undefined)).toBe(false);
		expect(isAdminEmail("")).toBe(false);
	});
});

describe("isWaitlistBypassed", () => {
	it("is bypassed when no admins are configured", () => {
		expect(isWaitlistBypassed()).toBe(true);
	});

	it("is not bypassed once an admin allowlist exists", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		expect(isWaitlistBypassed()).toBe(false);
	});
});

describe("isWaitlisted", () => {
	it("is true for a waitlist-role, non-admin user when the queue is active", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		expect(isWaitlisted({ role: "waitlist", email: "user@x.io" })).toBe(true);
	});

	it("is false for an approved role", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		expect(isWaitlisted({ role: "user", email: "user@x.io" })).toBe(false);
	});

	it("is false for an admin email even with the waitlist role", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		expect(isWaitlisted({ role: "waitlist", email: "admin@ryu.dev" })).toBe(
			false
		);
	});

	it("is false when the waitlist is bypassed (no admins configured)", () => {
		expect(isWaitlisted({ role: "waitlist", email: "user@x.io" })).toBe(false);
	});
});

describe("generateReferralCode", () => {
	it("produces an 8-char code from the confusion-free alphabet", () => {
		const allowed = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
		for (let i = 0; i < 100; i++) {
			expect(generateReferralCode()).toMatch(allowed);
		}
	});

	it("excludes easily-confused characters (0, 1, I, O)", () => {
		const joined = Array.from({ length: 200 }, () =>
			generateReferralCode()
		).join("");
		expect(joined).not.toMatch(/[01IO]/);
	});
});

describe("webOrigin / referralUrlFor", () => {
	it("defaults to localhost:3001 in dev", () => {
		expect(webOrigin()).toBe("http://localhost:3001");
	});

	it("strips a trailing slash from FRONTEND_URL", () => {
		process.env.FRONTEND_URL = "https://ryuhq.com/";
		expect(webOrigin()).toBe("https://ryuhq.com");
	});

	it("builds a sign-up referral link with the code", () => {
		process.env.FRONTEND_URL = "https://ryuhq.com";
		expect(referralUrlFor("ABCD2345")).toBe(
			"https://ryuhq.com/login?view=signup&ref=ABCD2345"
		);
	});
});

describe("invitesPerWeek", () => {
	it("defaults to 50 when unset", () => {
		expect(invitesPerWeek()).toBe(50);
	});

	it("uses a positive integer from env", () => {
		process.env.WAITLIST_INVITES_PER_WEEK = "120";
		expect(invitesPerWeek()).toBe(120);
	});

	it("falls back to the default for zero, negative, or garbage", () => {
		process.env.WAITLIST_INVITES_PER_WEEK = "0";
		expect(invitesPerWeek()).toBe(50);
		process.env.WAITLIST_INVITES_PER_WEEK = "-5";
		expect(invitesPerWeek()).toBe(50);
		process.env.WAITLIST_INVITES_PER_WEEK = "abc";
		expect(invitesPerWeek()).toBe(50);
	});
});

describe("waitlistEtaLabel", () => {
	it("returns null for a missing or non-positive position", () => {
		expect(waitlistEtaLabel(null)).toBeNull();
		expect(waitlistEtaLabel(undefined)).toBeNull();
		expect(waitlistEtaLabel(0)).toBeNull();
		expect(waitlistEtaLabel(-10)).toBeNull();
	});

	it("says 'less than a week' within one week of throughput", () => {
		expect(waitlistEtaLabel(1)).toBe("less than a week");
		expect(waitlistEtaLabel(50)).toBe("less than a week"); // ceil(50/50) = 1
	});

	it("phrases short waits in weeks", () => {
		expect(waitlistEtaLabel(51)).toBe("~2 weeks"); // ceil(51/50) = 2
		expect(waitlistEtaLabel(150)).toBe("~3 weeks");
	});

	it("switches to months past the threshold", () => {
		// 450 -> ceil(450/50) = 9 weeks -> round(9 / 4.345) = 2 months
		expect(waitlistEtaLabel(450)).toBe("~2 months");
	});

	it("respects a custom throughput from env", () => {
		process.env.WAITLIST_INVITES_PER_WEEK = "10";
		// 25 -> ceil(25/10) = 3 weeks
		expect(waitlistEtaLabel(25)).toBe("~3 weeks");
	});
});
