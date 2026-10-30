import { ArrowRight01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import { StoreCardGrid } from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type {
	StoreSearchGroup,
	StoreSearchRealm,
} from "@/src/hooks/useStoreSearch.ts";

/**
 * Aggregated result view for the Store's store-wide search. Renders one section
 * per realm (Models, Skills, MCP, …) with a header and a grid of compact cards.
 * The aggregated view is a router, not an installer: clicking a card (or a
 * section header) opens that realm's own tab with the query carried over, where
 * the real detail + install flow lives — so no install logic is duplicated here.
 */
export default function StoreSearchResults({
	groups,
	loading,
	isEmpty,
	onClearSearch,
	onOpenRealm,
}: {
	groups: StoreSearchGroup[];
	loading: boolean;
	isEmpty: boolean;
	onClearSearch: () => void;
	/** Open a realm's tab, carrying the current query across as its initial
	 *  search; with an item id the realm opens on that item. */
	onOpenRealm: (realm: StoreSearchRealm, itemId?: string) => void;
}) {
	if (loading && isEmpty) {
		return <SkeletonRows rows={6} spacing="library" />;
	}
	if (isEmpty) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={Search01Icon} />
					</EmptyMedia>
					<EmptyTitle>Nothing found</EmptyTitle>
					<EmptyDescription>
						Nothing across the Store matches. Try a different search.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onClearSearch} size="sm" variant="outline">
						Clear search
					</Button>
				</EmptyContent>
			</Empty>
		);
	}
	return (
		<div className="scroll-fade h-full overflow-auto">
			<div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pt-2 pb-12">
				{groups.map((group) => (
					<ResultSection group={group} key={group.realm} onOpen={onOpenRealm} />
				))}
			</div>
		</div>
	);
}

function ResultSection({
	group,
	onOpen,
}: {
	group: StoreSearchGroup;
	onOpen: (realm: StoreSearchRealm, itemId?: string) => void;
}) {
	return (
		<section>
			<button
				className="group mb-2 flex items-center gap-2 text-left"
				onClick={() => onOpen(group.realm)}
				type="button"
			>
				<span className="font-semibold text-sm">{group.label}</span>
				<span className="text-muted-foreground/70 text-xs tabular-nums">
					{formatCount(group.items.length) ?? "—"}
				</span>
				<HugeiconsIcon
					className="size-4 text-muted-foreground transition-transform duration-(--duration-fast) group-hover:translate-x-0.5"
					icon={ArrowRight01Icon}
				/>
			</button>
			<StoreCardGrid>
				{group.items.map((item) => (
					<StoreCatalogCard
						description={item.description ?? item.tag ?? undefined}
						key={item.id}
						name={item.name}
						onClick={() => onOpen(group.realm, item.id)}
						seedId={item.id}
					/>
				))}
			</StoreCardGrid>
		</section>
	);
}
