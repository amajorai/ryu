import { ArrowRight01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Spinner } from "@ryu/ui/components/spinner";
import type {
	StoreSearchGroup,
	StoreSearchItem,
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
	onOpenRealm,
}: {
	groups: StoreSearchGroup[];
	loading: boolean;
	isEmpty: boolean;
	/** Open a realm's tab, carrying the current query across as its initial search. */
	onOpenRealm: (realm: StoreSearchRealm) => void;
}) {
	if (loading && isEmpty) {
		return (
			<div className="flex h-full items-center justify-center text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
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
						No matches across Models, Skills, MCP, Plugins, or Agents. Try a
						different search.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}
	return (
		<div className="flex h-full flex-col gap-8 overflow-auto p-4">
			{groups.map((group) => (
				<ResultSection group={group} key={group.realm} onOpen={onOpenRealm} />
			))}
		</div>
	);
}

function ResultSection({
	group,
	onOpen,
}: {
	group: StoreSearchGroup;
	onOpen: (realm: StoreSearchRealm) => void;
}) {
	return (
		<section>
			<button
				className="mb-3 flex w-full items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
				onClick={() => onOpen(group.realm)}
				type="button"
			>
				<span className="font-semibold text-xs uppercase tracking-widest">
					{group.label}
				</span>
				<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
					{group.items.length}
				</span>
				<HugeiconsIcon className="size-3.5" icon={ArrowRight01Icon} />
			</button>
			<div className="grid grid-cols-2 gap-3">
				{group.items.map((item) => (
					<ResultCard
						item={item}
						key={item.id}
						onOpen={() => onOpen(group.realm)}
					/>
				))}
			</div>
		</section>
	);
}

function ResultCard({
	item,
	onOpen,
}: {
	item: StoreSearchItem;
	onOpen: () => void;
}) {
	return (
		<button
			className="flex flex-col gap-2 rounded-xl bg-card p-4 text-left transition-colors hover:border-foreground/30"
			onClick={onOpen}
			type="button"
		>
			<div className="flex items-center justify-between gap-2">
				<span className="truncate font-medium text-sm">{item.name}</span>
				{item.tag ? (
					<Badge className="shrink-0" variant="outline">
						{item.tag}
					</Badge>
				) : null}
			</div>
			{item.description ? (
				<p className="line-clamp-2 text-muted-foreground text-xs">
					{item.description}
				</p>
			) : null}
		</button>
	);
}
