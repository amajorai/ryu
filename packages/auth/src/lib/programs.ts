/**
 * Free-licence programs: Ryu for Students and Ryu for Startups.
 *
 * Both programs grant the SAME thing — a non-renewing window of the one-time
 * desktop licence (`desktop-license` in `plans.ts`): the desktop app with the
 * user's own provider keys (BYOK). Neither grants managed inference, an included
 * credit pool, Marketplace access, or a Ryu Cloud node. That boundary is enforced
 * where the window is overlaid on an entitlement (`packages/api/src/lib/programs.ts`),
 * not by copy on a page.
 *
 * Verification follows the usual industry split (Notion, GitHub Education,
 * JetBrains, Figma):
 *  - Students prove enrolment by receiving a one-time code at an ACADEMIC email
 *    address. Consumer mailboxes (Gmail, Outlook, iCloud…) prove nothing about
 *    enrolment and are refused. One school address can back one Ryu account.
 *  - Startups apply and an admin reviews the application and approves a
 *    6-month window (`STARTUP_PROGRAM_MONTHS`). There is no self-serve proof of
 *    being an early-stage company.
 *
 * CLIENT-SAFE ON PURPOSE, like `vouchers.ts`: the public `/students` and
 * `/startups` pages import the durations and the domain check from here so the
 * page can never advertise a different window than the server grants.
 */

export const PROGRAM_IDS = ["students", "startups"] as const;
export type ProgramId = (typeof PROGRAM_IDS)[number];

/** The plan every program window grants: desktop app + BYOK only. */
export const PROGRAM_GRANT_PLAN = "desktop-license" as const;

/** Students get one calendar year from the day the school email is confirmed. */
export const STUDENT_PROGRAM_MONTHS = 12;

/** Startups approved by an admin after review. */
export const STARTUP_PROGRAM_MONTHS = 6;

/**
 * Startups that redeem a valid partner code (an incubator, accelerator or VC
 * the code was issued to). The code IS the verification, so these are
 * approved instantly with the longer window.
 */
export const STARTUP_PARTNER_MONTHS = 12;

/** Published startup eligibility, shown on the page and in the admin queue. */
export const STARTUP_MAX_AGE_YEARS = 5;
export const STARTUP_MAX_FUNDING_USD = 5_000_000;

/** One-time code lifetime and the attempts allowed against one code. */
export const STUDENT_CODE_TTL_MINUTES = 15;
export const STUDENT_CODE_MAX_ATTEMPTS = 5;

/**
 * Personal mailbox providers. A school may host mail on Google Workspace or
 * Microsoft 365, but then the address is on the school's own domain, never on
 * one of these.
 */
const CONSUMER_EMAIL_DOMAINS = new Set([
	"163.com",
	"126.com",
	"aol.com",
	"fastmail.com",
	"gmail.com",
	"gmx.com",
	"gmx.de",
	"gmx.net",
	"googlemail.com",
	"hey.com",
	"hotmail.com",
	"icloud.com",
	"live.com",
	"mail.com",
	"mail.ru",
	"me.com",
	"msn.com",
	"naver.com",
	"outlook.com",
	"pm.me",
	"proton.me",
	"protonmail.com",
	"qq.com",
	"tutanota.com",
	"yahoo.com",
	"yandex.com",
	"yandex.ru",
	"zoho.com",
]);

/**
 * Universities whose mail is not under an `edu`/`ac` label. Matching is by the
 * registrable domain or any subdomain of it (`student.ethz.ch` matches
 * `ethz.ch`). Add rows here when a real student is refused; keep it small and
 * reviewed rather than importing an unvetted list wholesale.
 */
export const ACADEMIC_DOMAIN_ALLOWLIST: readonly string[] = [
	"epfl.ch",
	"ethz.ch",
	"kth.se",
	"lmu.de",
	"mcgill.ca",
	"rwth-aachen.de",
	"tudelft.nl",
	"tum.de",
	"ubc.ca",
	"utoronto.ca",
	"uva.nl",
	"uwaterloo.ca",
];

/** Leading labels that mark a graduate's forwarding address, not enrolment. */
const ALUMNI_LABELS = new Set(["alum", "alumni", "alumnae", "alumnus"]);

const DOMAIN_RE =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const COUNTRY_CODE_RE = /^[a-z]{2}$/;

/** Lower-cased domain of an email address, or null when it is not one. */
export function emailDomain(email: string): string | null {
	const trimmed = email.trim().toLowerCase();
	const at = trimmed.lastIndexOf("@");
	if (at <= 0 || at === trimmed.length - 1) {
		return null;
	}
	const domain = trimmed.slice(at + 1);
	return DOMAIN_RE.test(domain) ? domain : null;
}

const matchesAllowlist = (domain: string): boolean =>
	ACADEMIC_DOMAIN_ALLOWLIST.some(
		(entry) => domain === entry || domain.endsWith(`.${entry}`)
	);

/**
 * Whether `email` is on an academic domain:
 *  - `*.edu` (US higher education);
 *  - `*.edu.<cc>` / `*.ac.<cc>` (e.g. `nus.edu.sg`, `ox.ac.uk`, `u-tokyo.ac.jp`);
 *  - a reviewed university on {@link ACADEMIC_DOMAIN_ALLOWLIST}.
 * Consumer mailboxes and alumni forwarding domains are refused.
 */
export function isAcademicEmail(email: string): boolean {
	const domain = emailDomain(email);
	if (!domain || CONSUMER_EMAIL_DOMAINS.has(domain)) {
		return false;
	}
	const labels = domain.split(".");
	if (ALUMNI_LABELS.has(labels[0] ?? "")) {
		return false;
	}
	if (matchesAllowlist(domain)) {
		return true;
	}
	const tld = labels.at(-1) ?? "";
	const second = labels.at(-2) ?? "";
	// `mit.edu` needs a name before `edu`; a bare `edu` is never a mailbox.
	if (tld === "edu") {
		return labels.length >= 2;
	}
	// `edu.sg` alone is the registry, not a school: require a label before it.
	return (
		COUNTRY_CODE_RE.test(tld) &&
		(second === "edu" || second === "ac") &&
		labels.length >= 3
	);
}

const PARTNER_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,38}[A-Z0-9]$/;

/**
 * Canonical form of a typed partner code: upper case, spaces removed. Returns
 * null for anything that cannot be a code, so a typo never reaches the store.
 */
export function normalizePartnerCode(value: string): string | null {
	const code = value.replaceAll(/\s+/gu, "").toUpperCase();
	return PARTNER_CODE_RE.test(code) ? code : null;
}
