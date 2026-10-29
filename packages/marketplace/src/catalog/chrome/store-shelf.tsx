import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// packages/marketplace/src/catalog/chrome/store-shelf.tsx
//
// A browse shelf with a deliberately small first impression. Shelves show eight
// cards by default, then reveal another eight on each "Show more" action. The
// category heading remains a separate navigation affordance, so users can either
// skim a shelf in place or move to the reusable full category view.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Children, type ReactNode, useState } from "react";
import { StoreCardGrid } from "./store-catalog-layout.tsx";
import StoreShelfHeading from "./store-shelf-heading.tsx";

export const DEFAULT_SHELF_SIZE = 8;

export default function StoreShelf<T>({
	items,
	title,
	trailing,
	description,
	renderItem,
	onOpenCategory,
	initialSize = DEFAULT_SHELF_SIZE,
	expansionStep = DEFAULT_SHELF_SIZE,
}: {
	/** Cards in the category, in the ranking order supplied by the host. */
	items: readonly T[];
	/** Optional non-navigation content after the title. */
	trailing?: ReactNode;
	/** Optional provenance or explanatory copy below the title. */
	description?: ReactNode;
	/** Number of cards to reveal after each progressive expansion. */
	expansionStep?: number;
	/** Number of cards visible before the first expansion. */
	initialSize?: number;
	/** Render one card. The caller owns the card key. */
	renderItem: (item: T) => ReactNode;
	/** Opens the full category page. */
	onOpenCategory?: () => void;
	/** Shelf title. */
	title: ReactNode;
}) {
	const tl = useLiteralMessages();
	const [visibleCount, setVisibleCount] = useState(() =>
		Math.max(1, initialSize)
	);
	const hasMore = visibleCount < items.length;
	const nextCount = Math.min(
		items.length,
		visibleCount + Math.max(1, expansionStep)
	);

	return (
		<section>
			<StoreShelfHeading
				action={trailing}
				description={description}
				onOpen={onOpenCategory}
				openLabel={
					isNativeText(title)
						? tl("Open {title}", { title: String(title) })
						: tl("Open category")
				}
			>
				{title}
			</StoreShelfHeading>
			<StoreCardGrid>
				{Children.toArray(
					items.slice(0, visibleCount).map((item) => renderItem(item))
				)}
			</StoreCardGrid>
			{hasMore ? (
				<div className="flex justify-center pt-3">
					<Button
						aria-expanded={visibleCount > Math.max(1, initialSize)}
						onClick={() => setVisibleCount(nextCount)}
						size="sm"
						variant="ghost-muted"
					>
						Show more
					</Button>
				</div>
			) : null}
		</section>
	);
}
