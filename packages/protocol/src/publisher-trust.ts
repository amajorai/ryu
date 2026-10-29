/**
 * Publisher identity trust is deliberately separate from listing review and
 * manifest-signature provenance. It answers one question only: who stands
 * behind this publication?
 *
 * The marks:
 *   gold   — Ryu first-party, or a Business/Enterprise organization with a
 *            Stripe-verified identity AND a verified domain that a Ryu admin has
 *            ALSO approved. Every half is required at display time: an approval
 *            on an org that later drops off Business, or whose Stripe identity
 *            lapses, stops showing gold.
 *   blue   — an organization with an active paid Ryu subscription (Plus, Pro,
 *            Max, Teams, Business, …) that has proved who it is through Stripe
 *            identity OR a DNS-verified domain. Automatic; no review. Payment
 *            alone is not enough: anyone can pay and name an org after a brand.
 *   dotted — everyone else. Kept as a distinct LEVEL because install warnings
 *            and publisher-health key off it, but the badge renders nothing for
 *            it: only paying publishers get a checkmark.
 */

export const PUBLISHER_TRUST_LEVELS = ["gold", "blue", "dotted"] as const;
export type PublisherTrustLevel = (typeof PUBLISHER_TRUST_LEVELS)[number];

/** `stripe_connect` is no longer minted; it stays parseable for payloads from
 * older control planes and cached Core catalogs. */
export const PUBLISHER_TRUST_SOURCES = [
	"ryu_staff",
	"paid_plan",
	"stripe_connect",
	"none",
] as const;
export type PublisherTrustSource = (typeof PUBLISHER_TRUST_SOURCES)[number];

export interface PublisherTrustInput {
	/** The organization proved control of at least one domain. */
	domainVerified?: boolean | null;
	firstParty?: boolean | null;
	/** The organization is on a gold-eligible plan (Business/Enterprise). */
	goldEligiblePlan?: boolean | null;
	/** The organization has any active paid subscription. */
	paidPlan?: boolean | null;
	/** A Ryu admin approved the organization's verification request. */
	ryuStaffVerified?: boolean | null;
	/** Stripe Connect verified the organization's identity. */
	stripeIdentityVerified?: boolean | null;
}

export interface PublisherTrustSummary {
	level: PublisherTrustLevel;
	source: PublisherTrustSource;
	verified: boolean;
}

/**
 * Resolve the publisher mark from server-controlled signals. Missing signals
 * fail closed to dotted (no badge).
 */
export function resolvePublisherTrust(
	input: PublisherTrustInput
): PublisherTrustSummary {
	if (input.firstParty) {
		return { level: "gold", source: "ryu_staff", verified: true };
	}
	const paid = Boolean(input.paidPlan || input.goldEligiblePlan);
	if (
		input.ryuStaffVerified &&
		input.goldEligiblePlan &&
		input.stripeIdentityVerified &&
		input.domainVerified
	) {
		return { level: "gold", source: "ryu_staff", verified: true };
	}
	if (paid && (input.stripeIdentityVerified || input.domainVerified)) {
		return { level: "blue", source: "paid_plan", verified: true };
	}
	return { level: "dotted", source: "none", verified: false };
}

/**
 * Fallback for a payload that predates `publisherTrust` and carries only the
 * server-derived `orgVerified` flag. The server already applied the plan gate
 * before setting that flag, so it maps straight to gold.
 */
export function publisherTrustFromOrgFlag(input: {
	firstParty?: boolean | null;
	orgVerified?: boolean | null;
}): PublisherTrustSummary {
	return input.firstParty || input.orgVerified
		? { level: "gold", source: "ryu_staff", verified: true }
		: { level: "dotted", source: "none", verified: false };
}

export function publisherTrustLabel(level: PublisherTrustLevel): string {
	switch (level) {
		case "gold":
			return "Verified business";
		case "blue":
			return "Verified paid organization";
		case "dotted":
			return "Unverified publisher";
	}
}

export function publisherTrustTooltip(level: PublisherTrustLevel): string {
	switch (level) {
		case "gold":
			return "Ryu staff verified this Business organization, its Stripe identity, and its domain.";
		case "blue":
			return "This organization has an active paid Ryu plan and verified its identity through Stripe or a domain it owns. Ryu staff has not reviewed it.";
		case "dotted":
			return "This is not a verified publisher. Review the health signals before installing.";
	}
}
