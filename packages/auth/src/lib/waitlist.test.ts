import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	adminEmails,
	DEFAULT_INVITES_PER_WEEK,
	generateReferralCode,
	invitesPerWeek,
	isAdmin,
	isAdminEmail,
	isVerifiedAdminEmail,
	isWaitlistBypassed,
	isWaitlisted,
	observedInvitesPerWeek,
	reconciledAdminRole,
	referralUrlFor,
	waitlistEnabledOverride,
	waitlistEtaLabel,
	webOrigin,
} from "./waitlist.ts";

const ENV_KEYS = ["ADMIN_EMAILS", "FRONTEND_URL", "WAITLIST_ENABLED"] as const;

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

describe("isAdmin", () => {
	it("recognizes a Better Auth admin role without an email allowlist", () => {
		expect(isAdmin({ email: "role-only@example.com", role: "admin" })).toBe(
			true
		);
	});

	it("rejects a normal Better Auth user without an email allowlist", () => {
		expect(isAdmin({ email: "user@example.com", role: "user" })).toBe(false);
	});

	it("keeps a verified configured admin email as the bootstrap authority", () => {
		process.env.ADMIN_EMAILS = "bootstrap@example.com";
		expect(
			isAdmin({
				email: "bootstrap@example.com",
				emailVerified: true,
				role: "user",
			})
		).toBe(true);
	});

	it("does not honour the allowlist for an unverified or unknown-verification address", () => {
		process.env.ADMIN_EMAILS = "bootstrap@example.com";
		expect(
			isAdmin({
				email: "bootstrap@example.com",
				emailVerified: false,
				role: "user",
			})
		).toBe(false);
		expect(isAdmin({ email: "bootstrap@example.com", role: "user" })).toBe(
			false
		);
	});
});

describe("isVerifiedAdminEmail", () => {
	it("requires both the allowlist and emailVerified === true", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		expect(
			isVerifiedAdminEmail({ email: "ADMIN@ryu.dev", emailVerified: true })
		).toBe(true);
		expect(
			isVerifiedAdminEmail({ email: "admin@ryu.dev", emailVerified: false })
		).toBe(false);
		expect(
			isVerifiedAdminEmail({ email: "admin@ryu.dev", emailVerified: null })
		).toBe(false);
		expect(isVerifiedAdminEmail({ email: "admin@ryu.dev" })).toBe(false);
		expect(
			isVerifiedAdminEmail({ email: "other@ryu.dev", emailVerified: true })
		).toBe(false);
	});
});

describe("reconciledAdminRole", () => {
	it("promotes a verified allowlisted address and leaves an unverified one", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		expect(
			reconciledAdminRole({
				email: "admin@ryu.dev",
				emailVerified: true,
				role: "waitlist",
			})
		).toBe("admin");
		expect(
			reconciledAdminRole({
				email: "admin@ryu.dev",
				emailVerified: false,
				role: "waitlist",
			})
		).toBeNull();
	});

	it("demotes an admin role an unverified allowlisted address carries", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		expect(
			reconciledAdminRole({
				email: "admin@ryu.dev",
				emailVerified: false,
				role: "admin",
			})
		).toBe("waitlist");
		process.env.WAITLIST_ENABLED = "false";
		expect(reconciledAdminRole({ email: "admin@ryu.dev", role: "admin" })).toBe(
			"user"
		);
	});

	it("never touches a verified admin or an unlisted admin-plugin grant", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		expect(
			reconciledAdminRole({
				email: "admin@ryu.dev",
				emailVerified: true,
				role: "admin",
			})
		).toBeNull();
		expect(
			reconciledAdminRole({
				email: "moderator@ryu.dev",
				emailVerified: false,
				role: "admin",
			})
		).toBeNull();
		expect(reconciledAdminRole({ email: null, role: "admin" })).toBeNull();
	});
});

describe("waitlistEnabledOverride", () => {
	it("is null when unset, blank, or unparseable", () => {
		expect(waitlistEnabledOverride()).toBeNull();
		process.env.WAITLIST_ENABLED = "  ";
		expect(waitlistEnabledOverride()).toBeNull();
		process.env.WAITLIST_ENABLED = "maybe";
		expect(waitlistEnabledOverride()).toBeNull();
	});

	it("accepts the truthy spellings, case- and space-insensitively", () => {
		for (const raw of ["1", "true", "TRUE", " on ", "yes", "Enabled"]) {
			process.env.WAITLIST_ENABLED = raw;
			expect(waitlistEnabledOverride()).toBe(true);
		}
	});

	it("accepts the falsy spellings", () => {
		for (const raw of ["0", "false", "OFF", "no", " disabled "]) {
			process.env.WAITLIST_ENABLED = raw;
			expect(waitlistEnabledOverride()).toBe(false);
		}
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

	it("WAITLIST_ENABLED=true forces the queue on with no admins configured", () => {
		process.env.WAITLIST_ENABLED = "true";
		expect(isWaitlistBypassed()).toBe(false);
		expect(isWaitlisted({ role: "waitlist", email: "user@x.io" })).toBe(true);
	});

	it("WAITLIST_ENABLED=false forces the queue off even with admins configured", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		process.env.WAITLIST_ENABLED = "false";
		expect(isWaitlistBypassed()).toBe(true);
		expect(isWaitlisted({ role: "waitlist", email: "user@x.io" })).toBe(false);
	});

	it("falls back to the ADMIN_EMAILS-derived state when the override is unparseable", () => {
		process.env.WAITLIST_ENABLED = "sometimes";
		expect(isWaitlistBypassed()).toBe(true);
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

	it("is false for a verified admin email even with the waitlist role", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		expect(
			isWaitlisted({
				role: "waitlist",
				email: "admin@ryu.dev",
				emailVerified: true,
			})
		).toBe(false);
	});

	it("keeps an unverified allowlisted address on the waitlist", () => {
		process.env.ADMIN_EMAILS = "admin@ryu.dev";
		expect(
			isWaitlisted({
				role: "waitlist",
				email: "admin@ryu.dev",
				emailVerified: false,
			})
		).toBe(true);
		expect(isWaitlisted({ role: "waitlist", email: "admin@ryu.dev" })).toBe(
			true
		);
	});

	it("is false when the waitlist is bypassed (no admins configured)", () => {
		expect(isWaitlisted({ role: "waitlist", email: "user@x.io" })).toBe(false);
	});

	it("keeps an anonymous session gated while guest mode is disabled", () => {
		expect(isWaitlisted({ isAnonymous: true })).toBe(true);
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

	it("builds a short referral link with the code", () => {
		process.env.FRONTEND_URL = "https://ryuhq.com";
		expect(referralUrlFor("ABCD2345")).toBe("https://ryuhq.com/r/ABCD2345");
	});
});

describe("invitesPerWeek", () => {
	it("is the typed 50-per-week constant", () => {
		expect(DEFAULT_INVITES_PER_WEEK).toBe(50);
		expect(invitesPerWeek()).toBe(DEFAULT_INVITES_PER_WEEK);
	});

	it("is not read from the environment", () => {
		process.env.WAITLIST_INVITES_PER_WEEK = "120";
		try {
			expect(invitesPerWeek()).toBe(50);
		} finally {
			delete process.env.WAITLIST_INVITES_PER_WEEK;
		}
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

	it("respects a caller-supplied throughput", () => {
		// 25 -> ceil(25/10) = 3 weeks
		expect(waitlistEtaLabel(25, 10)).toBe("~3 weeks");
	});
});

describe("observedInvitesPerWeek", () => {
	// Below the sample threshold the average is dominated by one busy afternoon,
	// which is worse than the configured constant because it LOOKS derived.
	it("returns null until there is enough history", () => {
		expect(observedInvitesPerWeek(0)).toBeNull();
		expect(observedInvitesPerWeek(4)).toBeNull();
	});

	it("converts approvals in the window to a weekly rate", () => {
		// 28 approvals over 28 days = 7/week.
		expect(observedInvitesPerWeek(28, 28)).toBeCloseTo(7, 5);
		// 56 over 28 days = 14/week.
		expect(observedInvitesPerWeek(56, 28)).toBeCloseTo(14, 5);
	});

	it("rejects a nonsensical window instead of dividing by it", () => {
		expect(observedInvitesPerWeek(50, 0)).toBeNull();
		expect(observedInvitesPerWeek(50, -7)).toBeNull();
	});
});

describe("waitlistEtaLabel with a measured rate", () => {
	it("uses the measured rate over the configured default", () => {
		// 25 invites/week measured: ceil(100 / 25) = 4 weeks. The configured
		// default would answer differently, which is the whole point — the label
		// tracks observed throughput, not the constant.
		expect(waitlistEtaLabel(100, 25)).toBe("~4 weeks");
	});

	it("a slower measured rate lengthens the estimate", () => {
		// Past the weeks threshold the label switches to months, so a slow queue
		// reads as months rather than an absurd week count.
		expect(waitlistEtaLabel(100, 10)).toBe("~2 months");
	});

	it("a faster measured rate shortens the estimate", () => {
		expect(waitlistEtaLabel(100, 200)).toBe("less than a week");
	});

	it("falls back to the configured rate when no rate is measurable", () => {
		// Same answer as the single-argument form, which is the whole point of the
		// fallback: no history must not mean no estimate.
		expect(waitlistEtaLabel(150, null)).toBe(waitlistEtaLabel(150));
		expect(waitlistEtaLabel(150, 0)).toBe(waitlistEtaLabel(150));
	});
});
