import { Refresh01Icon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import type {
	NormalizedRecommendations,
	RecommendationItem,
} from "../recommendations.ts";
import StoreCatalogCard from "./store-catalog-card.tsx";
import { StoreCardGrid } from "./store-catalog-layout.tsx";
import StoreShelfHeading from "./store-shelf-heading.tsx";

export default function ForYouSection({
	data,
	loading = false,
	onCadenceChange,
	onHide,
	onOpen,
	onRefresh,
	onReenable,
	hrefFor,
}: {
	data: NormalizedRecommendations;
	hrefFor?: (item: RecommendationItem) => string;
	loading?: boolean;
	onCadenceChange?: (cadence: NormalizedRecommendations["cadence"]) => void;
	onHide?: () => void;
	onOpen?: (item: RecommendationItem) => void;
	onRefresh?: () => void;
	onReenable?: () => void;
}) {
	if (!data.enabled) {
		return null;
	}
	const showSkeleton = loading && data.items.length === 0;
	// Nothing to recommend yet: the shelf steps aside rather than explaining
	// itself. A hidden shelf keeps its heading so it can be re-enabled.
	if (!(data.hidden || showSkeleton) && data.items.length === 0) {
		return null;
	}

	const action = data.hidden ? (
		<Button onClick={onReenable} size="sm" variant="ghost">
			Re-enable For you
		</Button>
	) : (
		<ForYouControls
			cadence={data.cadence}
			onCadenceChange={onCadenceChange}
			onHide={onHide}
			onRefresh={onRefresh}
		/>
	);

	return (
		<section className="group/for-you">
			<StoreShelfHeading action={action} className="px-0">
				For you
			</StoreShelfHeading>
			{data.hidden ? null : showSkeleton ? (
				<div aria-busy="true">
					<StoreCardGrid>
						<Skeleton className="h-20" radius="row" />
						<Skeleton className="h-20" radius="row" />
					</StoreCardGrid>
				</div>
			) : (
				<StoreCardGrid>
					{data.items.slice(0, 6).map((item) => (
						<StoreCatalogCard
							description={item.reason || item.description}
							href={hrefFor?.(item)}
							iconUrl={item.iconUrl}
							key={`${item.kind}:${item.id}`}
							name={item.name}
							onClick={() => onOpen?.(item)}
							seedId={item.id}
						/>
					))}
				</StoreCardGrid>
			)}
		</section>
	);
}

/** The shelf's controls: a quiet cadence picker plus refresh and hide. They
 *  stay out of sight until the shelf is hovered or focused, so the heading reads
 *  as a title, not a toolbar. */
function ForYouControls({
	cadence,
	onCadenceChange,
	onHide,
	onRefresh,
}: {
	cadence: NormalizedRecommendations["cadence"];
	onCadenceChange?: (cadence: NormalizedRecommendations["cadence"]) => void;
	onHide?: () => void;
	onRefresh?: () => void;
}) {
	return (
		<div className="flex items-center gap-1 opacity-0 transition-opacity duration-(--duration-fast) focus-within:opacity-100 group-hover/for-you:opacity-100 group-hover/for-you:duration-0">
			{onCadenceChange ? (
				<select
					aria-label="Recommendation refresh cadence"
					className="h-8 rounded-lg bg-transparent px-2 text-muted-foreground text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
					onChange={(event) =>
						onCadenceChange(
							// SAFETY: This native select authors exactly daily, weekly, and monthly
							// option values, matching the complete cadence union. Supported browser
							// selections retain that invariant; synthetic values remain unvalidated.
							event.target.value as NormalizedRecommendations["cadence"]
						)
					}
					value={cadence}
				>
					<option value="daily">Daily</option>
					<option value="weekly">Weekly</option>
					<option value="monthly">Monthly</option>
				</select>
			) : null}
			{onRefresh ? (
				<Button
					aria-label="Refresh For you"
					onClick={onRefresh}
					size="icon-sm"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
				</Button>
			) : null}
			{onHide ? (
				<Button
					aria-label="Hide For you"
					onClick={onHide}
					size="icon-sm"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={ViewOffIcon} />
				</Button>
			) : null}
		</div>
	);
}
