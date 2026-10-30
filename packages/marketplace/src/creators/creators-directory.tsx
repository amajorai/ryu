import {
	Alert02Icon,
	Refresh01Icon,
	Search01Icon,
	StarIcon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
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
import { type ReactNode, useEffect, useState } from "react";
import VerifiedBadge from "../catalog/chrome/verified-badge.tsx";
import { errorMessage, isAbort, SEARCH_DEBOUNCE_MS } from "./creator-errors.ts";
import { creatorHandle, creatorKindSummary } from "./creator-format.ts";
import {
	MARKETPLACE_CREATOR_SORTS,
	type MarketplaceCreator,
	type MarketplaceCreatorSort,
	type MarketplaceCreatorsService,
} from "./creator-types.ts";

export function CreatorsDirectory({
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

export function CreatorGridSkeleton() {
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

export function CreatorStat({
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

export function RatingStat({ creator }: { creator: MarketplaceCreator }) {
	const tl = useLiteralMessages();
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
				{tl(
					"average rating from {count, plural, one {{formatted} review} other {{formatted} reviews}}",
					{
						count: creator.ratingCount,
						formatted: creator.ratingCount.toLocaleString(),
					}
				)}
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
	const tl = useLiteralMessages();
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
					{tl("Publishes {kinds}", {
						kinds: creatorKindSummary(creator.kinds, 3),
					})}
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
