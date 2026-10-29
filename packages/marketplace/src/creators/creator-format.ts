// packages/marketplace/src/creators/creator-format.ts
//
// Pure display rules for the Creators tab, kept out of the components so they
// are unit-testable without rendering.

import { marketplaceBrowseKindLabel } from "../catalog/chrome/marketplace-sections.ts";
import type { MarketplaceCreator } from "./creator-types.ts";

/** The `@handle` shown under a creator's name, or null without a slug. */
export function creatorHandle(
	creator: Pick<MarketplaceCreator, "slug">
): string | null {
	const slug = creator.slug?.trim();
	return slug ? `@${slug}` : null;
}

/** The stable key a profile is addressed by: its slug, else its id. */
export function creatorRouteHandle(
	creator: Pick<MarketplaceCreator, "id" | "slug">
): string {
	return creator.slug?.trim() || creator.id;
}

/** "Skills, Agent Templates +2" — the kinds a creator publishes, capped. */
export function creatorKindSummary(kinds: string[], max = 2): string {
	const labels = kinds.map(marketplaceBrowseKindLabel);
	if (labels.length <= max) {
		return labels.join(", ");
	}
	return `${labels.slice(0, max).join(", ")} +${labels.length - max}`;
}

/** "Publishing since Mar 2026", or null when the date is missing or invalid. */
export function creatorSinceLabel(
	iso: string | null,
	locale?: string
): string | null {
	if (!iso) {
		return null;
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	const month = new Intl.DateTimeFormat(locale, {
		month: "short",
		timeZone: "UTC",
		year: "numeric",
	}).format(date);
	return `Publishing since ${month}`;
}

/** "1 listing" / "3 listings", and the same for followers. */
export function pluralCount(count: number, singular: string): string {
	const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
	return `${safe.toLocaleString()} ${safe === 1 ? singular : `${singular}s`}`;
}

export interface CreatorLink {
	href: string;
	kind: "website" | "github" | "x";
	label: string;
}

const GITHUB_HANDLE_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const X_HANDLE_RE = /^\w{1,15}$/;

/**
 * External profile links, rebuilt and re-validated on the client so a
 * malformed payload can never become a `javascript:` anchor.
 */
export function creatorLinks(
	creator: Pick<MarketplaceCreator, "githubHandle" | "website" | "xHandle">
): CreatorLink[] {
	const links: CreatorLink[] = [];
	if (creator.website) {
		try {
			const url = new URL(creator.website);
			if (url.protocol === "https:") {
				links.push({
					href: url.toString(),
					kind: "website",
					label: url.host.replace(/^www\./, ""),
				});
			}
		} catch {
			// Not a URL; render nothing rather than a broken link.
		}
	}
	if (creator.githubHandle && GITHUB_HANDLE_RE.test(creator.githubHandle)) {
		links.push({
			href: `https://github.com/${creator.githubHandle}`,
			kind: "github",
			label: creator.githubHandle,
		});
	}
	if (creator.xHandle && X_HANDLE_RE.test(creator.xHandle)) {
		links.push({
			href: `https://x.com/${creator.xHandle}`,
			kind: "x",
			label: `@${creator.xHandle}`,
		});
	}
	return links;
}

/** Filter a profile's listings to one kind; "all" keeps everything. */
export function filterListingsByKind<T extends { kind: string }>(
	listings: T[],
	kind: string
): T[] {
	return kind === "all"
		? listings
		: listings.filter((listing) => listing.kind === kind);
}
