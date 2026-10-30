// packages/marketplace/src/catalog/detail/listing-detail-tabs.tsx
//
// The tabbed body of a listing's detail view — README, API, Versions,
// Dependencies, Reviews, Health.
//
// Extracted so the STORE and the INSTALLED list render the same thing. They used
// to diverge badly: browsing a listing gave you the full tab set, and then
// selecting that very same app under Store → Installed dropped you into a
// separate renderer with no README, no version history, no health grade and no
// reviews. Installing an app made its documentation disappear, which is exactly
// backwards.
//
// `overview` is optional because the two hosts differ in one honest way: the store
// panel leads with an Overview tab (description, permissions, bundled runnables),
// while the installed view already renders its own header with the lifecycle
// controls — enable/disable, uninstall, launch, grants — and wants these tabs
// BELOW it, not wrapped around a duplicate summary. Passing the node in keeps one
// tab implementation rather than two that drift.

import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import type { ComponentType, ReactNode } from "react";
import { useMemo, useState } from "react";
import type { MarketplaceReviewsService } from "../../host.tsx";
import type { MarketplaceKind } from "../../types.ts";
import type { CatalogScanResult } from "../host.tsx";
import type { Scorecard } from "../scorecard.ts";
import { runScorecard } from "../scorecard.ts";
import type {
	CatalogEntry,
	CatalogVersion,
	PluginCatalogDetail,
	VersionSnapshot,
} from "../types.ts";
import { ApiReferencePanel, hasApiSurface } from "./api-reference-panel.tsx";
import {
	DependenciesPanel,
	hasDependencies,
	ReadmePanel,
	VersionsPanel,
} from "./detail-panels.tsx";
import ReviewsPanel from "./reviews-panel.tsx";
import { ScorecardPanel } from "./scorecard-panel.tsx";

export type DetailTabId =
	| "overview"
	| "readme"
	| "api"
	| "versions"
	| "dependencies"
	| "reviews"
	| "health";

export function ListingDetailTabs({
	agentScan,
	onOpenAuditConversation,
	entry,
	detail,
	Markdown,
	reviewsService,
	overview,
	scorecard: scorecardProp,
	developerDoctor,
	developerEvals,
	showTechnical = true,
	activeTab: activeTabProp,
	onTabChange,
	kind = "plugin",
	fetchVersionDetail,
	installVersion,
}: {
	/** Optional configured-agent review. Omitted on read-only hosts. */
	agentScan?: () => Promise<CatalogScanResult>;
	onOpenAuditConversation?: (id: string) => void;
	entry: CatalogEntry;
	detail: PluginCatalogDetail | null;
	/** Markdown renderer — crosses the host seam (desktop uses Streamdown, web
	 *  react-markdown), so the component is injected rather than imported. */
	Markdown: ComponentType<{ className?: string; content: string }>;
	/** Absent on hosts with no review service (the read-only web catalog). */
	reviewsService?: MarketplaceReviewsService | null;
	/** Optional leading Overview tab. Omitted by hosts that render their own
	 *  header instead — see the module comment. */
	overview?: ReactNode;
	/** Pre-computed grade. Passed in by a host that already renders a scorecard
	 *  BADGE in its header, so the same listing is graded once rather than twice
	 *  and the badge can never disagree with the Health tab. */
	scorecard?: Scorecard | null;
	/** Optional host action for a live installed-artifact doctor. */
	developerDoctor?: ReactNode;
	/** Optional host action for package-level behavioral evaluations. */
	developerEvals?: ReactNode;
	/** Show the technical tabs (API, Versions, Dependencies, Health).
	 *
	 *  Defaults to TRUE so every existing caller — the web marketplace, the desktop
	 *  Installed section, the e2e harness — is byte-identical without touching it.
	 *  Only a host that can actually ask the user how much they want to see
	 *  (`CatalogHost.useInterfaceLevel`) ever passes false. */
	showTechnical?: boolean;
	/** Controlled tab, for hosts whose header links INTO a tab — the store panel's
	 *  star rating jumps to Reviews and its health badge jumps to Health. Without
	 *  this the state would be trapped in here and those links would do nothing. */
	activeTab?: DetailTabId;
	onTabChange?: (id: DetailTabId) => void;
	/** Which realm this listing belongs to, for the reviews service.
	 *
	 *  Defaults to `"plugin"` because that is where these tabs started and it keeps
	 *  every existing caller byte-identical. It was HARDCODED, which is what stopped
	 *  skills / models / MCP reusing this panel: their reviews would have been filed
	 *  against the plugin realm, so a skill's rating would land on a plugin of the
	 *  same id — silently attributing one listing's reviews to another.
	 *
	 *  IMPORTANT for non-plugin realms: pass `scorecard={null}` as well. The grade
	 *  is computed from PLUGIN-manifest signals — `engines`, `permission-breadth`,
	 *  `network-surface`, `filesystem`, `install-path`, `manifest-integrity` — none
	 *  of which a skill or a model has an equivalent for. Letting it run would mark
	 *  a perfectly good skill down for failing to declare permissions it cannot
	 *  have, and present that as an authoritative health grade. A realm needs its
	 *  own checks before it earns a Health tab. */
	kind?: MarketplaceKind;
	/** Host-supplied reader for one version's "as published" snapshot. Omitted by
	 *  hosts with no such endpoint (the web catalog), which hides the affordance
	 *  rather than showing one that cannot resolve. */
	fetchVersionDetail?: (tag: string) => Promise<VersionSnapshot | null>;
	/** Exact-version install/update action. Omitted on read-only or browse-only
	 *  surfaces. */
	installVersion?: (version: CatalogVersion) => Promise<void>;
}) {
	const [uncontrolledTab, setUncontrolledTab] = useState<DetailTabId>(
		overview ? "overview" : "readme"
	);
	const tab = activeTabProp ?? uncontrolledTab;
	const setTab = onTabChange ?? setUncontrolledTab;

	// The scan needs the DETAIL payload, not just the card: half its checks read
	// fields only the detail fetch carries (README, licence, timestamps, declared
	// permissions). Grading a card alone would score every listing as
	// "undocumented, unlicensed" — true of the card, and completely misleading
	// about the listing. So no detail ⇒ no grade shown. Memoized so scrolling does
	// not re-run every check per frame.
	const ownScorecard = useMemo(
		() =>
			detail && scorecardProp === undefined
				? runScorecard(entry, detail)
				: null,
		[entry, detail, scorecardProp]
	);
	const scorecard = scorecardProp ?? ownScorecard;

	const readme = detail?.readme?.trim() ?? "";
	const versions = detail?.versions ?? [];
	// The four TECHNICAL tabs collapse at the lower interface levels. Folded into
	// the existing predicates rather than added as a second condition at each of
	// the eight sites (four tab entries + four panels), so a tab and its panel
	// cannot disagree about whether they exist.
	//
	// Overview, README and Reviews are never gated: they are what a listing IS.
	const showApi = hasApiSurface(detail?.apiSurface) && showTechnical;
	const showDeps = hasDependencies(detail, entry) && showTechnical;
	const showVersions = versions.length > 0 && showTechnical;
	const showHealth = Boolean(scorecard) && showTechnical;

	// Reviews and Health are UNCONDITIONAL (given a review service / a loaded
	// detail). They were once conditional on content, which made the tab row
	// inconsistent between listings: one arrived with a README and a full signal
	// set and showed every tab, another showed a lone Overview. The tab row is
	// navigation — it should not appear and disappear per listing — and an unrated
	// item or a thin scorecard is information the user asked for, not a reason to
	// hide the tab. Content tabs stay conditional: an absent README has nothing to
	// render at all, whereas "no reviews yet" does.
	const tabs: { id: DetailTabId; label: string }[] = [
		...(overview ? [{ id: "overview" as const, label: "Overview" }] : []),
		...(readme ? [{ id: "readme" as const, label: "README" }] : []),
		...(showApi ? [{ id: "api" as const, label: "API" }] : []),
		...(showVersions ? [{ id: "versions" as const, label: "Versions" }] : []),
		...(showDeps
			? [{ id: "dependencies" as const, label: "Dependencies" }]
			: []),
		...(reviewsService ? [{ id: "reviews" as const, label: "Reviews" }] : []),
		...(showHealth ? [{ id: "health" as const, label: "Health" }] : []),
	];

	if (tabs.length === 0) {
		return null;
	}
	// A single tab is a label, not navigation — render the body bare.
	if (tabs.length === 1 && overview) {
		return <>{overview}</>;
	}

	// Guard against a tab that vanished while it was selected (the detail request
	// resolving can remove tabs as well as add them).
	const activeTab = tabs.some((t) => t.id === tab)
		? tab
		: (tabs[0]?.id ?? "overview");

	return (
		<Tabs
			onValueChange={(value: string) =>
				// SAFETY: Each trigger below receives the authored DetailTabId row's id; Tabs
				// forwards that selected value unchanged. This restores that producer
				// type for the callback. It does not validate synthetic callback values
				// or change the existing vanished-tab fallback at runtime.
				setTab(value as DetailTabId)
			}
			value={activeTab}
		>
			{/* `muted-pills` matches the Store's section strip: the active tab is a
			    muted wash, not an inverted pill. Deliberately NO <TabsIndicator />:
			    tabs.tsx hands the active background from the trigger to the
			    indicator whenever one is present. h-auto/flex-wrap so a seven-tab
			    row wraps instead of being crushed. */}
			<TabsList layout="listing-detail" sticky variant="muted-pills">
				{tabs.map((t) => (
					<TabsTrigger
						className="h-8 px-3! py-0! text-sm!"
						key={t.id}
						value={t.id}
					>
						{t.label}
					</TabsTrigger>
				))}
			</TabsList>
			{overview ? (
				<TabsContent inset="listing-detail" value="overview">
					{overview}
				</TabsContent>
			) : null}
			{readme ? (
				<TabsContent inset="listing-detail" value="readme">
					<ReadmePanel
						Markdown={Markdown}
						readme={readme}
						readmeUrl={detail?.readmeUrl}
					/>
				</TabsContent>
			) : null}
			{detail?.apiSurface && showApi ? (
				<TabsContent inset="listing-detail" value="api">
					<ApiReferencePanel surface={detail.apiSurface} />
				</TabsContent>
			) : null}
			{showVersions ? (
				<TabsContent inset="listing-detail" value="versions">
					<VersionsPanel
						fetchVersionDetail={fetchVersionDetail}
						installVersion={installVersion}
						versions={versions}
					/>
				</TabsContent>
			) : null}
			{showDeps ? (
				<TabsContent inset="listing-detail" value="dependencies">
					<DependenciesPanel
						detail={detail}
						entry={entry}
						showTechnical={showTechnical}
					/>
				</TabsContent>
			) : null}
			{reviewsService ? (
				<TabsContent inset="listing-detail" value="reviews">
					<ReviewsPanel id={entry.id} kind={kind} service={reviewsService} />
				</TabsContent>
			) : null}
			{showHealth && scorecard ? (
				<TabsContent inset="listing-detail" value="health">
					<ScorecardPanel
						agentScan={agentScan}
						developerCommand={`ryu plugin doctor ${entry.id}`}
						developerDoctor={developerDoctor}
						developerEvals={developerEvals}
						key={JSON.stringify([entry, detail])}
						onOpenConversation={onOpenAuditConversation}
						scorecard={scorecard}
					/>
				</TabsContent>
			) : null}
		</Tabs>
	);
}
