import { MARKETPLACE_BROWSE_KINDS } from "@ryu/marketplace/catalog/chrome/marketplace-sections";
import StoreShelfHeading from "@ryu/marketplace/catalog/chrome/store-shelf-heading";
import type { MarketplaceKind } from "@/src/lib/api/marketplace.ts";
import MarketplaceStrip from "./MarketplaceStrip.tsx";

const BROWSE_KINDS: MarketplaceKind[] = MARKETPLACE_BROWSE_KINDS.map(
	(kind) => kind.value
);

/** Desktop adapter for the shared Browse tab. Free discovery stays in each
 * realm tab; this page is the one cross-kind view of paid Marketplace listings. */
export default function MarketplaceBrowseSection({
	onlyKind,
	initialQuery,
	initialItem,
}: {
	initialItem?: { id: string; kind: string };
	initialQuery?: string;
	onlyKind?: MarketplaceKind;
}) {
	const selectedKind = BROWSE_KINDS.find((kind) => kind === initialItem?.kind);
	const kinds = onlyKind
		? [onlyKind]
		: selectedKind
			? [selectedKind]
			: BROWSE_KINDS;
	return (
		<div className="scroll-fade h-full overflow-auto">
			<div className="mx-auto w-full max-w-4xl px-4 pt-2 pb-8">
				{onlyKind ? null : (
					<StoreShelfHeading className="px-0">
						Marketplace listings
					</StoreShelfHeading>
				)}
				{kinds.map((kind) => (
					<MarketplaceStrip
						initialQuery={initialQuery}
						initialSelectedId={
							kind === selectedKind ? initialItem?.id : undefined
						}
						key={kind}
						kind={kind}
					/>
				))}
			</div>
		</div>
	);
}
