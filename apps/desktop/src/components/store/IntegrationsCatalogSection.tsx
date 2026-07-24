// apps/desktop/src/components/store/IntegrationsCatalogSection.tsx
//
// The Integrations Store tab: a brand-first front door. One card per service
// (Notion, Slack, GitHub, …), merged by Core from the integrations.sh directory
// and Composio's toolkit catalog. Selecting a brand opens a preview that gathers
// everything which connects to it — Skills, MCP servers, Plugins, Agents — by
// running the store-wide search for the brand name and grouping the hits per
// realm, each with a "See all" jump into that realm's own tab (pre-filtered).
//
// There is no install control here: a brand is a pointer, not an installable
// unit; you install the related Skill/MCP/Plugin from its own row's tab.

import { ArrowRight01Icon, LinkSquare01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import InfiniteSentinel from "@ryu/marketplace/catalog/chrome/infinite-sentinel";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { REALM_ICONS } from "@ryu/marketplace/catalog/realm-icons";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Spinner } from "@ryu/ui/components/spinner";
import { useState } from "react";
import { useIntegrationsCatalog } from "@/src/hooks/useIntegrationsCatalog.ts";
import {
	type StoreSearchRealm,
	useStoreSearch,
} from "@/src/hooks/useStoreSearch.ts";
import type { IntegrationBrand } from "@/src/lib/api/integrations.ts";

/** Which catalog surfaced a brand, as a small chip on the preview. */
const SOURCE_LABELS: Record<string, string> = {
	directory: "Directory",
	composio: "Composio",
};

/** Directory feed tokens that name a real connection KIND (the rest — provider
 *  tags like "claude"/"openai", meta like "discovered" — are noise we drop).
 *  `api`/`openapi` both fold to "API" so the chip set reads clean. */
const FEED_LABELS: Record<string, string> = {
	mcp: "MCP",
	api: "API",
	openapi: "API",
	graphql: "GraphQL",
	cli: "CLI",
	rest: "REST",
};

/** The distinct connection kinds a brand offers directly, per the directory. */
function connectionKinds(feeds: string[]): string[] {
	const seen = new Set<string>();
	for (const feed of feeds) {
		const label = FEED_LABELS[feed.toLowerCase()];
		if (label) {
			seen.add(label);
		}
	}
	return [...seen];
}

export default function IntegrationsCatalogSection({
	initialQuery = "",
	onOpenRealm,
}: {
	initialQuery?: string;
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
}) {
	const {
		integrations,
		loading,
		error,
		fetchNextPage,
		hasNextPage,
		loadingMore,
		query,
		setQuery,
	} = useIntegrationsCatalog(initialQuery);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = integrations.find((it) => it.id === selectedId) ?? null;

	return (
		<StoreCatalogLayout
			detail={
				selected ? (
					<IntegrationDetailPanel brand={selected} onOpenRealm={onOpenRealm} />
				) : null
			}
			detailTitle={selected?.name ?? "Integration"}
			hasSelection={selected != null}
			list={
				<IntegrationList
					error={error}
					fetchNextPage={fetchNextPage}
					hasNextPage={hasNextPage}
					integrations={integrations}
					loading={loading}
					loadingMore={loadingMore}
					onSelect={setSelectedId}
					selectedId={selectedId}
				/>
			}
			onCloseDetail={() => setSelectedId(null)}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search integrations (Notion, Slack, GitHub…)",
			}}
		/>
	);
}

function IntegrationList({
	integrations,
	loading,
	loadingMore,
	error,
	fetchNextPage,
	hasNextPage,
	selectedId,
	onSelect,
}: {
	integrations: IntegrationBrand[];
	loading: boolean;
	loadingMore: boolean;
	error: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	if (error) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon className="size-5" icon={REALM_ICONS.plugins} />
					</EmptyMedia>
					<EmptyTitle>Couldn't load integrations</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	if (loading && integrations.length === 0) {
		return (
			<div className="flex h-40 items-center justify-center">
				<Spinner className="size-5" />
			</div>
		);
	}

	if (integrations.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon className="size-5" icon={REALM_ICONS.plugins} />
					</EmptyMedia>
					<EmptyTitle>No integrations found</EmptyTitle>
					<EmptyDescription>Try a different service name.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div>
			<StoreCardGrid>
				{integrations.map((it) => (
					<StoreCatalogCard
						action={null}
						description={
							it.categories.length > 0
								? it.categories.slice(0, 2).join(" · ")
								: (it.domain ?? null)
						}
						icon={
							<HugeiconsIcon className="size-5" icon={REALM_ICONS.plugins} />
						}
						iconUrl={it.logo}
						key={it.id}
						name={it.name}
						onClick={() => onSelect(it.id)}
						seedId={it.id}
						selected={it.id === selectedId}
					/>
				))}
			</StoreCardGrid>
			<InfiniteSentinel
				hasMore={hasNextPage}
				loading={loadingMore}
				onLoadMore={fetchNextPage}
			/>
		</div>
	);
}

/** The brand preview: a header (logo, name, categories, source chips, site link)
 *  over stacked "related X" sections gathered by the store-wide search. */
function IntegrationDetailPanel({
	brand,
	onOpenRealm,
}: {
	brand: IntegrationBrand;
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
}) {
	// Search every realm for the brand name; the hook takes the query reactively
	// (debounced + cached), so selecting a different brand refetches on its own.
	const { groups, loading, isEmpty, hasQuery } = useStoreSearch(brand.name);
	const directoryKinds = connectionKinds(brand.feeds);

	return (
		<div className="flex flex-col gap-5 p-4">
			<div className="flex items-start gap-3">
				<span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted">
					{brand.logo ? (
						<img
							alt=""
							className="size-full object-cover"
							loading="lazy"
							src={brand.logo}
						/>
					) : (
						<HugeiconsIcon className="size-6" icon={REALM_ICONS.plugins} />
					)}
				</span>
				<div className="min-w-0 flex-1">
					<div className="truncate font-semibold text-lg">{brand.name}</div>
					{brand.description ? (
						<p className="mt-0.5 text-muted-foreground text-sm">
							{brand.description}
						</p>
					) : null}
					<div className="mt-2 flex flex-wrap items-center gap-1.5">
						{brand.sources.map((s) => (
							<Badge key={s} variant="secondary">
								{SOURCE_LABELS[s] ?? s}
							</Badge>
						))}
						{brand.categories.slice(0, 3).map((c) => (
							<Badge key={c} variant="outline">
								{c}
							</Badge>
						))}
					</div>
				</div>
			</div>

			{brand.domain ? (
				<a
					className="inline-flex w-fit items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
					href={`https://${brand.domain}`}
					rel="noopener noreferrer"
					target="_blank"
				>
					<HugeiconsIcon className="size-4" icon={LinkSquare01Icon} />
					{brand.domain}
				</a>
			) : null}

			{/* The directory's own info: which connection kinds this service offers
			    directly (from the integrations.sh feeds). Kept separate from the
			    "Related in the catalog" block below so the two never blur together. */}
			{directoryKinds.length > 0 ? (
				<div className="flex flex-col gap-1.5">
					<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Available connections
					</span>
					<div className="flex flex-wrap items-center gap-1.5">
						{directoryKinds.map((kind) => (
							<Badge key={kind} variant="secondary">
								{kind}
							</Badge>
						))}
					</div>
				</div>
			) : null}

			<div className="flex flex-col gap-4">
				<p className="font-medium text-sm">Related in the catalog</p>
				{loading ? (
					<div className="flex h-20 items-center justify-center">
						<Spinner className="size-5" />
					</div>
				) : null}
				{!loading && hasQuery && isEmpty ? (
					<p className="text-muted-foreground text-sm">
						Nothing in the catalog references {brand.name} yet.
					</p>
				) : null}
				{groups.map((group) => (
					<RelatedRealmSection
						brandName={brand.name}
						group={group}
						key={group.realm}
						onOpenRealm={onOpenRealm}
					/>
				))}
			</div>
		</div>
	);
}

/** One "related X" block: the realm's top hits for the brand + a jump to its tab. */
function RelatedRealmSection({
	group,
	brandName,
	onOpenRealm,
}: {
	group: ReturnType<typeof useStoreSearch>["groups"][number];
	brandName: string;
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between">
				<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					Related {group.label}
				</span>
				<Button
					className="h-6 gap-1 px-1.5 text-xs"
					onClick={() => onOpenRealm(group.realm, brandName)}
					size="sm"
					variant="ghost"
				>
					See all
					<HugeiconsIcon className="size-3.5" icon={ArrowRight01Icon} />
				</Button>
			</div>
			<div className="flex flex-col gap-0.5">
				{group.items.map((item) => (
					<button
						className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
						key={item.id}
						onClick={() => onOpenRealm(group.realm, brandName)}
						type="button"
					>
						<span className="min-w-0 flex-1">
							<span className="block truncate font-medium text-sm">
								{item.name}
							</span>
							{item.description ? (
								<span className="block truncate text-muted-foreground text-xs">
									{item.description}
								</span>
							) : null}
						</span>
						{item.tag ? (
							<Badge className="shrink-0" variant="outline">
								{item.tag}
							</Badge>
						) : null}
					</button>
				))}
			</div>
		</div>
	);
}
