import { Refresh01Icon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
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

	const action = data.hidden ? (
		<Button onClick={onReenable} size="sm" variant="ghost">
			Re-enable For you
		</Button>
	) : (
		<div className="flex items-center gap-1">
			{onCadenceChange ? (
				<select
					aria-label="Recommendation refresh cadence"
					className="h-7 rounded-md border bg-transparent px-1.5 text-muted-foreground text-xs"
					onChange={(event) =>
						onCadenceChange(
							// SAFETY: This native select authors exactly daily, weekly, and monthly
							// option values, matching the complete cadence union. Supported browser
							// selections retain that invariant; synthetic values remain unvalidated.
							event.target.value as NormalizedRecommendations["cadence"]
						)
					}
					value={data.cadence}
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
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
				</Button>
			) : null}
			{onHide ? (
				<Button
					aria-label="Hide For you"
					onClick={onHide}
					size="icon-sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={ViewOffIcon} />
				</Button>
			) : null}
		</div>
	);

	return (
		<section>
			<StoreShelfHeading action={action} className="px-0">
				For you
			</StoreShelfHeading>
			{data.hidden ? null : loading && data.items.length === 0 ? (
				<div className="flex items-center justify-center py-8 text-muted-foreground">
					<Spinner className="size-5" />
				</div>
			) : data.items.length === 0 ? (
				<p className="px-1 text-muted-foreground text-sm">
					Recommendations will appear after your catalog is available.
				</p>
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
