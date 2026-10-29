import { describe, expect, test } from "bun:test";
import {
	isSafeLandingAnnouncementHref,
	LANDING_ANNOUNCEMENT_BACKGROUNDS,
	landingAnnouncementBackground,
	resolveActiveLandingAnnouncement,
	validateLandingAnnouncementInput,
} from "./landing-announcement.ts";

describe("isSafeLandingAnnouncementHref", () => {
	test.each([
		"/",
		"/pricing",
		"/witching-hour?ref=bar#top",
		"https://ryuhq.com/blog/launch",
		"HTTPS://docs.ryuhq.com",
	])("accepts %s", (href) => {
		expect(isSafeLandingAnnouncementHref(href)).toBe(true);
	});

	test.each([
		"",
		"javascript:alert(1)",
		"JavaScript:alert(1)",
		" javascript:alert(1)",
		"java\tscript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"http://ryuhq.com",
		"//evil.example",
		"/\\evil.example",
		"/foo bar",
		"/foo\nbar",
		"https://user:pass@evil.example",
		"https:",
		"pricing",
		"mailto:hi@example.test",
		`/${"a".repeat(600)}`,
	])("rejects %p", (href) => {
		expect(isSafeLandingAnnouncementHref(href)).toBe(false);
	});
});

describe("validateLandingAnnouncementInput", () => {
	const complete = {
		enabled: true,
		message: "  Ryu 1.0 is here.  ",
		detail: "",
		linkLabel: "Read more",
		linkHref: "/blog/ryu-1",
		icon: "rocket",
		startsAt: "2026-11-01T00:00:00.000Z",
		endsAt: "2026-11-08T00:00:00.000Z",
	};

	test("trims text, blanks empty optionals, and parses the schedule", () => {
		const result = validateLandingAnnouncementInput(complete);
		expect(result).toEqual({
			ok: true,
			value: {
				enabled: true,
				message: "Ryu 1.0 is here.",
				detail: null,
				linkLabel: "Read more",
				linkHref: "/blog/ryu-1",
				icon: "rocket",
				background: "witching-hour",
				startsAt: new Date("2026-11-01T00:00:00.000Z"),
				endsAt: new Date("2026-11-08T00:00:00.000Z"),
			},
		});
	});

	test("defaults the icon to the seasonal look", () => {
		const result = validateLandingAnnouncementInput({
			...complete,
			icon: undefined,
		});
		expect(result.ok && result.value.icon).toBe("witching-hour");
	});

	test("keeps a chosen background and defaults a missing one", () => {
		for (const background of LANDING_ANNOUNCEMENT_BACKGROUNDS) {
			const result = validateLandingAnnouncementInput({
				...complete,
				background,
			});
			expect(result.ok && result.value.background).toBe(background);
		}
		const result = validateLandingAnnouncementInput({
			...complete,
			background: null,
		});
		expect(result.ok && result.value.background).toBe("witching-hour");
	});

	test("rejects an unknown background, including raw CSS", () => {
		for (const background of ["skull", "red", "url(javascript:alert(1))"]) {
			expect(
				validateLandingAnnouncementInput({ ...complete, background }).ok
			).toBe(false);
		}
	});

	test("rejects an unknown icon and malformed bodies", () => {
		expect(
			validateLandingAnnouncementInput({ ...complete, icon: "skull" }).ok
		).toBe(false);
		expect(validateLandingAnnouncementInput({ enabled: "yes" }).ok).toBe(false);
		expect(validateLandingAnnouncementInput("nope").ok).toBe(false);
		expect(validateLandingAnnouncementInput(null).ok).toBe(false);
	});

	test("rejects unsafe links even while disabled", () => {
		for (const linkHref of ["javascript:alert(1)", "data:,x", "//evil.test"]) {
			const result = validateLandingAnnouncementInput({
				...complete,
				enabled: false,
				linkHref,
			});
			expect(result).toEqual({
				ok: false,
				error: "The link must be a site path like /pricing or an https:// URL.",
			});
		}
	});

	test("requires message, label and link only when enabled", () => {
		expect(
			validateLandingAnnouncementInput({ ...complete, linkLabel: " " }).ok
		).toBe(false);
		expect(
			validateLandingAnnouncementInput({ enabled: false, message: "Draft" })
		).toMatchObject({ ok: true, value: { enabled: false, linkHref: null } });
	});

	test("rejects over-long text", () => {
		expect(
			validateLandingAnnouncementInput({
				...complete,
				message: "x".repeat(121),
			}).ok
		).toBe(false);
	});

	test("rejects invalid dates and a window that ends before it starts", () => {
		expect(
			validateLandingAnnouncementInput({ ...complete, startsAt: "soon" })
		).toEqual({ ok: false, error: "The start must be a valid date and time." });
		expect(
			validateLandingAnnouncementInput({
				...complete,
				endsAt: complete.startsAt,
			})
		).toEqual({ ok: false, error: "The end must be after the start." });
	});

	test("allows an open-ended schedule", () => {
		const result = validateLandingAnnouncementInput({
			...complete,
			startsAt: null,
			endsAt: "",
		});
		expect(result).toMatchObject({
			ok: true,
			value: { startsAt: null, endsAt: null },
		});
	});
});

describe("resolveActiveLandingAnnouncement", () => {
	const now = new Date("2026-11-03T12:00:00.000Z");
	const stored = {
		enabled: true,
		message: "Ryu 1.0 is here.",
		detail: "See what shipped.",
		linkLabel: "Read more",
		linkHref: "https://ryuhq.com/blog/ryu-1",
		icon: "gift",
		startsAt: new Date("2026-11-01T00:00:00.000Z"),
		endsAt: new Date("2026-11-08T00:00:00.000Z"),
	};

	test("returns the live projection inside the window", () => {
		expect(resolveActiveLandingAnnouncement(stored, now)).toEqual({
			message: "Ryu 1.0 is here.",
			detail: "See what shipped.",
			linkLabel: "Read more",
			linkHref: "https://ryuhq.com/blog/ryu-1",
			icon: "gift",
			background: "witching-hour",
			endsAt: "2026-11-08T00:00:00.000Z",
		});
	});

	test("is null when absent, disabled, or incomplete", () => {
		expect(resolveActiveLandingAnnouncement(null, now)).toBeNull();
		expect(
			resolveActiveLandingAnnouncement({ ...stored, enabled: false }, now)
		).toBeNull();
		expect(
			resolveActiveLandingAnnouncement({ ...stored, message: "  " }, now)
		).toBeNull();
	});

	test("never serves a stored unsafe link", () => {
		expect(
			resolveActiveLandingAnnouncement(
				{ ...stored, linkHref: "javascript:alert(1)" },
				now
			)
		).toBeNull();
	});

	test("honours a half-open schedule window", () => {
		expect(
			resolveActiveLandingAnnouncement(stored, new Date("2026-10-31T23:59:59Z"))
		).toBeNull();
		expect(
			resolveActiveLandingAnnouncement(stored, stored.startsAt)
		).not.toBeNull();
		expect(resolveActiveLandingAnnouncement(stored, stored.endsAt)).toBeNull();
	});

	test("treats missing bounds as open-ended and accepts ISO strings", () => {
		expect(
			resolveActiveLandingAnnouncement(
				{ ...stored, startsAt: null, endsAt: undefined },
				now
			)
		).toMatchObject({ endsAt: null });
		expect(
			resolveActiveLandingAnnouncement(
				{ ...stored, endsAt: "2026-11-03T11:00:00.000Z" },
				now
			)
		).toBeNull();
	});

	test("falls back to the default icon for an unknown stored value", () => {
		expect(
			resolveActiveLandingAnnouncement({ ...stored, icon: "skull" }, now)
		).toMatchObject({ icon: "witching-hour" });
	});

	test("serves a stored background, and the default for an unknown one", () => {
		expect(
			resolveActiveLandingAnnouncement({ ...stored, background: "brand" }, now)
		).toMatchObject({ background: "brand" });
		expect(
			resolveActiveLandingAnnouncement(
				{ ...stored, background: "#ff0000" },
				now
			)
		).toMatchObject({ background: "witching-hour" });
	});
});

describe("landingAnnouncementBackground", () => {
	test("passes the presets through and defaults everything else", () => {
		for (const background of LANDING_ANNOUNCEMENT_BACKGROUNDS) {
			expect(landingAnnouncementBackground(background)).toBe(background);
		}
		for (const value of [null, undefined, "", "Brand", "red"]) {
			expect(landingAnnouncementBackground(value)).toBe("witching-hour");
		}
	});
});
