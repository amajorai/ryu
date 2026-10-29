/**
 * Business-email admission for shared organizations.
 *
 * A verified mailbox is necessary but not sufficient for a Teams identity:
 * public mailbox domains (Gmail, Outlook, etc.) are deliberately excluded.
 * This is a product-admission heuristic, not proof of legal employment. A
 * deployment that needs stronger assurance can set
 * `RYU_TEAMS_ALLOWED_EMAIL_DOMAINS` to an exact, comma-separated domain list.
 */

export type BusinessEmailFailure =
	| "consumer_email"
	| "domain_not_allowed"
	| "email_unverified"
	| "invalid_email";

export interface BusinessEmailDecision {
	readonly allowed: boolean;
	readonly domain: string | null;
	readonly reason?: BusinessEmailFailure;
}

/** Public mailbox providers that do not establish a company identity. */
export const DEFAULT_PUBLIC_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
	"aol.com",
	"comcast.net",
	"fastmail.com",
	"fastmail.fm",
	"free.fr",
	"gmail.com",
	"gmx.com",
	"gmx.de",
	"gmx.net",
	"googlemail.com",
	"hey.com",
	"hotmail.co.uk",
	"hotmail.com",
	"hotmail.fr",
	"icloud.com",
	"live.com",
	"mail.com",
	"mail.ru",
	"me.com",
	"msn.com",
	"naver.com",
	"orange.fr",
	"outlook.com",
	"outlook.de",
	"outlook.fr",
	"pm.me",
	"proton.me",
	"protonmail.com",
	"qq.com",
	"rediffmail.com",
	"seznam.cz",
	"sky.com",
	"t-online.de",
	"tutanota.com",
	"verizon.net",
	"web.de",
	"yahoo.co.jp",
	"yahoo.co.uk",
	"yahoo.com",
	"yahoo.fr",
	"yandex.ru",
	"ymail.com",
	"zoho.com",
]);

const EMAIL_RE = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/;

export function normalizeEmailDomain(
	email: string | null | undefined
): string | null {
	if (email === null || email === undefined) {
		return null;
	}
	const match = EMAIL_RE.exec(email.trim().toLowerCase());
	return match?.[1] ?? null;
}

function configuredDomainSet(
	read: (key: string) => string | undefined
): ReadonlySet<string> {
	return new Set(
		(read("RYU_TEAMS_ALLOWED_EMAIL_DOMAINS") ?? "")
			.split(",")
			.map((domain) => domain.trim().toLowerCase())
			.filter(Boolean)
	);
}

/** Check the domain half without requiring a user account or verification. */
export function businessEmailDomainDecision(
	email: string | null | undefined,
	options: {
		publicDomains?: ReadonlySet<string>;
		read?: (key: string) => string | undefined;
	} = {}
): BusinessEmailDecision {
	const domain = normalizeEmailDomain(email);
	if (!domain) {
		return { allowed: false, domain: null, reason: "invalid_email" };
	}

	const read = options.read ?? ((key: string) => process.env[key]);
	const allowedDomains = configuredDomainSet(read);
	if (allowedDomains.size > 0 && !allowedDomains.has(domain)) {
		return { allowed: false, domain, reason: "domain_not_allowed" };
	}

	const publicDomains = options.publicDomains ?? DEFAULT_PUBLIC_MAILBOX_DOMAINS;
	if (publicDomains.has(domain)) {
		return { allowed: false, domain, reason: "consumer_email" };
	}

	return { allowed: true, domain };
}

/** Check the domain and the Better Auth mailbox-verification state. */
export function businessEmailDecision(
	input: {
		email: string | null | undefined;
		emailVerified: boolean | null | undefined;
	},
	options: {
		publicDomains?: ReadonlySet<string>;
		read?: (key: string) => string | undefined;
	} = {}
): BusinessEmailDecision {
	const domainDecision = businessEmailDomainDecision(input.email, options);
	if (!domainDecision.allowed) {
		return domainDecision;
	}
	if (!input.emailVerified) {
		return {
			allowed: false,
			domain: domainDecision.domain,
			reason: "email_unverified",
		};
	}
	return domainDecision;
}

export function businessEmailMessage(
	decision: BusinessEmailDecision,
	context: "member" | "upgrade" | "invitation" = "member"
): string {
	if (decision.reason === "email_unverified") {
		return "Verify your business email before joining a Teams organization.";
	}
	if (decision.reason === "invalid_email") {
		return "A valid business email is required for Teams organizations.";
	}
	if (decision.reason === "domain_not_allowed") {
		return "This email domain is not approved for Teams. Use your company's verified domain or contact Enterprise.";
	}
	if (decision.reason === "consumer_email") {
		return context === "invitation"
			? "Teams invitations must use a company email address, not Gmail, Outlook, or another public mailbox."
			: "Teams requires a company email address, not Gmail, Outlook, or another public mailbox. You can change and verify the email on this same Ryu account; a second account is not required.";
	}
	return "A verified business email is required for Teams organizations.";
}

/**
 * The admission check for an organization role change, applied to the member
 * whose role changes, when the change grants permissions they did not hold
 * (callers compute that with `roleChangeGrantsPermissions`). Better Auth's `beforeUpdateMemberRole` hook and the
 * Admin API role route both call it, so a user whose email was changed or is
 * unverified cannot gain a stronger role through either path. Returns the
 * refusal message, or null when the change is admitted.
 */
export function memberRoleChangeRefusal(
	user: {
		email: string | null | undefined;
		emailVerified: boolean | null | undefined;
	},
	change: { grantsPermissions: boolean } = { grantsPermissions: true }
): string | null {
	// Only a promotion is an admission point; a demotion or lateral change
	// never needs the business-email check (and must not be blocked by it).
	if (!change.grantsPermissions) {
		return null;
	}
	const decision = businessEmailDecision({
		email: user.email,
		emailVerified: user.emailVerified,
	});
	return decision.allowed ? null : businessEmailMessage(decision, "member");
}
