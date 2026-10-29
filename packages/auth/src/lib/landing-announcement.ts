import { z } from "zod";

/**
 * The landing page's announcement bar, authored in the admin panel.
 *
 * One record for the whole site: the bar above the `/` header. The control
 * plane validates and stores it (`packages/api` `/api/landing-announcement`),
 * and the marketing site reads the public projection server-side. This module
 * is the shared contract both sides use, so the icon set, the link rules, and
 * "is it live right now" cannot disagree between the writer and the reader.
 */

/**
 * The icons an admin may pick. Fixed so the bar never renders an arbitrary
 * string as an icon name. `witching-hour` is the moon and flickering ghost the
 * seasonal Halloween bar has always worn.
 */
export const LANDING_ANNOUNCEMENT_ICONS = [
	"witching-hour",
	"megaphone",
	"sparkles",
	"rocket",
	"gift",
	"none",
] as const;
export type LandingAnnouncementIcon =
	(typeof LANDING_ANNOUNCEMENT_ICONS)[number];

export const DEFAULT_LANDING_ANNOUNCEMENT_ICON: LandingAnnouncementIcon =
	"witching-hour";

/** Authoring bounds; the bar is one line on desktop. */
export const LANDING_ANNOUNCEMENT_LIMITS = {
	message: 120,
	detail: 160,
	linkLabel: 32,
	linkHref: 500,
} as const;

/** The admin view: everything stored, including a disabled or future bar. */
export interface LandingAnnouncementConfig {
	detail: string | null;
	enabled: boolean;
	endsAt: string | null;
	icon: LandingAnnouncementIcon;
	linkHref: string | null;
	linkLabel: string | null;
	message: string | null;
	startsAt: string | null;
	updatedAt: string | null;
}

/** What the landing page renders. Only ever produced for a live bar. */
export interface LiveLandingAnnouncement {
	detail: string | null;
	/** Kept so a cached copy can still expire on time at render. */
	endsAt: string | null;
	icon: LandingAnnouncementIcon;
	linkHref: string;
	linkLabel: string;
	message: string;
}

const BACKSLASH = 92;
const DELETE = 127;
const SPACE = 32;

/** True when the string has whitespace, a control character, or a backslash. */
function hasUnsafeCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code <= SPACE || code === DELETE || code === BACKSLASH) {
			return true;
		}
		if (/\s/u.test(character)) {
			return true;
		}
	}
	return false;
}

/**
 * Whether `href` may be the bar's link: a same-site path (`/pricing`) or an
 * absolute `https:` URL. Everything else is refused, including `javascript:`,
 * `data:` and `http:` URLs, protocol-relative `//host` links, backslash tricks
 * browsers fold into `//host`, embedded credentials, and any whitespace or
 * control character a scheme could hide behind.
 */
export function isSafeLandingAnnouncementHref(href: string): boolean {
	if (
		href.length === 0 ||
		href.length > LANDING_ANNOUNCEMENT_LIMITS.linkHref ||
		hasUnsafeCharacter(href)
	) {
		return false;
	}
	if (href.startsWith("/")) {
		return !href.startsWith("//");
	}
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return false;
	}
	return (
		url.protocol === "https:" &&
		url.hostname.length > 0 &&
		url.username === "" &&
		url.password === ""
	);
}

/** Epoch ms for a stored or wire date, or null when absent or unparseable. */
function toTime(value: Date | string | null | undefined): number | null {
	if (value === null || value === undefined || value === "") {
		return null;
	}
	const time = (value instanceof Date ? value : new Date(value)).getTime();
	return Number.isNaN(time) ? null : time;
}

/** The fields the resolver reads; dates may be stored Dates or ISO strings. */
export interface LandingAnnouncementCandidate {
	detail?: string | null;
	enabled?: boolean | null;
	endsAt?: Date | string | null;
	icon?: string | null;
	linkHref?: string | null;
	linkLabel?: string | null;
	message?: string | null;
	startsAt?: Date | string | null;
}

/** A known icon, or the default for anything else. */
export function landingAnnouncementIcon(
	value: string | null | undefined
): LandingAnnouncementIcon {
	return (
		LANDING_ANNOUNCEMENT_ICONS.find((icon) => icon === value) ??
		DEFAULT_LANDING_ANNOUNCEMENT_ICON
	);
}

/**
 * The bar to show at `now`, or null. Live means enabled, complete (message,
 * label, and a safe link), started (or unscheduled), and not yet ended. The
 * window is half-open: it shows from `startsAt` up to, not including, `endsAt`.
 */
export function resolveActiveLandingAnnouncement(
	candidate: LandingAnnouncementCandidate | null | undefined,
	now: Date
): LiveLandingAnnouncement | null {
	if (!candidate?.enabled) {
		return null;
	}
	const message = candidate.message?.trim();
	const linkLabel = candidate.linkLabel?.trim();
	const linkHref = candidate.linkHref?.trim();
	if (
		!(
			message &&
			linkLabel &&
			linkHref &&
			isSafeLandingAnnouncementHref(linkHref)
		)
	) {
		return null;
	}
	const at = now.getTime();
	const startsAt = toTime(candidate.startsAt);
	const endsAt = toTime(candidate.endsAt);
	if (
		(startsAt !== null && at < startsAt) ||
		(endsAt !== null && at >= endsAt)
	) {
		return null;
	}
	return {
		message,
		detail: candidate.detail?.trim() || null,
		linkLabel,
		linkHref,
		icon: landingAnnouncementIcon(candidate.icon),
		endsAt: endsAt === null ? null : new Date(endsAt).toISOString(),
	};
}

/** The fields an admin saves; validated by `validateLandingAnnouncementInput`. */
export interface LandingAnnouncementInput {
	detail: string | null;
	enabled: boolean;
	endsAt: Date | null;
	icon: LandingAnnouncementIcon;
	linkHref: string | null;
	linkLabel: string | null;
	message: string | null;
	startsAt: Date | null;
}

const optionalText = z
	.string()
	.nullish()
	.transform((value) => {
		const trimmed = value?.trim() ?? "";
		return trimmed.length > 0 ? trimmed : null;
	});

const rawInputSchema = z.object({
	enabled: z.boolean().default(false),
	message: optionalText,
	detail: optionalText,
	linkLabel: optionalText,
	linkHref: optionalText,
	icon: z.enum(LANDING_ANNOUNCEMENT_ICONS).nullish(),
	startsAt: optionalText,
	endsAt: optionalText,
});

export type LandingAnnouncementValidation =
	| { ok: true; value: LandingAnnouncementInput }
	| { ok: false; error: string };

function parseWhen(
	value: string | null,
	label: string
): { ok: true; value: Date | null } | { ok: false; error: string } {
	if (value === null) {
		return { ok: true, value: null };
	}
	const time = toTime(value);
	if (time === null) {
		return { ok: false, error: `${label} must be a valid date and time.` };
	}
	return { ok: true, value: new Date(time) };
}

function tooLong(value: string | null, max: number): boolean {
	return value !== null && value.length > max;
}

/**
 * Validate an admin save. The link must always be safe, even on a disabled
 * bar, so an unsafe draft can never be switched on later. An enabled bar must
 * be complete, and a schedule must end after it starts.
 */
export function validateLandingAnnouncementInput(
	raw: unknown
): LandingAnnouncementValidation {
	// A missing or unreadable body is refused rather than read as "all blank",
	// which would silently switch a live bar off and wipe its copy.
	const parsed = rawInputSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, error: "The announcement fields are malformed." };
	}
	const input = parsed.data;
	const limits = LANDING_ANNOUNCEMENT_LIMITS;
	if (tooLong(input.message, limits.message)) {
		return {
			ok: false,
			error: `The message is limited to ${limits.message} characters.`,
		};
	}
	if (tooLong(input.detail, limits.detail)) {
		return {
			ok: false,
			error: `The detail is limited to ${limits.detail} characters.`,
		};
	}
	if (tooLong(input.linkLabel, limits.linkLabel)) {
		return {
			ok: false,
			error: `The link label is limited to ${limits.linkLabel} characters.`,
		};
	}
	if (
		input.linkHref !== null &&
		!isSafeLandingAnnouncementHref(input.linkHref)
	) {
		return {
			ok: false,
			error: "The link must be a site path like /pricing or an https:// URL.",
		};
	}
	if (input.enabled && !(input.message && input.linkLabel && input.linkHref)) {
		return {
			ok: false,
			error:
				"An enabled announcement needs a message, a link label and a link.",
		};
	}
	const startsAt = parseWhen(input.startsAt, "The start");
	if (!startsAt.ok) {
		return startsAt;
	}
	const endsAt = parseWhen(input.endsAt, "The end");
	if (!endsAt.ok) {
		return endsAt;
	}
	if (
		startsAt.value !== null &&
		endsAt.value !== null &&
		endsAt.value.getTime() <= startsAt.value.getTime()
	) {
		return { ok: false, error: "The end must be after the start." };
	}
	return {
		ok: true,
		value: {
			enabled: input.enabled,
			message: input.message,
			detail: input.detail,
			linkLabel: input.linkLabel,
			linkHref: input.linkHref,
			icon: input.icon ?? DEFAULT_LANDING_ANNOUNCEMENT_ICON,
			startsAt: startsAt.value,
			endsAt: endsAt.value,
		},
	};
}
