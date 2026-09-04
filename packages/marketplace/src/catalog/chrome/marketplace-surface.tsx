"use client";

import {
	StoreGlobalSearch,
	type StoreSectionTab,
	StoreSectionTabs,
} from "@ryu/blocks/desktop/store.tsx";
import { useI18n } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

const GLOBAL_SEARCH_PLACEHOLDER = "Search the whole marketplace…";

/**
 * The Marketplace's one shell contract. Web and desktop may provide different
 * sections and trailing controls, but the search/tabs geometry and the content
 * viewport are deliberately owned here so the two surfaces cannot drift again.
 */
export default function MarketplaceSurface({
	active,
	children,
	className,
	contentClassName,
	fullBleed = false,
	onSearch,
	onSelect,
	query,
	sections,
	showSectionTabs = true,
	trailing,
}: {
	active: string;
	children: ReactNode;
	className?: string;
	contentClassName?: string;
	fullBleed?: boolean;
	onSearch: (value: string) => void;
	onSelect: (value: string) => void;
	query: string;
	sections: StoreSectionTab[];
	/** Hide the global section strip when the active section already owns the
	 *  canonical navigation for the same destinations (for example Browse's
	 *  marketplace-kind tabs). */
	showSectionTabs?: boolean;
	trailing?: ReactNode;
}) {
	const { t } = useI18n();
	return (
		<div
			className={cn("relative flex min-h-0 flex-col", className)}
			data-slot="marketplace-surface"
		>
			<div
				className={cn(
					"mx-auto w-full shrink-0 px-4 pt-4",
					fullBleed ? "max-w-none" : "max-w-4xl"
				)}
			>
				<StoreGlobalSearch
					onChange={onSearch}
					placeholder={t("marketplace.search", {}, GLOBAL_SEARCH_PLACEHOLDER)}
					trailing={trailing}
					value={query}
				/>
				{showSectionTabs ? (
					<StoreSectionTabs
						active={active}
						className="pt-2 pb-1"
						onSelect={onSelect}
						sections={sections}
					/>
				) : null}
			</div>
			<div
				className={cn("min-h-0 min-w-0 flex-1", contentClassName)}
				data-slot="marketplace-surface-content"
			>
				{children}
			</div>
		</div>
	);
}

export type { StoreSectionTab };
