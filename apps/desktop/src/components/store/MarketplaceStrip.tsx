// apps/desktop/src/components/store/MarketplaceStrip.tsx
//
// The inline "From the Marketplace" strip shown at the bottom of each Core catalog
// section (Plugins / Models / Skills / MCP). It pulls the paid, control-plane
// catalog for one kind (:3000, session bearer) and renders Buy-capable cards next
// to — but visually separated from — the free Core catalog above it. This is the
// "deeper merge": paid items live inside each section, so there's no duplicate
// Marketplace surface. It owns its own loading/error state and degrades to
// nothing when the money layer is unavailable (signed out / no org / Stripe
// unconfigured), so a Core-only section is never blocked or errored by it.

import { Store01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { MarketplaceItemCard } from "@ryu/blocks/desktop/marketplace";
import { Spinner } from "@ryu/ui/components/spinner";
import MarketplaceDetailDialog from "@/src/components/marketplace/MarketplaceDetailDialog.tsx";
import { useMarketplacePurchase } from "@/src/components/marketplace/useMarketplacePurchase.ts";
import { useMarketplaceCatalog } from "@/src/hooks/useMarketplaceCatalog.ts";
import type { MarketplaceKind } from "@/src/lib/api/marketplace.ts";
import { toCardData } from "@/src/lib/api/marketplace-view.ts";

export default function MarketplaceStrip({ kind }: { kind: MarketplaceKind }) {
	const { items, loading, error } = useMarketplaceCatalog(kind);
	const { buying, buy, isLicensed, detail, openDetail, closeDetail } =
		useMarketplacePurchase();

	// The money layer being unavailable (signed out, no org, Stripe off, network)
	// must never disturb the free Core section above — just render nothing.
	if (error) {
		return null;
	}
	// Nothing paid for this kind, and nothing loading → no strip at all.
	if (items.length === 0 && !loading) {
		return null;
	}

	return (
		<section className="border-border/60 border-t px-4 py-4">
			<div className="mb-3 flex items-center gap-2">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Store01Icon}
				/>
				<h3 className="font-medium text-sm">From the Marketplace</h3>
				{loading && items.length === 0 ? (
					<Spinner className="size-3.5 text-muted-foreground" />
				) : null}
			</div>

			{items.length > 0 ? (
				<div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
					{items.map((card) => {
						const data = toCardData(
							card,
							isLicensed(card.kind, card.id),
							buying === card.id
						);
						return (
							<MarketplaceItemCard
								card={data}
								key={card.id}
								onBuy={() => buy({ id: card.id, kind: card.kind })}
								onOpenDetail={() =>
									openDetail({
										id: card.id,
										kind: card.kind,
										name: card.name,
										iconUrl: card.iconUrl ?? null,
									})
								}
							/>
						);
					})}
				</div>
			) : null}

			{detail ? (
				<MarketplaceDetailDialog
					id={detail.id}
					initialIconUrl={detail.iconUrl}
					initialName={detail.name}
					kind={detail.kind}
					onClose={closeDetail}
					open={true}
				/>
			) : null}
		</section>
	);
}
