"use client";

import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComponentProps } from "react";
import type {
	NormalizedRecommendations,
	RecommendationItem,
} from "../recommendations.ts";
import ForYouSection from "./for-you-section.tsx";
import {
	MARKETPLACE_HOME_SHELVES,
	type MarketplaceHomeShelfKey,
	marketplaceHomeShelfDefinition,
} from "./marketplace-sections.ts";
import StoreCatalogCard from "./store-catalog-card.tsx";
import { StoreCardGrid } from "./store-catalog-layout.tsx";
import StoreShelfHeading from "./store-shelf-heading.tsx";

const HOME_SHELF_LIMIT = 6;

/** A host-neutral item adapter. The renderer below owns the card; hosts only
 * provide the item data and the action/link that is valid on that surface. */
export type MarketplaceHomeItem = ComponentProps<typeof StoreCatalogCard> & {
	id: string;
};

export interface MarketplaceHomeShelf {
	emptyLabel?: string;
	items: MarketplaceHomeItem[];
	key: MarketplaceHomeShelfKey;
	loading?: boolean;
	onSeeAll?: () => void;
	title?: string;
}

export interface MarketplaceHomeRecommendations {
	data: NormalizedRecommendations;
	hrefFor?: (item: RecommendationItem) => string;
	loading?: boolean;
	onCadenceChange?: (cadence: NormalizedRecommendations["cadence"]) => void;
	onHide?: () => void;
	onOpen?: (item: RecommendationItem) => void;
	onReenable?: () => void;
	onRefresh?: () => void;
}

/**
 * Shared Marketplace landing page. Keeping the shelf stack here makes the
 * web/desktop home DOM identical while leaving install, preview, and navigation
 * decisions in the platform adapters. A host may override a shelf's title and
 * empty copy when its data source has a different user-facing noun, such as the
 * web's published Agent Templates versus the desktop ACP Agents catalog.
 */
export default function MarketplaceHome({
	className,
	failed = false,
	hideEmptyShelves = false,
	loading = false,
	onRetry,
	recommendations,
	shelves,
}: {
	className?: string;
	/** The host's shelf feeds failed to load. With nothing to show, Home then says
	 * so (and offers `onRetry`) instead of implying the store is empty. */
	failed?: boolean;
	/** Drop shelves that finished loading with no items. Off by default so the
	 * desktop keeps every canonical shelf mounted; the public web opts in so a
	 * signed-out visitor never sees a stack of empty placeholders. */
	hideEmptyShelves?: boolean;
	loading?: boolean;
	onRetry?: () => void;
	recommendations: MarketplaceHomeRecommendations;
	shelves: MarketplaceHomeShelf[];
}) {
	const shelvesByKey = new Map(shelves.map((shelf) => [shelf.key, shelf]));
	// Every host supplies data, never layout. By default missing/empty data still
	// leaves the canonical shelf mounted, so a failed or signed-out feed cannot
	// make Home change shape on one surface but not the other. A host may opt out
	// with `hideEmptyShelves`, which drops shelves that loaded with no items.
	const canonicalShelves = MARKETPLACE_HOME_SHELVES.map(
		(definition) =>
			shelvesByKey.get(definition.key) ?? {
				items: [],
				key: definition.key,
				loading,
			}
	);
	const orderedShelves = hideEmptyShelves
		? canonicalShelves.filter(
				(shelf) => shelf.loading || shelf.items.length > 0
			)
		: canonicalShelves;

	return (
		<div
			className={cn("scroll-fade h-full overflow-auto", className)}
			data-slot="marketplace-home"
		>
			<div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pt-2 pb-12">
				<ForYouSection {...recommendations} />
				{orderedShelves.map((shelf) => (
					<MarketplaceHomeShelfView key={shelf.key} shelf={shelf} />
				))}
				{orderedShelves.length === 0 && failed ? (
					<Empty data-slot="marketplace-home-error" spacing="snug">
						<EmptyHeader>
							<EmptyTitle>Couldn't load the Marketplace</EmptyTitle>
							<EmptyDescription>
								{onRetry ? (
									<button
										className="font-medium text-foreground underline-offset-4 hover:underline"
										onClick={onRetry}
										type="button"
									>
										Try again →
									</button>
								) : (
									"Reload the page, or browse a category above."
								)}
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : null}
				{orderedShelves.length === 0 && !failed ? (
					<Empty data-slot="marketplace-home-empty" spacing="snug">
						<EmptyHeader>
							<EmptyTitle>Nothing to show here yet</EmptyTitle>
							<EmptyDescription>Browse a category above.</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : null}
			</div>
		</div>
	);
}

function MarketplaceHomeShelfView({ shelf }: { shelf: MarketplaceHomeShelf }) {
	const definition = marketplaceHomeShelfDefinition(shelf.key);
	return (
		<section data-slot="marketplace-home-shelf">
			<StoreShelfHeading
				action={
					shelf.onSeeAll ? (
						<span className="text-muted-foreground text-xs transition-colors group-hover:text-foreground">
							See all
						</span>
					) : undefined
				}
				className="px-0"
				onOpen={shelf.onSeeAll}
			>
				{shelf.title ?? definition.title}
			</StoreShelfHeading>
			{shelf.items.length > 0 ? (
				<StoreCardGrid>
					{shelf.items.slice(0, HOME_SHELF_LIMIT).map((item) => (
						<StoreCatalogCard {...item} key={item.id} />
					))}
				</StoreCardGrid>
			) : null}
			{shelf.items.length === 0 && shelf.loading ? (
				<div aria-busy="true" data-slot="marketplace-home-loading">
					<StoreCardGrid>
						<Skeleton className="h-20" radius="row" />
						<Skeleton className="h-20" radius="row" />
					</StoreCardGrid>
				</div>
			) : null}
			{shelf.items.length === 0 && !shelf.loading ? (
				<div
					className="flex min-h-16 items-center justify-center rounded-lg border border-dashed px-4 text-muted-foreground text-sm"
					data-slot="marketplace-home-empty"
				>
					<span>{shelf.emptyLabel ?? definition.emptyLabel}</span>
				</div>
			) : null}
		</section>
	);
}
