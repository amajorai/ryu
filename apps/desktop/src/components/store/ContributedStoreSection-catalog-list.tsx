import type { StoreCatalogItem, StoreTabSpec } from "@ryu/app-host/views";
import {
	STORE_LOAD_ERROR_SENTENCE,
	StoreErrorDetails,
} from "@ryu/blocks/desktop/store-error-details.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import { StoreCardGrid } from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction, {
	storeItemContextMenu,
} from "@ryu/marketplace/catalog/chrome/store-item-action";
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
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";
import { TabIcon } from "./ContributedStoreSection-tab-icon.tsx";

/** Card-level add affordance — same rule as the detail pane's, and the same
 *  verb: a spec that calls its action "Use" must not say "Add" on the card and
 *  "Use" in the detail pane for the same item. `StoreItemAction` hardcodes
 *  "Add", so a declared label takes the plain button instead. */
function CardAction({
	installed,
	busy,
	label,
	onInstall,
}: {
	busy: boolean;
	installed: boolean;
	label?: string;
	onInstall: () => void;
}) {
	if (installed) {
		return (
			<Button disabled size="sm" variant="secondary">
				Added
			</Button>
		);
	}
	if (label && label !== "Add" && label !== "Install") {
		return (
			<Button disabled={busy} onClick={onInstall} size="sm" variant="ghost">
				{label}
			</Button>
		);
	}
	return (
		<StoreItemAction busy={busy} installed={false} onInstall={onInstall} />
	);
}

export function CatalogList({
	tab,
	spec,
	groups,
	total,
	loading,
	error,
	selectedId,
	pendingId,
	isInstalled,
	onSelect,
	onInstall,
	onClearSearch,
	onRetry,
}: {
	error: string | null;
	groups: { items: StoreCatalogItem[]; label: string; value: string }[];
	isInstalled: (item: StoreCatalogItem) => boolean;
	loading: boolean;
	onInstall: (item: StoreCatalogItem) => void;
	onClearSearch: () => void;
	onSelect: (id: string) => void;
	onRetry: () => void;
	pendingId: string | null;
	selectedId: string | null;
	spec: StoreTabSpec;
	tab: PluginStoreTab;
	total: number;
}) {
	const tl = useLiteralMessages();
	if (loading && total === 0) {
		return <SkeletonRows inset="catalog" />;
	}
	if (error && total === 0) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<TabIcon icon={tab.icon} />
					</EmptyMedia>
					<EmptyTitle>
						{tl("Couldn't load {title}", { title: tab.title })}
					</EmptyTitle>
					<EmptyDescription>{STORE_LOAD_ERROR_SENTENCE}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onRetry} size="sm" variant="outline">
						Try again
					</Button>
					<StoreErrorDetails message={error} />
				</EmptyContent>
			</Empty>
		);
	}
	if (total === 0) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<TabIcon icon={tab.icon} />
					</EmptyMedia>
					<EmptyTitle>{spec.empty?.title ?? "Nothing found"}</EmptyTitle>
					<EmptyDescription>
						{spec.empty?.description ?? "Try a different search."}
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onClearSearch} size="sm" variant="ghost">
						Clear search
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<div>
			{groups.map((group) => (
				<section className="mb-6" key={group.value || "all"}>
					{group.label ? (
						<h3 className="mb-2 px-1 text-detail text-muted-foreground">
							{group.label}
						</h3>
					) : null}
					<StoreCardGrid>
						{group.items.map((item) => (
							<StoreCatalogCard
								action={
									spec.install ? (
										<CardAction
											busy={pendingId === item.id}
											installed={isInstalled(item)}
											label={spec.install.label}
											onInstall={() => onInstall(item)}
										/>
									) : undefined
								}
								// A contributed tab declares at most an install verb, so the
								// menu is that verb or nothing — an already-installed row
								// gets no menu rather than an empty one.
								contextMenu={
									spec.install && !isInstalled(item)
										? storeItemContextMenu({
												installed: false,
												onInstall: () => onInstall(item),
											})
										: undefined
								}
								description={item.description}
								icon={
									<TabIcon className="size-5" icon={item.icon ?? tab.icon} />
								}
								key={item.id}
								name={item.title}
								onClick={() => onSelect(item.id)}
								seedId={item.id}
								selected={item.id === selectedId}
							/>
						))}
					</StoreCardGrid>
				</section>
			))}
		</div>
	);
}
