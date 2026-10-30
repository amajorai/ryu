import { CheckmarkCircle02Icon, GridIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { MarketplaceAccessBadge } from "@ryu/ui/components/marketplace-access-badge.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useSvglIndex } from "@ryu/ui/components/svgl.ts";
import type { ReactNode } from "react";
import BrandOrCoverImage, {
	normalizeIconPadding,
} from "./chrome/brand-image.tsx";
import { RyuReviewedBadge } from "./chrome/ryu-reviewed-badge.tsx";
import VerifiedBadge from "./chrome/verified-badge.tsx";
import {
	ListingAsideCard,
	ListingHero,
	ListingInfoGrid,
} from "./detail/listing-detail-shell.tsx";
import { resolveCardIcon } from "./icon-url.ts";
import { displayRemixSource } from "./remix.ts";
import { safeHttpUrl } from "./safe-url.ts";
import type { CatalogEntry, PluginCatalogDetail } from "./types.ts";

/** One value cell in the Information table. Renders as a safe external link only
 *  when `href` is a valid http(s) URL; otherwise plain text. The label half is the
 *  shell's ({@link ListingInfoGrid}) — this is only the value, so every realm's
 *  rail lays its rows out identically. */
function InfoValue({ href, value }: { href?: string | null; value: string }) {
	const safeHref = safeHttpUrl(href);
	if (!safeHref) {
		return (
			<span className="truncate" title={value}>
				{value}
			</span>
		);
	}
	return (
		<a
			className="truncate hover:underline"
			href={safeHref}
			rel="noopener noreferrer"
			target="_blank"
		>
			{value}
		</a>
	);
}

/** The Information rows for a listing, as data. Rows come from `detail` (desktop)
 *  falling back to `entry` (present on every surface), so on the web host — where
 *  `detail` is null — it still shows Developer/Category/Version from the entry and
 *  simply omits the detail-only rows (homepage/license/privacy/terms). */
export function appInfoRows({
	detail,
	entry,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
}): { href?: string | null; label: string; value: string }[] {
	const version = entry.descriptor_only ? null : (entry.version ?? null);
	return [
		{
			label: "Developer",
			value:
				detail?.developer ??
				detail?.author ??
				entry.developer ??
				entry.author ??
				null,
		},
		{ label: "Category", value: detail?.category ?? entry.category ?? null },
		{ label: "Version", value: version },
		{ label: "License", value: detail?.license ?? entry.license ?? null },
		{
			label: "Remixed from",
			value: displayRemixSource(entry.remixed_from)?.id ?? null,
		},
		{
			label: "Remixing",
			value: entry.allow_remix === false ? "Not allowed by the author" : null,
		},
		{
			href:
				detail?.repositoryUrl ?? entry.repository_url ?? entry.repo_url ?? null,
			label: "Repository",
			value:
				detail?.repositoryUrl ?? entry.repository_url ?? entry.repo_url ?? null,
		},
		{
			href: detail?.website ?? entry.website ?? entry.homepage ?? null,
			label: "Website",
			value: detail?.website ?? entry.website ?? entry.homepage ?? null,
		},
		{
			href: detail?.privacyPolicyUrl ?? entry.privacy_policy_url ?? null,
			label: "Privacy Policy",
			value: detail?.privacyPolicyUrl ?? entry.privacy_policy_url ?? null,
		},
		{
			href: detail?.termsOfServiceUrl ?? entry.terms_of_service_url ?? null,
			label: "Terms of Service",
			value: detail?.termsOfServiceUrl ?? entry.terms_of_service_url ?? null,
		},
	].filter(
		(row): row is { href?: string | null; label: string; value: string } =>
			Boolean(row.value)
	);
}

/** "Information": the key/value table. Lives in the detail shell's RIGHT RAIL
 *  now rather than at the bottom of the Overview tab — "who made this, what
 *  licence, where is the privacy policy" is what a store visitor scans for before
 *  installing, and below permissions on a tall single column it was below the fold
 *  on every listing. */
export function AppInformationSection({
	detail,
	entry,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
}) {
	const rows = appInfoRows({ detail, entry });
	if (rows.length === 0) {
		return null;
	}
	return (
		<ListingAsideCard title="Information">
			<ListingInfoGrid
				rows={rows.map((row) => ({
					label: row.label,
					value: <InfoValue href={row.href} value={row.value} />,
				}))}
			/>
		</ListingAsideCard>
	);
}

/** The app detail hero. Thin wrapper over the shared {@link ListingHero}: this
 *  resolves the listing's ART (which is realm-specific — `icon`/`icon_url`/svgl
 *  brand marks) and the shell owns the LAYOUT (band height, scrim, icon tile,
 *  title stack, badge chips), so an app hero and an MCP hero cannot drift.
 *
 *  Always rendered, even for a listing with no presentation metadata: the band
 *  falls back to the muted surface, which is a header. It used to be omitted, and
 *  a listing without art opened with no header at all — the dialog started at a
 *  bare `<h2>` mid-air. */
export function AppHero({
	actions,
	badges,
	detail,
	entry,
	showArt,
	statusIcons,
	tagline,
}: {
	/** The primary CTA cluster, right-aligned on the title row — see
	 *  {@link ListingHero.actions}. */
	actions?: ReactNode;
	badges: string[];
	/** Status glyphs for the chip row — see {@link ListingHero.statusIcons}. */
	statusIcons?: ReactNode;
	/** The loaded detail payload, when there is one. Only its verification fields
	 *  are read here: the detail is the fuller, fresher record, so it wins over the
	 *  card's copy the same way the health scorecard resolves `reviewed`. */
	detail?: PluginCatalogDetail | null;
	entry: CatalogEntry;
	/** Resolved by the caller so the detail payload's tagline can win when the
	 *  card carries none. */
	tagline?: string | null;
	/** False for descriptor-only listings, whose `icon_*` fields describe the
	 *  UPSTREAM service rather than a Ryu package — painting them as a hero would
	 *  present a third-party brand as the listing's own art. */
	showArt: boolean;
}) {
	const svglIndex = useSvglIndex();
	// Raster logo for the hero: `icon_url` (any https host), an `svgl:` brand mark,
	// or a GitHub-image URL pasted into the `icon` field (the card's
	// {@link resolveCardIcon} rule, so hero and card never disagree).
	const {
		iconId: previewIconId,
		iconUrl: previewIconUrl,
		iconUrlDark: previewIconUrlDark,
		brand: isBrandMark,
	} = resolveCardIcon({
		icon: entry.icon,
		iconUrl: entry.icon_url,
		svglIndex,
	});
	// ORG verification (who published this — NOT the manifest-signature axis the web
	// marketplace calls `verified`) is read off ONE source, never mixed. The detail
	// payload is the fresher record so it wins whole once it carries the flag —
	// including a `false`, which is how a revoked check reaches an already-rendered
	// card. Pairing the detail's flag with the card's tier would let a stale
	// qualifier survive a re-tiering the newer record already reflects. An absent
	// flag (older control plane, or an enrichment failure — see `enrichmentError`)
	// falls back to the card wholesale, the same precedence the health scorecard
	// uses for `reviewed`.
	const detailKnowsOrgVerification = detail?.orgVerified !== undefined;
	const orgVerified = detailKnowsOrgVerification
		? detail?.orgVerified
		: entry.org_verified;
	const orgVerifiedTier = detailKnowsOrgVerification
		? detail?.orgVerifiedTier
		: entry.org_verified_tier;
	const publisherTrust = detailKnowsOrgVerification
		? detail?.publisherTrust
		: entry.publisher_trust;
	const publisherVerification = detailKnowsOrgVerification
		? detail?.publisherVerification
		: entry.publisher_verification;
	return (
		<ListingHero
			actions={actions}
			badges={badges}
			banner={showArt ? (detail?.banner ?? entry.banner) : null}
			dither={showArt ? entry.icon_dither : null}
			fallback={entry.accent_color ?? null}
			icon={
				previewIconUrl ? (
					<BrandOrCoverImage
						brand={isBrandMark === true}
						dark={previewIconUrlDark ?? null}
						light={previewIconUrl}
						padding={normalizeIconPadding(entry.icon_padding)}
					/>
				) : previewIconId ? (
					<Icon icon={previewIconId} size={34} />
				) : (
					<HugeiconsIcon className="size-8" icon={GridIcon} />
				)
			}
			iconBackground={entry.icon_background ?? null}
			iconPadding={entry.icon_padding}
			name={entry.name}
			nameBadge={
				// `tone="hero"` because every foreground in this band is fixed white over
				// an author-supplied wash under a black scrim — the card's themed
				// blue-on-tint chip would be unreadable here.
				<>
					<VerifiedBadge
						orgVerified={orgVerified}
						publisherTrust={publisherTrust}
						tier={orgVerifiedTier}
						tone="hero"
						verificationDetails={publisherVerification}
					/>
					<RyuReviewedBadge reviewed={entry.reviewed} tone="hero" />
					<MarketplaceAccessBadge
						membershipIncluded={Boolean(entry.membership_included)}
						tone="hero"
					/>
				</>
			}
			statusIcons={statusIcons}
			tagline={tagline}
		/>
	);
}

export function DescriptorDetail({
	detail,
	detailLoading,
	detailError,
	integrationUrl,
}: {
	detail: PluginCatalogDetail | null;
	detailLoading: boolean;
	detailError: string | null;
	integrationUrl: string | null;
}) {
	return (
		<section className="flex flex-col gap-3">
			<h3 className="font-medium text-sm">Integration details</h3>
			{detailLoading ? <Spinner className="size-4" /> : null}
			{detailError ? (
				<p className="text-sm text-status-destructive">{detailError}</p>
			) : null}
			{integrationUrl ? (
				<p className="break-all font-mono text-muted-foreground text-xs">
					{integrationUrl}
				</p>
			) : null}
			{detail?.domain ? (
				<p className="text-muted-foreground text-sm">
					Domain: <span className="text-foreground">{detail.domain}</span>
				</p>
			) : null}
			{detail?.feeds && detail.feeds.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{detail.feeds.map((feed) => (
						<Badge key={feed} variant="outline">
							{feed}
						</Badge>
					))}
				</div>
			) : null}
			<p className="text-muted-foreground text-sm">
				Descriptors are reference entries from integrations.sh — open the link
				to configure MCP, OpenAPI, or other surfaces in your agent stack.
			</p>
		</section>
	);
}

/** Status pill in the detail header: Enabled > Added > nothing. */
export function AppStatusBadge({
	enabled,
	installed,
}: {
	enabled: boolean;
	installed: boolean;
}) {
	if (enabled) {
		return (
			<Badge className="shrink-0" variant="secondary">
				<HugeiconsIcon
					className="size-3.5 text-status-success"
					icon={CheckmarkCircle02Icon}
				/>
				Enabled
			</Badge>
		);
	}
	if (installed) {
		return (
			<Badge className="shrink-0" variant="outline">
				Installed
			</Badge>
		);
	}
	return null;
}
