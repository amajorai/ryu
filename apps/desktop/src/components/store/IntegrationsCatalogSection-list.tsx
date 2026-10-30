import { LinkSquare01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	STORE_LOAD_ERROR_SENTENCE,
	StoreErrorDetails,
} from "@ryu/blocks/desktop/store-error-details.tsx";
import InfiniteSentinel from "@ryu/marketplace/catalog/chrome/infinite-sentinel";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import { StoreCardGrid } from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { REALM_ICONS } from "@ryu/marketplace/catalog/realm-icons";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { Button } from "@ryu/ui/components/button.tsx";
import { ContextMenuItem } from "@ryu/ui/components/context-menu.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import type { IntegrationBrand } from "@/src/lib/api/integrations.ts";

/** The one row a brand card's right-click menu can hold: the brand's own site,
 *  the same link its detail header offers. `undefined` — and so no menu at all —
 *  when the directory entry carries no domain. Rendered as a real anchor so it
 *  opens the way every other external link in this file does. */
function brandSiteMenu(domain: string | null | undefined) {
	const href = domain ? safeHttpUrl(`https://${domain}`) : null;
	if (!href) {
		return undefined;
	}
	return (
		<ContextMenuItem
			render={<a href={href} rel="noopener noreferrer" target="_blank" />}
		>
			<HugeiconsIcon className="size-4" icon={LinkSquare01Icon} />
			Open website
		</ContextMenuItem>
	);
}

export function IntegrationList({
	integrations,
	loading,
	loadingMore,
	error,
	fetchNextPage,
	hasNextPage,
	selectedId,
	onSelect,
	onClearSearch,
	onRetry,
}: {
	integrations: IntegrationBrand[];
	loading: boolean;
	loadingMore: boolean;
	error: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	selectedId: string | null;
	onSelect: (id: string) => void;
	onClearSearch: () => void;
	onRetry: () => void;
}) {
	if (error) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon className="size-5" icon={REALM_ICONS.plugins} />
					</EmptyMedia>
					<EmptyTitle>Couldn't load integrations</EmptyTitle>
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

	if (loading && integrations.length === 0) {
		return <SkeletonRows spacing="spacious" />;
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
			<StoreCardGrid>
				{integrations.map((it) => (
					<StoreCatalogCard
						action={null}
						// A brand has no install lifecycle — it is a directory entry — so
						// the one verb worth a menu is the one the detail panel already
						// offers: its own site. A brand with no domain gets no menu.
						contextMenu={brandSiteMenu(it.domain)}
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
