import {
	GridIcon,
	InformationCircleIcon,
	SquareLock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { useEffect, useMemo, useState } from "react";
import { useMarketplaceHostOptional } from "../host.tsx";
import ItemLikeButton from "../likes/like-button.tsx";
import {
	isMandatoryListing,
	PriceBadge,
	pluginDownloadTaskId,
} from "./apps-catalog-section-card.tsx";
import {
	AppDetailAside,
	AppIncludedSection,
	appStatItems,
	runnableKindLabel,
} from "./apps-catalog-section-detail-aside.tsx";
import { isCommunityEntry } from "./apps-catalog-section-filters.ts";
import {
	AppHero,
	AppStatusBadge,
	DescriptorDetail,
} from "./apps-catalog-section-hero.tsx";
import { AppPrimaryAction } from "./apps-catalog-section-primary-action.tsx";
import {
	AppSecondaryActions,
	GrantList,
} from "./apps-catalog-section-secondary-actions.tsx";
import CommunityTrustNotice from "./chrome/community-trust-notice.tsx";
import DeprecationNotice from "./chrome/deprecation-notice.tsx";
import { DEPRECATED_LABEL, resolveDeprecation } from "./deprecation.ts";
import {
	ListingDetailShell,
	ListingGalleryRail,
	ListingSection,
	ListingStatStrip,
} from "./detail/listing-detail-shell.tsx";
import { ListingDetailTabs } from "./detail/listing-detail-tabs.tsx";
import { SupportExtensionPanel } from "./detail/support-extension-panel.tsx";
import {
	type CatalogHost,
	type CatalogInstall,
	type PluginSettingsOpener,
	useCatalogHost,
	useNoInterfaceLevel,
} from "./host.tsx";
import { runScorecard } from "./scorecard.ts";
import { stabilityLabel } from "./stability.ts";
import {
	type AppCatalogItem,
	type CatalogVersion,
	catalogLayerBadges,
	type PluginCatalogDetail,
} from "./types.ts";

/** The detail panel's tab set. Overview, Reviews and Health are ALWAYS present
 *  (see the `tabs` array below); the content tabs are conditional on the listing
 *  actually carrying that content. */
type DetailTabId =
	| "overview"
	| "readme"
	| "api"
	| "versions"
	| "dependencies"
	| "reviews"
	| "health";

export function AppDetailPanel({
	selectedId,
	item,
	detail,
	detailLoading,
	detailError,
	install,
	isInstalling,
	setEnabled,
	lifecyclePending,
	error,
	installLayer,
	installVersion,
	noun,
	renderAffordance,
	settingsOpener,
	switchChannel,
}: {
	selectedId: string | null;
	item: AppCatalogItem | null;
	detail: PluginCatalogDetail | null;
	detailLoading: boolean;
	detailError: string | null;
	install: (
		id?: string,
		options?: { channel?: string | null }
	) => Promise<void>;
	/** Shared busy predicate — the same one the list rows read. */
	isInstalling: (id: string) => boolean;
	/** Move an installed listing onto another release train; absent when the host
	 *  has no update seam, and the switch control then never renders. */
	switchChannel?: (id: string, channel: string | null) => Promise<void>;
	setEnabled: (enabled: boolean) => Promise<void>;
	lifecyclePending: boolean;
	error: string | null;
	installLayer: CatalogInstall | null;
	installVersion?: (id: string, version: CatalogVersion) => Promise<void>;
	noun: string;
	renderAffordance: CatalogHost["renderAffordance"];
	/** Resolves this listing to its "open settings" action (see the host seam). */
	settingsOpener: PluginSettingsOpener;
}) {
	const tl = useLiteralMessages();
	const host = useCatalogHost();
	const runScan = host.runCatalogScan;
	const auditNode = host.useActiveNode();
	const { Markdown, fetchVersionDetail: hostFetchVersionDetail } = host;
	// How much of this listing the user has asked to see. Read ONCE here and
	// threaded down as a narrow boolean: a detail panel must not learn the ladder,
	// or every new level becomes an edit in a dozen components. The
	// one-of-two-hooks shape is the file's existing convention (see
	// `useInstallingLookup` / `usePluginSettingsOpener` above) and keeps the render
	// to exactly one hook call either way.
	const useHostInterfaceLevel = host.useInterfaceLevel ?? useNoInterfaceLevel;
	const interfaceLevel = useHostInterfaceLevel();
	// Technical detail = the four dense tabs (API, Versions, Dependencies,
	// Health), the trust/tags rail, raw grant ids and capability strings. NOT the
	// grant LABELS — see `DependenciesPanel.showTechnical`.
	const showTechnical =
		interfaceLevel === "advanced" || interfaceLevel === "expert";
	// Reviews live on the control plane, reached through the money-layer host. Read
	// optionally: a surface that mounts the catalog without the money layer (test
	// harnesses, the storyboard) simply gets no Reviews tab.
	//
	// Community listings are excluded even when the service IS present: they were
	// discovered from a GitHub topic and have no record on the control plane, so a
	// review could never be stored against one. The tab would be permanently empty
	// and any attempt to post would fail with "item not found" — an affordance that
	// cannot work should not be offered.
	const reviewsHost = useMarketplaceHostOptional()?.reviews ?? null;
	const reviewsService = item && isCommunityEntry(item) ? null : reviewsHost;
	const [tab, setTab] = useState<DetailTabId>("overview");
	// Reset to Overview when the selection changes, so opening a second listing
	// never lands on a tab that listing does not have.
	// resetting is keyed
	// on the selection changing, not on the setter.
	useEffect(() => setTab("overview"), [selectedId]);

	// The scan needs the DETAIL payload, not just the card: half its checks read
	// fields only the detail fetch carries (README, licence, timestamps, declared
	// permissions). Grading a card alone would score every listing on a read-only
	// surface as "undocumented, unlicensed" — technically true of the card, and
	// completely misleading about the listing. So no detail ⇒ no grade shown.
	// Memoized so scrolling the panel does not re-run every check per frame.
	const scorecard = useMemo(
		() => (detail ? runScorecard(item?.entry ?? null, detail) : null),
		[item?.entry, detail]
	);

	if (!(selectedId && item)) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={GridIcon} />
					</EmptyMedia>
					<EmptyTitle>{tl("No {noun} selected", { noun })}</EmptyTitle>
					<EmptyDescription>
						{tl(
							"Pick a {noun} on the left to read what it does, review its permissions, and install it.",
							{ noun }
						)}
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	const { entry, grants, installed, enabled } = item;
	// The repo a version tag can be read from. `repositoryUrl` is the detail's
	// own field; `repo_url` is the card's — either names the same GitHub repo.
	const versionRepo = detail?.repositoryUrl ?? entry.repo_url ?? null;
	const integrationUrl =
		entry.integration_url ?? detail?.url ?? detail?.descriptor?.url ?? null;
	// The hero band always renders — it is the listing's header. This gates only
	// whether it paints the listing's ART: a descriptor-only entry's `banner` /
	// `icon_dither` describe the UPSTREAM service, so using them would present a
	// third-party brand as this listing's own. Those fall back to the muted band.
	//
	// It used to gate the whole hero, which is why a listing with no presentation
	// metadata opened on a bare heading in mid-air with no header at all.
	const showHero = !entry.descriptor_only;
	// An integrations.sh reference entry is descriptor-only AND carries an
	// integration kind. A community GitHub listing is also descriptor-only but has
	// no integration kind — it is a real plugin with a real manifest, so it gets
	// the full tab set rather than the integration blurb.
	const isIntegrationDescriptor = Boolean(
		entry.descriptor_only && entry.integration_kind
	);

	// The Overview tab is now PROSE + what-you-get. Everything reference-shaped
	// (Information, external links) moved to the shell's right rail, and the meta
	// facts moved to the stat strip — the two things that make a wide dialog read
	// as an app-store listing rather than one tall column with air beside it.
	const overview = (
		<div className="flex flex-col gap-6">
			{entry.description ? (
				<ListingSection icon={InformationCircleIcon} title="About">
					<p className="text-muted-foreground text-sm leading-relaxed">
						{entry.description}
					</p>
				</ListingSection>
			) : null}

			<SupportExtensionPanel detail={detail} entry={entry} />

			{isIntegrationDescriptor ? (
				<DescriptorDetail
					detail={detail}
					detailError={detailError}
					detailLoading={detailLoading}
					integrationUrl={integrationUrl}
				/>
			) : (
				<>
					<AppIncludedSection
						runnables={detail?.runnables ?? entry.runnables}
					/>

					<ListingSection icon={SquareLock01Icon} title="Permissions">
						{grants.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								This plugin requests no special permissions.
							</p>
						) : (
							<GrantList grants={grants} />
						)}
					</ListingSection>
				</>
			)}
		</div>
	);

	// Hero chips: the identity facts (Built-in / Community / Required / kinds).
	// Free-form `tags` stay OUT of the hero — a listing with nine of them turned
	// the header into a tag cloud — and live in the rail instead.
	// STATUS attributes leave the string row and become glyphs; "Community",
	// "Required", the stability word and the kind chips stay prose, because they
	// are facts ABOUT the listing rather than states OF it.
	const heroStatusIcons = entry.built_in ? (
		<StatusBadge kind="builtin" tone="hero" />
	) : null;
	const deprecation = resolveDeprecation(detail?.deprecated, entry.deprecated);
	const heroBadges = [
		isCommunityEntry(item) ? "Community" : null,
		deprecation ? DEPRECATED_LABEL : null,
		stabilityLabel(entry.stability),
		isMandatoryListing(entry) ? "Required" : null,
		// `companion` is deliberately dropped. Every app in the Apps tab IS a
		// companion — that is the definition of the tab (`isCompanionApp` is its
		// filter) — so the chip appeared on essentially every listing and told the
		// reader nothing. The remaining kinds still distinguish one listing from
		// another and stay.
		...entry.kinds
			.filter((k) => k !== "companion")
			.map((k) => runnableKindLabel(k)),
		...catalogLayerBadges(
			detail?.layers ?? entry.layers,
			detail?.external ?? entry.external
		),
	].filter((b): b is string => Boolean(b));

	return (
		<ListingDetailShell
			actions={
				<AppSecondaryActions
					error={error}
					item={item}
					onOpenSettings={settingsOpener(entry.id)}
					status={
						<>
							<PriceBadge entry={entry} />
							{entry.descriptor_only ? (
								<Badge variant="outline">
									{entry.integration_kind?.toUpperCase() ?? "Descriptor"}
								</Badge>
							) : (
								<AppStatusBadge enabled={enabled} installed={installed} />
							)}
						</>
					}
					switchChannel={switchChannel}
				/>
			}
			aside={
				<AppDetailAside
					detail={detail}
					entry={entry}
					onOpenHealth={() => setTab("health")}
					scorecard={scorecard}
					showTechnical={showTechnical}
				/>
			}
			gallery={
				<ListingGalleryRail
					name={entry.name}
					screenshots={detail?.screenshots ?? entry.screenshots}
				/>
			}
			hero={
				<AppHero
					actions={
						<>
							<AppPrimaryAction
								install={install}
								installing={isInstalling(entry.id)}
								installLayer={installLayer}
								installTaskId={pluginDownloadTaskId(entry.id)}
								item={item}
								lifecyclePending={lifecyclePending}
								modelProviders={detail?.apiSurface?.modelProviders}
								publisherTrust={
									detail?.orgVerified === undefined
										? entry.publisher_trust
										: detail.publisherTrust
								}
								renderAffordance={renderAffordance}
								setEnabled={setEnabled}
							/>
							{/* Same control, same namespace key as the card it was opened
							    from, so the two can never disagree about the total. It rides
							    the hero's own translucent chip treatment because the button
							    is deliberately chrome-free and inherits a muted foreground
							    that is invisible on a saturated wash. */}
							<ItemLikeButton
								className="rounded-full bg-background px-2 py-1 text-muted-foreground hover:text-foreground"
								namespace={entry.id}
								stopPropagation={false}
							/>
						</>
					}
					badges={heroBadges}
					detail={detail}
					entry={entry}
					showArt={showHero}
					statusIcons={heroStatusIcons}
				/>
			}
			notice={
				/* Load-bearing placement: unavoidable in the reading path BEFORE the
				   action bar, so it cannot be scrolled past on the way to Install. */
				deprecation || isCommunityEntry(item) ? (
					<div className="flex flex-col gap-3">
						{deprecation ? (
							<DeprecationNotice
								message={deprecation.message}
								name={entry.name}
								replacement={deprecation.replacement}
							/>
						) : null}
						{isCommunityEntry(item) ? (
							<CommunityTrustNotice
								tone="inline"
								topic={detail?.discoveredFrom?.topic}
							/>
						) : null}
					</div>
				) : null
			}
			stats={
				<ListingStatStrip
					items={appStatItems({
						detail,
						entry,
						onOpenHealth: () => setTab("health"),
						onOpenReviews: () => setTab("reviews"),
						scorecard,
						showTechnical,
						showRating: Boolean(reviewsService),
					})}
				/>
			}
		>
			{detailLoading && !isIntegrationDescriptor ? (
				<Spinner className="size-4" />
			) : null}
			{detailError && !isIntegrationDescriptor ? (
				<p className="text-sm text-status-destructive">{detailError}</p>
			) : null}

			<ListingDetailTabs
				activeTab={tab}
				agentScan={
					scorecard && runScan
						? () =>
								runScan({
									description: detail?.description ?? entry.description,
									files: detail?.designSystem?.files ?? undefined,
									id: entry.id,
									kind: "plugin",
									metadata: {
										developer: detail?.developer ?? entry.developer,
										designSystemNavigation: detail?.designSystem?.navigation,
										license: detail?.license ?? entry.license,
										origin: detail?.origin ?? entry.origin,
										repositoryUrl: detail?.repositoryUrl ?? entry.repo_url,
										version: detail?.version ?? entry.version,
									},
									name: entry.name,
									readme: detail?.readme,
									scorecard,
								})
						: undefined
				}
				detail={detail}
				entry={entry}
				fetchVersionDetail={
					// Offered only when the host can serve it AND the listing names a repo —
					// without one there is no tag to read from.
					hostFetchVersionDetail && versionRepo
						? (tag: string) => hostFetchVersionDetail(versionRepo, tag)
						: undefined
				}
				installVersion={
					installVersion &&
					installLayer &&
					!entry.descriptor_only &&
					!isCommunityEntry(item)
						? (version) => installVersion(entry.id, version)
						: undefined
				}
				key={auditNode.url}
				Markdown={Markdown}
				onOpenAuditConversation={host.openAuditConversation}
				onTabChange={setTab}
				overview={overview}
				reviewsService={reviewsService}
				scorecard={scorecard}
				showTechnical={showTechnical}
			/>
		</ListingDetailShell>
	);
}
