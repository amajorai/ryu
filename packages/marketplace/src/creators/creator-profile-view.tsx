import {
	Alert02Icon,
	ArrowLeft01Icon,
	GithubIcon,
	Globe02Icon,
	NewTwitterIcon,
	Refresh01Icon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { EntityAvatar } from "@ryu/ui/components/entity-avatar.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { marketplaceBrowseKindLabel } from "../catalog/chrome/marketplace-sections.ts";
import StoreCatalogCard from "../catalog/chrome/store-catalog-card.tsx";
import { StoreCardGrid } from "../catalog/chrome/store-catalog-layout.tsx";
import VerifiedBadge from "../catalog/chrome/verified-badge.tsx";
import { errorMessage, isAbort } from "./creator-errors.ts";
import {
	type CreatorLink,
	creatorHandle,
	creatorLinks,
	creatorSinceLabel,
	filterListingsByKind,
	pluralCount,
} from "./creator-format.ts";
import type {
	MarketplaceCreator,
	MarketplaceCreatorListing,
	MarketplaceCreatorProfile,
	MarketplaceCreatorsService,
} from "./creator-types.ts";
import { CreatorGridSkeleton } from "./creators-directory.tsx";

export const LINK_ICONS = {
	github: GithubIcon,
	website: Globe02Icon,
	x: NewTwitterIcon,
} satisfies Record<CreatorLink["kind"], typeof Globe02Icon>;

export function CreatorProfileView({
	handle,
	onBack,
	service,
}: {
	handle: string;
	onBack: () => void;
	service: MarketplaceCreatorsService;
}) {
	const [profile, setProfile] = useState<MarketplaceCreatorProfile | null>(
		null
	);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [reloadKey, setReloadKey] = useState(0);
	const [kind, setKind] = useState("all");

	useEffect(() => {
		if (reloadKey < 0) {
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		service
			.get(handle, controller.signal)
			.then((next) => {
				setProfile(next);
				setError(null);
			})
			.catch((cause) => {
				if (!isAbort(cause)) {
					setError(errorMessage(cause, "Could not load this creator."));
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			});
		return () => controller.abort();
	}, [handle, reloadKey, service]);

	const back = (
		<Button className="self-start" onClick={onBack} size="sm" variant="ghost">
			<HugeiconsIcon aria-hidden="true" icon={ArrowLeft01Icon} />
			All creators
		</Button>
	);

	if (loading && !profile) {
		return (
			<div className="flex flex-col gap-4 py-2" role="status">
				{back}
				<span className="sr-only">Loading creator</span>
				<Skeleton className="h-40 w-full" radius="panel" />
				<CreatorGridSkeleton />
			</div>
		);
	}

	if (error || !profile) {
		return (
			<div className="flex flex-col gap-4 py-2">
				{back}
				<Empty appearance="bordered" className="min-h-64">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={error ? Alert02Icon : UserGroupIcon} />
						</EmptyMedia>
						<EmptyTitle>
							{error ? "Could not load this creator" : "Creator not found"}
						</EmptyTitle>
						<EmptyDescription>
							{error ??
								"This creator has no live public listings, or the link is out of date."}
						</EmptyDescription>
					</EmptyHeader>
					{error ? (
						<EmptyContent>
							<Button
								onClick={() => setReloadKey((key) => key + 1)}
								size="sm"
								variant="outline"
							>
								<HugeiconsIcon aria-hidden="true" icon={Refresh01Icon} />
								Try again
							</Button>
						</EmptyContent>
					) : null}
				</Empty>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-5 py-2">
			{back}
			<CreatorProfileHeader
				creator={profile.creator}
				follow={service.renderFollow?.(profile.creator)}
				listings={profile.listings}
			/>
			<CreatorListings
				kind={kind}
				listings={profile.listings}
				onKindChange={setKind}
				service={service}
			/>
		</div>
	);
}

export function CreatorProfileHeader({
	creator,
	follow,
	listings,
}: {
	creator: MarketplaceCreator;
	follow?: ReactNode;
	listings: MarketplaceCreatorListing[];
}) {
	const handle = creatorHandle(creator);
	const since = creatorSinceLabel(creator.firstPublishedAt);
	const links = creatorLinks(creator);
	const downloads = listings.reduce(
		(sum, listing) => sum + (listing.communityStats?.downloads ?? 0),
		0
	);
	const stats = [
		{ label: "Listings", value: formatCount(creator.listingCount) ?? "0" },
		{ label: "Followers", value: formatCount(creator.followerCount) ?? "0" },
		{
			label:
				creator.ratingCount > 0
					? `Rating (${pluralCount(creator.ratingCount, "review")})`
					: "Rating",
			value:
				creator.ratingCount > 0 ? creator.ratingAverage.toFixed(1) : "None",
		},
		{ label: "Downloads", value: formatCount(downloads) ?? "0" },
	];

	return (
		<header
			className="overflow-hidden rounded-xl border bg-card"
			data-testid="marketplace-creator-profile"
		>
			<div aria-hidden="true" className="h-24 bg-muted" />
			<div className="flex flex-col gap-4 px-5 pb-5">
				<div className="-mt-10 flex items-end justify-between gap-3">
					<EntityAvatar
						className="size-20"
						framing="profile-overlap"
						name={creator.name}
						seed={creator.id}
						src={creator.logo}
					/>
					{follow ? <div className="shrink-0">{follow}</div> : null}
				</div>
				<div className="flex flex-col gap-1">
					<div className="flex min-w-0 items-center gap-1.5">
						<h2 className="truncate font-semibold text-xl" title={creator.name}>
							{creator.name}
						</h2>
						<VerifiedBadge
							publisherTrust={creator.publisherTrust}
							verificationDetails={creator.publisherVerification}
						/>
					</div>
					<p className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-sm">
						{handle ? <span>{handle}</span> : null}
						{handle && since ? <span aria-hidden="true">·</span> : null}
						{since ? <span>{since}</span> : null}
					</p>
				</div>
				{creator.bio ? (
					<p className="max-w-2xl whitespace-pre-line text-sm">{creator.bio}</p>
				) : null}
				{links.length > 0 ? (
					<ul className="flex flex-wrap gap-x-4 gap-y-1">
						{links.map((link) => (
							<li key={link.kind}>
								<a
									className="inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
									href={link.href}
									rel="noopener noreferrer"
									target="_blank"
								>
									<HugeiconsIcon
										aria-hidden="true"
										className="size-4"
										icon={LINK_ICONS[link.kind]}
									/>
									{link.label}
								</a>
							</li>
						))}
					</ul>
				) : null}
				<dl className="grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-4">
					{stats.map((stat) => (
						<div key={stat.label}>
							<dt className="text-muted-foreground text-xs">{stat.label}</dt>
							<dd className="font-semibold text-lg tabular-nums">
								{stat.value}
							</dd>
						</div>
					))}
				</dl>
			</div>
		</header>
	);
}

export function CreatorListings({
	kind,
	listings,
	onKindChange,
	service,
}: {
	kind: string;
	listings: MarketplaceCreatorListing[];
	onKindChange: (kind: string) => void;
	service: MarketplaceCreatorsService;
}) {
	const kinds = useMemo(
		() => [...new Set(listings.map((listing) => listing.kind))].sort(),
		[listings]
	);
	const visible = filterListingsByKind(listings, kind);

	return (
		<section
			aria-labelledby="marketplace-creator-listings-heading"
			className="flex flex-col gap-3"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3
					className="font-semibold text-lg tracking-tight"
					id="marketplace-creator-listings-heading"
				>
					Listings
				</h3>
				{kinds.length > 1 ? (
					<fieldset className="flex flex-wrap gap-1">
						<legend className="sr-only">Filter listings by kind</legend>
						{["all", ...kinds].map((value) => (
							<Button
								aria-pressed={kind === value}
								key={value}
								onClick={() => onKindChange(value)}
								size="sm"
								variant={kind === value ? "secondary" : "ghost"}
							>
								{value === "all" ? "All" : marketplaceBrowseKindLabel(value)}
							</Button>
						))}
					</fieldset>
				) : null}
			</div>
			{visible.length === 0 ? (
				<p className="text-muted-foreground text-sm">No listings to show.</p>
			) : (
				<StoreCardGrid view="grid">
					{visible.map((listing) => (
						<StoreCatalogCard
							action={
								listing.priceLabel ? (
									<Badge variant="secondary">{listing.priceLabel}</Badge>
								) : undefined
							}
							communityStats={listing.communityStats ?? undefined}
							description={listing.description ?? undefined}
							href={service.listingHref?.(listing) ?? undefined}
							iconUrl={listing.iconUrl}
							key={`${listing.kind}:${listing.id}`}
							likeNamespace={listing.id}
							name={listing.name}
							onClick={
								service.openListing
									? () => service.openListing?.(listing)
									: undefined
							}
							seedId={listing.id}
						/>
					))}
				</StoreCardGrid>
			)}
		</section>
	);
}
