// packages/marketplace/src/catalog/chrome/store-category-page.tsx
//
// Full-page category browsing shared by marketplace surfaces. The page owns the
// breadcrumb/back affordance and the pagination marker; the host only supplies
// the already-ranked cards and its next-page callback.

import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Children, type ReactNode } from "react";
import InfiniteSentinel from "./infinite-sentinel.tsx";
import { StoreCardGrid } from "./store-catalog-layout.tsx";

export default function StoreCategoryPage<T>({
	category,
	items,
	renderItem,
	onBack,
	hasMore = false,
	loadingMore = false,
	onLoadMore,
}: {
	category: ReactNode;
	items: readonly T[];
	renderItem: (item: T) => ReactNode;
	onBack: () => void;
	hasMore?: boolean;
	loadingMore?: boolean;
	onLoadMore?: () => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
				<Button
					aria-label="Back to categories"
					className="-ml-2 gap-1 text-muted-foreground hover:text-foreground"
					onClick={onBack}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
					<span>Categories</span>
				</Button>
				<span aria-hidden="true" className="text-muted-foreground/60">
					/
				</span>
				<span aria-current="page" className="truncate text-foreground">
					{category}
				</span>
			</nav>

			<h2 className="px-1 font-medium text-base tracking-tight">{category}</h2>
			<StoreCardGrid>
				{Children.toArray(items.map((item) => renderItem(item)))}
			</StoreCardGrid>
			{hasMore && onLoadMore ? (
				<InfiniteSentinel
					hasMore={hasMore}
					loading={loadingMore}
					onLoadMore={onLoadMore}
				/>
			) : null}
		</div>
	);
}
