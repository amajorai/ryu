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
import { LANGUAGE_PACKS_CHANGED_EVENT } from "@ryu/i18n/core";
import { useOptionalI18n } from "@ryu/i18n/react";
import { StoreCardGrid } from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarketplaceDetailDialog from "@/src/components/marketplace/MarketplaceDetailDialog.tsx";
import { useMarketplacePurchase } from "@/src/components/marketplace/useMarketplacePurchase.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useMarketplaceCatalog } from "@/src/hooks/useMarketplaceCatalog.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { setLanguagePackEnabled } from "@/src/lib/api/language-packs.ts";
import type { MarketplaceKind } from "@/src/lib/api/marketplace.ts";
import {
	fetchInstalledPortablePackages,
	installPortablePackage,
	type PortablePackageState,
} from "@/src/lib/api/marketplace.ts";
import { toCardData } from "@/src/lib/api/marketplace-view.ts";

export default function MarketplaceStrip({
	initialQuery,
	initialSelectedId,
	kind,
}: {
	initialQuery?: string;
	initialSelectedId?: string;
	kind: MarketplaceKind;
}) {
	const { items, loading, error } = useMarketplaceCatalog(kind, initialQuery);
	const node = useActiveNode();
	const i18n = useOptionalI18n();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const { buying, buy, isLicensed, detail, openDetail, closeDetail } =
		useMarketplacePurchase();
	const openedSelection = useRef<string | null>(null);
	const [portablePackages, setPortablePackages] = useState<
		PortablePackageState[]
	>([]);
	const [languagePackBusy, setLanguagePackBusy] = useState<string | null>(null);
	const [pendingLanguagePackId, setPendingLanguagePackId] = useState<
		string | null
	>(null);

	useEffect(() => {
		if (kind !== "language_pack") {
			return;
		}
		let cancelled = false;
		fetchInstalledPortablePackages(target)
			.then((next) => {
				if (!cancelled) {
					setPortablePackages(next);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setPortablePackages([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [kind, target]);

	const installLanguagePack = useCallback(
		async (id: string) => {
			setLanguagePackBusy(id);
			try {
				const existing = portablePackages.find(
					(packageState) =>
						packageState.kind === "language_pack" && packageState.id === id
				);
				if (existing) {
					if (!existing.enabled) {
						await setLanguagePackEnabled(target, { enabled: true, id });
					}
				} else {
					await installPortablePackage(target, { id, kind: "language_pack" });
					await setLanguagePackEnabled(target, { enabled: true, id });
				}
				setPortablePackages(await fetchInstalledPortablePackages(target));
				setPendingLanguagePackId(id);
				// Installing through the Marketplace updates Core, while the shell's
				// language catalog is loaded by LanguagePackBridge. Wake that bridge so
				// the newly installed pack can be selected immediately instead of waiting
				// for a node change or a later reload.
				window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT));
			} catch (cause) {
				toast.error("Couldn't install language pack", {
					description: cause instanceof Error ? cause.message : String(cause),
				});
			} finally {
				setLanguagePackBusy(null);
			}
		},
		[portablePackages, target]
	);

	useEffect(() => {
		if (!pendingLanguagePackId) {
			return;
		}
		if (
			!i18n?.availablePacks.some((pack) => pack.id === pendingLanguagePackId)
		) {
			return;
		}
		i18n.selectPack(pendingLanguagePackId);
		setPendingLanguagePackId(null);
	}, [i18n, pendingLanguagePackId]);

	useEffect(() => {
		if (!initialSelectedId || openedSelection.current === initialSelectedId) {
			return;
		}
		const card = items.find((item) => item.id === initialSelectedId);
		if (!card) {
			return;
		}
		openedSelection.current = initialSelectedId;
		openDetail({
			id: card.id,
			kind: card.kind,
			name: card.name,
			iconUrl: card.iconUrl ?? null,
		});
	}, [initialSelectedId, items, openDetail]);

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
				<h3 className="font-medium text-sm">
					{i18n?.t("marketplace.from") ?? "From the Marketplace"}
				</h3>
				{loading && items.length === 0 ? (
					<Spinner className="size-3.5 text-muted-foreground" />
				) : null}
			</div>

			{items.length > 0 ? (
				<StoreCardGrid>
					{items.map((card) => {
						const packageState = portablePackages.find(
							(candidate) =>
								candidate.kind === "language_pack" && candidate.id === card.id
						);
						const data = toCardData(
							card,
							isLicensed(card.kind, card.id),
							buying === card.id,
							card.kind === "language_pack" &&
								(!card.pricing || isLicensed(card.kind, card.id))
								? {
										active:
											packageState?.enabled === true &&
											i18n?.selectedPack?.id === card.id,
										installed: packageState !== undefined,
										installing: languagePackBusy === card.id,
										onInstall: () => {
											void installLanguagePack(card.id);
										},
									}
								: {}
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
				</StoreCardGrid>
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
