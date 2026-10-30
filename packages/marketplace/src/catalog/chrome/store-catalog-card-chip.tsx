import { MarketplaceAccessBadge } from "@ryu/ui/components/marketplace-access-badge.tsx";
import type { PublisherTrustLevel } from "@ryuhq/protocol/publisher-trust";
import type { ReactNode } from "react";
import { DEPRECATED_LABEL } from "../deprecation.ts";
import { stabilityLabel } from "../stability.ts";

/** Whether {@link VerifiedBadge} would render a publisher check: an explicit
 *  gold or blue publisher mark, or the legacy `orgVerified` flag. */
export function hasPublisherMark({
	orgVerified,
	publisherTrust,
}: {
	orgVerified?: boolean;
	publisherTrust?: PublisherTrustLevel | null;
}): boolean {
	if (publisherTrust !== null && publisherTrust !== undefined) {
		return publisherTrust !== "dotted";
	}
	return Boolean(orgVerified);
}

/** The single badge a catalog card may carry, for an exceptional state only.
 *  Deprecation outranks an unfinished release, which outranks the community
 *  disclosure, which outranks the membership ticket. A normal listing gets
 *  nothing. Set as quiet coloured text, not a filled chip. */
export function exceptionalCardBadge({
	communityApp,
	deprecated,
	membershipEntitled,
	membershipIncluded,
	stability,
}: {
	communityApp: boolean;
	deprecated: boolean;
	membershipEntitled: boolean;
	membershipIncluded: boolean;
	stability?: string | null;
}): ReactNode {
	if (deprecated) {
		return (
			<span
				className="shrink-0 text-status-destructive text-xs"
				data-testid="deprecated-badge"
			>
				{DEPRECATED_LABEL}
			</span>
		);
	}
	const unstable = stabilityLabel(stability);
	if (unstable) {
		return (
			<span className="shrink-0 text-status-warning text-xs">{unstable}</span>
		);
	}
	if (communityApp) {
		return (
			<span
				className="shrink-0 text-muted-foreground text-xs"
				data-testid="community-app-badge"
			>
				Community app
			</span>
		);
	}
	if (membershipEntitled || membershipIncluded) {
		return (
			<span className="pointer-events-auto relative z-10 shrink-0">
				<MarketplaceAccessBadge
					membershipEntitled={membershipEntitled}
					membershipIncluded={membershipIncluded}
				/>
			</span>
		);
	}
	return null;
}
