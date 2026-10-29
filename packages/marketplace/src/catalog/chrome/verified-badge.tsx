// packages/marketplace/src/catalog/chrome/verified-badge.tsx
//
// The shared publisher check: one component and one Lucide mark on every surface,
// so the card and detail hero cannot disagree about publisher trust.
//
// THREE AXES, ONE CARD — the distinction this file exists to protect. A listing
// carries three independent trust facts and they are routinely confused:
//
//   `reviewed`     — did Ryu vet this LISTING's code? A GitHub topic-discovered
//                    listing is `reviewed: false` and gets the amber "Not
//                    reviewed by Ryu" alert (see community-trust-notice.tsx),
//                    which this badge can legitimately sit beside.
//   `verification` — did this listing's manifest SIGNATURE verify? That is
//                    INSTALL TRUST. It lives on the web marketplace's own card
//                    (apps/web/src/lib/marketplace-api.ts), where it owns the
//                    bare wire word `verified` and renders a destructive
//                    "Signature invalid" chip when it is false.
//   `orgVerified`  — is the PUBLISHING ORGANIZATION identity-verified? That is
//                    what THIS badge shows, and nothing else.
//
// They are orthogonal. A verified organization can publish an unreviewed
// community listing (we know exactly who they are; nobody has read their code),
// and an anonymous individual can publish a reviewed one. Both combinations
// render both signals. Anyone tempted to collapse them into one "trusted" flag
// should note that doing so silently upgrades one of those cases and silently
// downgrades the other — and that folding axis 3 onto axis 2's wire word would
// brand every listing from an unverified publisher as cryptographically
// tampered, which is precisely why the org fields carry an `org_` prefix.
//
// That is also why this badge is deliberately UNLIKE the community notice: the
// notice is a full-width amber alert placed in the reading path before any
// install control, this is a small inline publisher-trust mark beside the name.
// Different shape, different colour, different placement — they can sit on the
// same card without reading as a contradiction.
//
// THREE THINGS IN THIS REPO ARE ALSO CALLED "VERIFIED", which is why every
// string here leads with the word *organization* rather than saying "Verified":
// the web marketplace's signature chip above is labelled "Verified", and the
// reviews panel renders a "Verified purchase" chip on the same detail screen. A
// bare "Verified" here would be the third one and the user could not tell which
// claim it makes.

import {
	type VerificationDetails,
	VerificationPopover,
} from "@ryu/ui/components/verification-popover.tsx";
import {
	type PublisherTrustLevel,
	publisherTrustLabel,
	publisherTrustTooltip,
} from "@ryuhq/protocol/publisher-trust";

/** Human label per verification tier.
 *
 *  NOTE the collision this map is written to survive: the tier vocabulary
 *  includes "community", which means "a community organization we have
 *  identity-checked" — NOT `origin === "community"`, which means "discovered
 *  from a public GitHub topic and reviewed by nobody". Rendering the bare tier
 *  word would put the string "Community" on a card next to an amber "Not
 *  reviewed by Ryu" alert and invite exactly the wrong reading, so the tier is
 *  never shown alone: it is always a qualifier on "Verified organization". */
const TIER_LABEL = new Map(
	Object.entries({
		official: "Official",
		partner: "Partner",
		community: "Community",
	})
);

/**
 * The badge's accessible name and fallback description for a tier.
 *
 * An UNKNOWN tier degrades to the unqualified "Verified organization" rather
 * than dropping the badge or printing the raw token: `org_verified_tier` is a
 * plain string precisely because a newer control plane may mint a tier this
 * build has never heard of (the forward-tolerance `stability`/`surfaces` chose),
 * and losing the check entirely is a worse answer than losing its qualifier.
 *
 * Exported so the label rules are unit-testable without rendering.
 */
export function verifiedLabel(tier?: string | null): string {
	const known = tier ? TIER_LABEL.get(tier.trim().toLowerCase()) : undefined;
	return known ? `Verified organization — ${known}` : "Verified organization";
}

export function trustLabel(level: PublisherTrustLevel): string {
	return publisherTrustLabel(level);
}

/**
 * The publisher check, rendered beside a listing's NAME (never on its icon —
 * the icon is the app's identity, this is the publisher's).
 *
 * Renders nothing unless the caller passes `orgVerified`. The gate is the FLAG,
 * not the tier: a payload carrying `org_verified_tier` with `org_verified: false`
 * shows nothing, because the tier alone is a claim about a privilege the server
 * never granted — the same posture `mandatory` takes on `CatalogEntry`.
 */
export default function VerifiedBadge({
	orgVerified,
	publisherTrust,
	verificationDetails,
	tier,
	tone = "card",
	className,
}: {
	className?: string;
	/** Is the PUBLISHING ORGANIZATION identity-verified? Server-derived,
	 *  absent/false renders nothing. Named for the axis on purpose: a bare
	 *  `verified` here would read as the manifest-signature flag the web
	 *  marketplace card carries under that exact word. */
	orgVerified?: boolean;
	/** The complete publisher identity mark. `dotted` (unpaid publisher)
	 * renders nothing: only gold and blue publishers get a check. */
	publisherTrust?: PublisherTrustLevel | null;
	/** Server-derived evidence for the publisher mark. */
	verificationDetails?: VerificationDetails | null;
	/** The org's verification tier, when known. Only a qualifier — see
	 *  {@link verifiedLabel}; an unrecognized value still renders the check. */
	tier?: string | null;
	/** Which surface the icon is painted on.
	 *
	 *  `"card"` sits on the page's own background and gets the themed info colour.
	 *  `"hero"` sits on the detail hero's author-supplied dither wash under a
	 *  black scrim, where every foreground is fixed white, so it gets the hero's
	 *  high-contrast icon colour instead. */
	tone?: "card" | "hero";
}) {
	// New catalog payloads carry the complete publisher mark. Older Core-facing
	// payloads only carry the org flag and tier, so retain their established
	// semantics: an explicit true renders the tier-qualified organization badge;
	// false/absent renders nothing.
	const hasExplicitPublisherTrust =
		publisherTrust !== null && publisherTrust !== undefined;
	if (!(hasExplicitPublisherTrust || orgVerified)) {
		return null;
	}
	const level = publisherTrust ?? "gold";
	if (level === "dotted") {
		return null;
	}
	const label = hasExplicitPublisherTrust
		? trustLabel(level)
		: verifiedLabel(tier);
	const tooltip = hasExplicitPublisherTrust
		? publisherTrustTooltip(level)
		: label;
	const details = verificationDetails ?? {
		methods: [
			{
				kind: level === "gold" ? "organization" : "platform",
				label: tooltip,
			},
		],
	};
	const appearance =
		level === "gold"
			? tone === "hero"
				? "publisher-gold-hero"
				: "publisher-gold-card"
			: tone === "hero"
				? "publisher-blue-hero"
				: "publisher-blue-card";
	return (
		<VerificationPopover
			appearance={appearance}
			className={className}
			description={tooltip}
			details={details}
			label={label}
			title={label}
			variant="badge"
		/>
	);
}
