import { useLiteralMessages } from "@ryu/i18n/react";
import { ListingAsideCard } from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
	IntegrationBrand,
	IntegrationProviderPin,
} from "@/src/lib/api/integrations.ts";
import { setIntegrationProviderPin } from "@/src/lib/api/integrations.ts";
import {
	AUTO_SOURCE,
	SOURCE_LABELS,
} from "./IntegrationsCatalogSection-options.ts";

/** Which managed source runs this app's actions when both offer it. Same
 *  `Select` source-picker idiom as the Marketplace's catalog source; the
 *  choice is a Core preference that the Store and agent routing both read. */
export function ManagedSourcePicker({
	brand,
	target,
}: {
	brand: IntegrationBrand;
	target: { url: string; token: string | null; userJwt: string | null };
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const pin = useMutation({
		mutationFn: (source: IntegrationProviderPin | null) =>
			setIntegrationProviderPin(target, brand.id, source),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["integrations"] }),
	});
	const suggested =
		SOURCE_LABELS.get(brand.suggestedSource ?? "") ?? brand.suggestedSource;
	const items = [
		{
			value: AUTO_SOURCE,
			label: suggested ? `Suggested (${suggested})` : "Suggested",
		},
		{ value: "treg", label: "Treg (provider cost)" },
		{ value: "composio", label: "Composio" },
	];
	return (
		<ListingAsideCard title="Managed provider">
			<div className="flex flex-col gap-1.5">
				<Select
					disabled={pin.isPending}
					items={items}
					onValueChange={(value) => {
						if (value === "treg" || value === "composio") {
							pin.mutate(value);
						} else if (value === AUTO_SOURCE) {
							pin.mutate(null);
						}
					}}
					value={brand.preferredSource ?? AUTO_SOURCE}
				>
					<SelectTrigger className="h-8 w-full" size="sm">
						<SelectValue placeholder="Provider" />
					</SelectTrigger>
					<SelectContent>
						{items.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-xs">
					{tl(
						"Agents call {name} through this source. Composio still serves what Treg does not offer, such as your own connected accounts.",
						{ name: brand.name }
					)}
				</p>
				{pin.isError ? (
					<p className="text-destructive text-xs">
						Could not save the provider choice.
					</p>
				) : null}
			</div>
		</ListingAsideCard>
	);
}
