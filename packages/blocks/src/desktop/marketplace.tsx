"use client";

// Presentational layer of the desktop Marketplace money layer. The live app now
// folds this into the Customize (Store) shell: the item card + browse grid drive
// the inline "From the Marketplace" strips in each catalog section
// (`apps/desktop/src/components/store/MarketplaceStrip.tsx`), and `MarketplaceHeader`
// drives the store's Account section tabs (`components/store/AccountSection.tsx`).
// The storyboard renders the same components with mock data and no-op handlers.
// One source of truth, so editing this block changes the real desktop too.
//
// Scope note: this block extracts the browse grid + item card (the
// money-affordance surface) — the part the storyboard exercises. The Licenses /
// Sell tabs and the storyboard's "detail" variant have no shared structure and
// stay as faithful reconstructions (see the storyboard screen).

import { Store01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useOptionalI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";

export { MarketplaceBrowseView } from "./marketplace-browse.tsx";
export { MarketplaceItemCard, TrustBadge } from "./marketplace-item-card.tsx";
export type {
	MarketplaceCardData,
	MarketplaceItemKind,
	MarketplaceKindOption,
	MarketplaceVerification,
} from "./marketplace-types.ts";

const noop = () => {
	// Default no-op handler for the presentational layer.
};

/** Header tab bar shared by the Marketplace page (Browse / Licenses / Sell). */
export function MarketplaceHeader({
	tabs,
	activeTab,
	onSelectTab = noop,
}: {
	tabs: { value: string; label: string }[];
	activeTab: string;
	onSelectTab?: (value: string) => void;
}) {
	const i18n = useOptionalI18n();
	return (
		<div className="flex shrink-0 items-center gap-1 border-b px-4 py-3">
			<HugeiconsIcon
				className="mr-2 size-5 text-muted-foreground"
				icon={Store01Icon}
			/>
			<h1 className="mr-4 font-semibold text-sm">
				{i18n?.t("common.marketplace") ?? "Marketplace"}
			</h1>
			{tabs.map((t) => (
				<Button
					key={t.value}
					onClick={() => onSelectTab(t.value)}
					size="sm"
					variant={activeTab === t.value ? "secondary" : "ghost"}
				>
					{t.label}
				</Button>
			))}
		</div>
	);
}
