import { LinkSquare01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { REALM_ICONS } from "@ryu/marketplace/catalog/realm-icons";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { useQuery } from "@tanstack/react-query";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type StoreSearchRealm,
	useStoreSearch,
} from "@/src/hooks/useStoreSearch.ts";
import type { IntegrationBrand } from "@/src/lib/api/integrations.ts";
import { fetchIntegration } from "@/src/lib/api/integrations.ts";
import { ManagedSourcePicker } from "./IntegrationsCatalogSection-managed-source-picker.tsx";
import {
	orderedOptions,
	SOURCE_LABELS,
} from "./IntegrationsCatalogSection-options.ts";
import { ProviderOptionRow } from "./IntegrationsCatalogSection-provider-option-row.tsx";
import { RelatedRealmSection } from "./IntegrationsCatalogSection-related-realm.tsx";

/** The brand preview: a header (logo, name, categories, source chips, site link)
 *  over stacked "related X" sections gathered by the store-wide search. */
export function IntegrationDetailPanel({
	brand,
	onOpenConnections,
	onOpenInstallChat,
	onOpenRealm,
}: {
	brand: IntegrationBrand;
	onOpenConnections: () => void;
	onOpenInstallChat: (prompt: string) => void;
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
}) {
	const tl = useLiteralMessages();
	const activeNode = useActiveNode();
	const target = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};
	const detailQuery = useQuery({
		queryKey: ["integrations", "detail", target.url, brand.id],
		queryFn: () => fetchIntegration(target, brand.id),
		staleTime: 5 * 60_000,
	});
	const detailBrand = detailQuery.data ?? brand;

	// Search every realm for the brand name; the hook takes the query reactively
	// (debounced + cached), so selecting a different brand refetches on its own.
	const { groups, loading, isEmpty, hasQuery } = useStoreSearch(
		detailBrand.name
	);
	const options = orderedOptions(detailBrand.options ?? []);
	const offersBothManaged =
		options.some((option) => option.providerRole === "primary") &&
		options.some((option) => option.providerRole === "alternative");

	const domainHref = detailBrand.domain
		? safeHttpUrl(`https://${detailBrand.domain}`)
		: null;

	return (
		<ListingDetailShell
			actions={
				domainHref ? (
					<Button
						render={
							<a href={domainHref} rel="noopener noreferrer" target="_blank" />
						}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={LinkSquare01Icon} />
						{detailBrand.domain}
					</Button>
				) : null
			}
			aside={
				<>
					<ListingAsideCard title="Information">
						<ListingInfoGrid
							rows={[
								{ label: "Domain", value: detailBrand.domain ?? "Not listed" },
								{
									label: "Directories",
									value: detailBrand.sources
										.map((s) => SOURCE_LABELS.get(s) ?? s)
										.join(", "),
								},
								{
									label: "Options",
									value: formatCount(options.length) ?? "—",
								},
							]}
						/>
					</ListingAsideCard>
					{offersBothManaged ? (
						<ManagedSourcePicker brand={detailBrand} target={target} />
					) : null}
					{detailBrand.categories.length > 0 ? (
						<ListingAsideCard title="Categories">
							<div className="flex flex-wrap gap-1">
								{detailBrand.categories.map((c) => (
									<Badge key={c} typography="normal" variant="outline">
										{c}
									</Badge>
								))}
							</div>
						</ListingAsideCard>
					) : null}
				</>
			}
			hero={
				<ListingHero
					badges={detailBrand.sources.map((s) => SOURCE_LABELS.get(s) ?? s)}
					icon={
						detailBrand.logo ? (
							<img
								alt=""
								className="size-full object-cover"
								loading="lazy"
								src={safeMediaUrl(detailBrand.logo) ?? undefined}
							/>
						) : (
							<HugeiconsIcon className="size-8" icon={REALM_ICONS.plugins} />
						)
					}
					name={detailBrand.name}
					tagline={detailBrand.description}
				/>
			}
			stats={
				<ListingStatStrip
					items={[
						{
							label: "Options",
							sub: "Unified provider choices",
							value: formatCount(options.length) ?? "—",
						},
						{
							label: "Categories",
							value: formatCount(detailBrand.categories.length) ?? "—",
						},
						{
							label: "Directories",
							value: formatCount(detailBrand.sources.length) ?? "—",
						},
						{
							label: "In catalog",
							value: loading ? "…" : (formatCount(groups.length) ?? "—"),
							sub: "Related realms",
						},
					]}
				/>
			}
		>
			{options.length > 0 ? (
				<ListingSection title="Integration options">
					<div className="flex max-h-96 flex-col gap-1.5 overflow-y-auto pr-1">
						{options.map((option) => (
							<ProviderOptionRow
								brandName={detailBrand.name}
								key={option.id}
								onOpenConnections={onOpenConnections}
								onOpenInstallChat={onOpenInstallChat}
								onOpenRealm={onOpenRealm}
								option={option}
							/>
						))}
					</div>
					<p className="mt-2 text-muted-foreground text-xs">
						Prices are compared only when a provider publishes the same
						capability, billing unit, and a USD price. “Lowest listed price” is
						not a guarantee of runtime availability.
					</p>
				</ListingSection>
			) : null}

			<ListingSection title="Related in the catalog">
				{loading ? <SkeletonRows spacing="spacious" /> : null}
				{!loading && hasQuery && isEmpty ? (
					<p className="text-muted-foreground text-sm">
						{tl("Nothing in the catalog references {name} yet.", {
							name: detailBrand.name,
						})}
					</p>
				) : null}
				<div className="flex flex-col gap-4">
					{groups.map((group) => (
						<RelatedRealmSection
							brandName={detailBrand.name}
							group={group}
							key={group.realm}
							onOpenRealm={onOpenRealm}
						/>
					))}
				</div>
			</ListingSection>
		</ListingDetailShell>
	);
}
