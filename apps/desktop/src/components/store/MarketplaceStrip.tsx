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
import { MarketplaceItemCard } from "@ryu/blocks/desktop/marketplace.tsx";
import {
	LANGUAGE_PACK_STORAGE_KEY,
	LANGUAGE_PACKS_CHANGED_EVENT,
} from "@ryu/i18n/core";
import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { StoreCardGrid } from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import ItemLikeButton from "@ryu/marketplace/likes/like-button";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import MarketplaceDetailDialog from "@/src/components/marketplace/MarketplaceDetailDialog.tsx";
import { useMarketplacePurchase } from "@/src/components/marketplace/useMarketplacePurchase.ts";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import { bundleSkillChanges } from "@/src/components/skills/skill-set-change.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	LANGUAGE_MODE_CHANGED_EVENT,
	LANGUAGE_MODE_KEY,
	setLanguageMode,
} from "@/src/hooks/useLanguageMode.ts";
import { useMarketplaceCatalog } from "@/src/hooks/useMarketplaceCatalog.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { setLanguagePackEnabled } from "@/src/lib/api/language-packs.ts";
import type { MarketplaceKind } from "@/src/lib/api/marketplace.ts";
import {
	fetchDetail,
	fetchInstalledPortablePackages,
	installPortablePackage,
	type PortablePackageState,
} from "@/src/lib/api/marketplace.ts";
import {
	describeBundleManualSteps,
	installMarketplaceBundle,
	type MarketplaceBundleInstallResult,
} from "@/src/lib/api/marketplace-bundles.ts";
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
	const { items, loading, error, refresh, hasMore, loadMore, loadingMore } =
		useMarketplaceCatalog(kind, initialQuery);
	const node = useActiveNode();
	const { confirmSkillSetChange } = useSkillDistributionFlow();
	const i18n = useOptionalI18n();
	const tl = useLiteralMessages();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const languageScope = useMemo(() => ({ kind, target }), [kind, target]);
	const activeLanguageScope = useRef<typeof languageScope | null>(null);
	const languageOperation = useRef<{
		id: string;
		scope: typeof languageScope;
	} | null>(null);
	const { buying, buy, isLicensed, detail, openDetail, closeDetail } =
		useMarketplacePurchase();
	const openedSelection = useRef<string | null>(null);
	const [portablePackages, setPortablePackages] = useState<
		PortablePackageState[]
	>([]);
	const [languagePackBusy, setLanguagePackBusy] = useState<string | null>(null);
	const [pendingLanguagePack, setPendingLanguagePack] = useState<NonNullable<
		typeof languageOperation.current
	> | null>(null);
	const [bundleBusy, setBundleBusy] = useState<string | null>(null);
	const [bundleProgress, setBundleProgress] = useState<{
		completed: number;
		total: number;
	} | null>(null);
	const retireLanguageOperation = useCallback(() => {
		languageOperation.current = null;
		setPendingLanguagePack(null);
		setLanguagePackBusy(null);
	}, []);

	useLayoutEffect(() => {
		// A returning node or credential tuple is a new visit, not permission for
		// an earlier response to publish into this language picker.
		activeLanguageScope.current = languageScope;
		retireLanguageOperation();
		setPortablePackages([]);
		return () => {
			if (activeLanguageScope.current === languageScope) {
				activeLanguageScope.current = null;
				languageOperation.current = null;
			}
		};
	}, [languageScope, retireLanguageOperation]);

	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (
				(event.storageArea === null || event.storageArea === localStorage) &&
				(event.key === null ||
					event.key === LANGUAGE_MODE_KEY ||
					event.key === LANGUAGE_PACK_STORAGE_KEY)
			) {
				retireLanguageOperation();
			}
		};
		window.addEventListener(
			LANGUAGE_MODE_CHANGED_EVENT,
			retireLanguageOperation
		);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(
				LANGUAGE_MODE_CHANGED_EVENT,
				retireLanguageOperation
			);
			window.removeEventListener("storage", onStorage);
		};
	}, [retireLanguageOperation]);

	const installBundle = useCallback(
		async (id: string) => {
			setBundleBusy(id);
			try {
				const bundle = await fetchDetail("bundle", id);
				// New skill members change every skill-loading thread's prompt.
				const confirmed = await confirmSkillSetChange(
					await bundleSkillChanges(target, bundle.bundleMembers)
				);
				if (!confirmed) {
					return;
				}
				const result: MarketplaceBundleInstallResult =
					await installMarketplaceBundle(
						target,
						id,
						bundle.bundleMembers,
						({ completed, total }) => setBundleProgress({ completed, total })
					);
				const requiredFailures = result.failures.filter(
					({ member }) => member.required
				);
				const manualNote = describeBundleManualSteps(result.manual);
				if (requiredFailures.length > 0) {
					toast.error("Bundle installed with required items missing", {
						description: tl(
							"{installed} installed, {present} already present, {failed} required failed. {reason}{manualNote}",
							{
								failed: requiredFailures.length,
								installed: result.completed.length,
								manualNote: manualNote ? ` ${manualNote}` : "",
								present: result.skipped.length,
								reason:
									requiredFailures[0]?.error ??
									tl("Retry from the bundle details."),
							}
						),
					});
				} else if (manualNote) {
					toast.warning("Bundle installed with manual steps left", {
						description: tl(
							"{installed} installed, {present} already present. {manualNote}",
							{
								installed: result.completed.length,
								manualNote,
								present: result.skipped.length,
							}
						),
					});
				} else {
					toast.success("Bundle installed", {
						description:
							result.failures.length > 0
								? tl(
										"{installed} installed, {present} already present, {skipped} optional skipped.",
										{
											installed: result.completed.length,
											present: result.skipped.length,
											skipped: result.failures.length,
										}
									)
								: tl("{installed} installed, {present} already present.", {
										installed: result.completed.length,
										present: result.skipped.length,
									}),
					});
				}
				await refresh();
			} catch (cause) {
				toast.error("Couldn't install bundle", {
					description: cause instanceof Error ? cause.message : String(cause),
				});
			} finally {
				setBundleBusy(null);
				setBundleProgress(null);
			}
		},
		[confirmSkillSetChange, refresh, target, tl]
	);

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
			if (
				languageScope.kind !== "language_pack" ||
				activeLanguageScope.current !== languageScope
			) {
				return;
			}
			const operation = { id, scope: languageScope };
			languageOperation.current = operation;
			setPendingLanguagePack(null);
			const isCurrent = () =>
				languageOperation.current === operation &&
				activeLanguageScope.current === operation.scope;
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
					if (!isCurrent()) {
						return;
					}
					await setLanguagePackEnabled(target, { enabled: true, id });
				}
				if (!isCurrent()) {
					return;
				}
				const next = await fetchInstalledPortablePackages(target);
				if (!isCurrent()) {
					return;
				}
				setPortablePackages(next);
				setPendingLanguagePack(operation);
				// Installing through the Marketplace updates Core, while the shell's
				// language catalog is loaded by LanguagePackBridge. Wake that bridge so
				// the newly installed pack can be selected immediately instead of waiting
				// for a node change or a later reload.
				window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT));
			} catch (cause) {
				if (!isCurrent()) {
					return;
				}
				toast.error("Couldn't install language pack", {
					description: cause instanceof Error ? cause.message : String(cause),
				});
			} finally {
				if (isCurrent()) {
					setLanguagePackBusy(null);
				}
			}
		},
		[languageScope, portablePackages, target]
	);

	useEffect(() => {
		if (
			!pendingLanguagePack ||
			languageOperation.current !== pendingLanguagePack ||
			activeLanguageScope.current !== pendingLanguagePack.scope
		) {
			return;
		}
		if (
			!i18n?.availablePacks.some(
				(pack) => pack.id === pendingLanguagePack.id && pack.enabled !== false
			)
		) {
			return;
		}
		languageOperation.current = null;
		setLanguageMode("fixed");
		i18n.selectPack(pendingLanguagePack.id);
		setPendingLanguagePack(null);
	}, [i18n, pendingLanguagePack]);

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
				{bundleBusy && bundleProgress ? (
					<span aria-live="polite" className="text-muted-foreground text-xs">
						{tl("Installing {completed}/{total}", {
							completed: bundleProgress.completed,
							total: bundleProgress.total,
						})}
					</span>
				) : null}
				{loading && items.length === 0 ? (
					<Spinner className="size-3.5" />
				) : null}
			</div>

			{items.length > 0 ? (
				<StoreCardGrid>
					{items.map((card) => {
						const like = (
							<ItemLikeButton
								namespace={card.id}
								seed={{ count: card.likeCount, liked: card.likedByMe }}
							/>
						);
						const packageState = portablePackages.find(
							(candidate) =>
								candidate.kind === "language_pack" && candidate.id === card.id
						);
						const installOptions =
							card.kind === "bundle"
								? {
										installing: bundleBusy === card.id,
										like,
										onInstall: () => {
											void installBundle(card.id);
										},
									}
								: card.kind === "language_pack" &&
										(!card.pricing || isLicensed(card.kind, card.id))
									? {
											active:
												packageState?.enabled === true &&
												i18n?.selectedPack?.id === card.id,
											installed: packageState !== undefined,
											installing: languagePackBusy === card.id,
											like,
											onInstall: () => {
												void installLanguagePack(card.id);
											},
										}
									: { like };
						const data = toCardData(
							card,
							isLicensed(card.kind, card.id),
							buying === card.id,
							installOptions
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

			{items.length > 0 && hasMore ? (
				<Button
					className="mt-3"
					loading={loadingMore}
					onClick={() => {
						void loadMore();
					}}
					size="sm"
					variant="ghost"
				>
					Load more
				</Button>
			) : null}

			{detail ? (
				<MarketplaceDetailDialog
					bundleInstalling={bundleBusy === detail.id}
					id={detail.id}
					initialIconUrl={detail.iconUrl}
					initialName={detail.name}
					kind={detail.kind}
					onClose={closeDetail}
					onInstallBundle={
						detail.kind === "bundle"
							? () => {
									void installBundle(detail.id);
								}
							: undefined
					}
					open={true}
				/>
			) : null}
		</section>
	);
}
