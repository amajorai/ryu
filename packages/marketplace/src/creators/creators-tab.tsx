// packages/marketplace/src/creators/creators-tab.tsx
//
// The Marketplace Creators tab: a directory of publishing organizations and a
// profile page for each one. Surface-agnostic like the money-layer tabs: the
// reads, the follow control, and listing navigation come from the injected
// `MarketplaceHost.creators` service, so web and desktop render the same UI.

import {
	Alert02Icon,
	ArrowLeft01Icon,
	GithubIcon,
	Globe02Icon,
	NewTwitterIcon,
	Refresh01Icon,
	Search01Icon,
	StarIcon,
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
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { marketplaceBrowseKindLabel } from "../catalog/chrome/marketplace-sections.ts";
import StoreCatalogCard from "../catalog/chrome/store-catalog-card.tsx";
import { StoreCardGrid } from "../catalog/chrome/store-catalog-layout.tsx";
import VerifiedBadge from "../catalog/chrome/verified-badge.tsx";
import { useMarketplaceHostOptional } from "../host.tsx";
import {
	type CreatorLink,
	creatorHandle,
	creatorKindSummary,
	creatorLinks,
	creatorRouteHandle,
	creatorSinceLabel,
	filterListingsByKind,
	pluralCount,
} from "./creator-format.ts";
import {
	MARKETPLACE_CREATOR_SORTS,
	type MarketplaceCreator,
	type MarketplaceCreatorListing,
	type MarketplaceCreatorProfile,
	type MarketplaceCreatorSort,
	type MarketplaceCreatorsService,
} from "./creator-types.ts";

const SEARCH_DEBOUNCE_MS = 250;

// Rejections arrive unchanged from the native Promise catch callback.
type CreatorServiceRejection = Parameters<
	NonNullable<Parameters<Promise<void>["catch"]>[0]>
>[0];

function errorMessage(
	cause: CreatorServiceRejection,
	fallback: string
): string {
	return cause instanceof Error && cause.message ? cause.message : fallback;
}

function isAbort(cause: CreatorServiceRejection): boolean {
	return cause instanceof DOMException && cause.name === "AbortError";
}

/**
 * The Creators tab. `handle` / `onHandleChange` let a surface own the open
 * profile (the web mirrors it into the URL); left uncontrolled, the tab keeps
 * it in local state. `onOpenListing` overrides the host's listing navigation
 * for a surface whose navigation lives in the page rather than the host.
 */
export function CreatorsTab({
	handle,
	onHandleChange,
	onOpenListing,
}: {
	handle?: string | null;
	onHandleChange?: (handle: string | null) => void;
	onOpenListing?: (listing: MarketplaceCreatorListing) => void;
}) {
	const hostService = useMarketplaceHostOptional()?.creators;
	const service = useMemo(
		() =>
			hostService && onOpenListing
				? { ...hostService, openListing: onOpenListing }
				: hostService,
		[hostService, onOpenListing]
	);
	const [localHandle, setLocalHandle] = useState<string | null>(null);
	const openHandle = handle === undefined ? localHandle : handle;
	const setOpenHandle = useCallback(
		(next: string | null) => {
			setLocalHandle(next);
			onHandleChange?.(next);
		},
		[onHandleChange]
	);

	if (!service) {
		return (
			<Empty appearance="bordered" className="min-h-64">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={UserGroupIcon} />
					</EmptyMedia>
					<EmptyTitle>Creators are not available here</EmptyTitle>
					<EmptyDescription>
						Sign in to a Ryu account to browse Marketplace creators.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	if (openHandle) {
		return (
			<CreatorProfileView
				handle={openHandle}
				key={openHandle}
				onBack={() => setOpenHandle(null)}
				service={service}
			/>
		);
	}
	return (
		<CreatorsDirectory
			onOpen={(creator) => setOpenHandle(creatorRouteHandle(creator))}
			service={service}
		/>
	);
}

function CreatorsDirectory({
	onOpen,
	service,
}: {
	onOpen: (creator: MarketplaceCreator) => void;
	service: MarketplaceCreatorsService;
}) {
	const [query, setQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [sort, setSort] = useState<MarketplaceCreatorSort>("popular");
	const [creators, setCreators] = useState<MarketplaceCreator[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		const timer = setTimeout(
			() => setDebouncedQuery(query.trim()),
			SEARCH_DEBOUNCE_MS
		);
		return () => clearTimeout(timer);
	}, [query]);

	useEffect(() => {
		// `reloadKey` only exists to re-run this effect from "Try again".
		if (reloadKey < 0) {
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		service
			.list({ query: debouncedQuery, signal: controller.signal, sort })
			.then((next) => {
				setCreators(next);
				setError(null);
			})
			.catch((cause) => {
				if (!isAbort(cause)) {
					setError(errorMessage(cause, "Could not load creators."));
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			});
		return () => controller.abort();
	}, [debouncedQuery, reloadKey, service, sort]);

	return (
		<section
			aria-labelledby="marketplace-creators-heading"
			className="flex flex-col gap-5 py-2"
			data-testid="marketplace-creators"
		>
			<div className="flex flex-col gap-1">
				<h2 className="font-medium text-lg" id="marketplace-creators-heading">
					Creators
				</h2>
				<p className="max-w-2xl text-muted-foreground text-sm">
					The people and teams publishing agents, skills, and apps on Ryu.
					Follow a creator to filter the Marketplace to their work.
				</p>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-48 flex-1">
					<HugeiconsIcon
						aria-hidden="true"
						className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						icon={Search01Icon}
					/>
					<Input
						aria-label="Search creators"
						leadingAdornment="default"
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search creators"
						type="search"
						value={query}
					/>
				</div>
				<NativeSelect
					aria-label="Sort creators"
					onChange={(event) => {
						const selectedValue = event.target.value;
						const selectedSort = MARKETPLACE_CREATOR_SORTS.find(
							(option) => option.value === selectedValue
						);
						if (!selectedSort) {
							throw new Error("Unsupported creator sort");
						}
						setSort(selectedSort.value);
					}}
					value={sort}
				>
					{MARKETPLACE_CREATOR_SORTS.map((option) => (
						<NativeSelectOption key={option.value} value={option.value}>
							{option.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>

			{error ? (
				<div
					aria-live="polite"
					className="flex items-center gap-3 text-sm text-status-destructive"
				>
					<HugeiconsIcon aria-hidden="true" icon={Alert02Icon} />
					<span>{error}</span>
					<Button
						onClick={() => setReloadKey((key) => key + 1)}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon aria-hidden="true" icon={Refresh01Icon} />
						Try again
					</Button>
				</div>
			) : null}

			{loading && creators.length === 0 ? (
				<CreatorGridSkeleton />
			) : creators.length === 0 && !error ? (
				<Empty appearance="bordered" className="min-h-48">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<HugeiconsIcon icon={UserGroupIcon} />
						</EmptyMedia>
						<EmptyTitle>
							{debouncedQuery ? "No matching creators" : "No creators yet"}
						</EmptyTitle>
						<EmptyDescription>
							{debouncedQuery
								? "Try a different name or handle."
								: "Creators appear here once they have a live public listing."}
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<ul
					aria-busy={loading}
					className={cn(
						"grid grid-cols-1 gap-3 sm:grid-cols-2",
						loading && "opacity-60"
					)}
				>
					{creators.map((creator) => (
						<li key={creator.id}>
							<CreatorCard
								creator={creator}
								follow={service.renderFollow?.(creator)}
								onOpen={() => onOpen(creator)}
							/>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function CreatorGridSkeleton() {
	return (
		<div
			aria-label="Loading creators"
			className="grid grid-cols-1 gap-3 sm:grid-cols-2"
			role="status"
		>
			{["a", "b", "c", "d"].map((key) => (
				<div className="flex flex-col gap-3 rounded-xl border p-4" key={key}>
					<div className="flex items-center gap-3">
						<Skeleton className="size-12" radius="pill" />
						<div className="flex flex-1 flex-col gap-2">
							<Skeleton className="h-4 w-32" />
							<Skeleton className="h-3 w-20" />
						</div>
					</div>
					<Skeleton className="h-3 w-full" />
					<Skeleton className="h-3 w-2/3" />
				</div>
			))}
		</div>
	);
}

function CreatorStat({
	label,
	value,
}: {
	label: string;
	value: string | null;
}) {
	if (!value) {
		return null;
	}
	return (
		<span className="text-muted-foreground text-xs">
			<span className="font-medium text-foreground tabular-nums">{value}</span>{" "}
			{label}
		</span>
	);
}

function RatingStat({ creator }: { creator: MarketplaceCreator }) {
	if (creator.ratingCount <= 0) {
		return null;
	}
	return (
		<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
			<HugeiconsIcon
				aria-hidden="true"
				className="size-3.5 text-status-warning"
				icon={StarIcon}
			/>
			<span className="font-medium text-foreground tabular-nums">
				{creator.ratingAverage.toFixed(1)}
			</span>
			<span className="sr-only">
				average rating from {pluralCount(creator.ratingCount, "review")}
			</span>
		</span>
	);
}

/** One creator in the directory. The whole card opens the profile; the follow
 *  control sits above the card's stretched button so it stays independent. */
export function CreatorCard({
	creator,
	follow,
	onOpen,
}: {
	creator: MarketplaceCreator;
	follow?: ReactNode;
	onOpen: () => void;
}) {
	const handle = creatorHandle(creator);
	return (
		<article
			className="relative flex h-full flex-col gap-3 rounded-xl border bg-card p-4 transition-colors focus-within:border-ring hover:bg-accent/40"
			data-testid="marketplace-creator-card"
		>
			<div className="flex items-start gap-3">
				<EntityAvatar
					className="size-12"
					name={creator.name}
					seed={creator.id}
					src={creator.logo}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-1">
						<h3 className="truncate font-medium">
							<button
								className="text-left outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-3 focus-visible:after:ring-ring/30"
								onClick={onOpen}
								type="button"
							>
								{creator.name}
							</button>
						</h3>
						<span className="relative z-10 inline-flex">
							<VerifiedBadge
								publisherTrust={creator.publisherTrust}
								verificationDetails={creator.publisherVerification}
							/>
						</span>
					</div>
					{handle ? (
						<p
							className="truncate text-muted-foreground text-xs"
							title={handle}
						>
							{handle}
						</p>
					) : null}
				</div>
				{follow ? <div className="relative z-10 shrink-0">{follow}</div> : null}
			</div>

			{creator.bio ? (
				<p className="line-clamp-2 text-muted-foreground text-sm">
					{creator.bio}
				</p>
			) : creator.kinds.length > 0 ? (
				<p className="line-clamp-2 text-muted-foreground text-sm">
					Publishes {creatorKindSummary(creator.kinds, 3)}
				</p>
			) : null}

			<div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1">
				<CreatorStat
					label={creator.listingCount === 1 ? "listing" : "listings"}
					value={formatCount(creator.listingCount)}
				/>
				<CreatorStat
					label={creator.followerCount === 1 ? "follower" : "followers"}
					value={formatCount(creator.followerCount)}
				/>
				<RatingStat creator={creator} />
			</div>
		</article>
	);
}

const LINK_ICONS = {
	github: GithubIcon,
	website: Globe02Icon,
	x: NewTwitterIcon,
} satisfies Record<CreatorLink["kind"], typeof Globe02Icon>;

function CreatorProfileView({
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

function CreatorProfileHeader({
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
			<div
				aria-hidden="true"
				className="h-24 bg-gradient-to-r from-primary/25 via-primary/10 to-muted"
			/>
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

function CreatorListings({
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
					className="font-medium text-base"
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
