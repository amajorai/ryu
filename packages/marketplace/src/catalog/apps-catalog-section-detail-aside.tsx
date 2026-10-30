import {
	Package01Icon,
	PotionIcon,
	ServerStack01Icon,
	Target01Icon,
	WorkflowCircle06Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { StarRating } from "../star-rating.tsx";
import {
	AppInformationSection,
	appInfoRows,
} from "./apps-catalog-section-hero.tsx";
import { formatCount, formatDate } from "./detail/detail-panels.tsx";
import {
	ListingAsideCard,
	type ListingStat,
} from "./detail/listing-detail-shell.tsx";
import { ScorecardBadge } from "./detail/scorecard-panel.tsx";
import type { Scorecard } from "./scorecard.ts";
import { surfaceLabel } from "./surface-labels.ts";
import type { CatalogEntry, PluginCatalogDetail } from "./types.ts";

/** The stat strip's cells for an app/plugin listing. Built as data rather than
 *  markup so the same facts can be reordered per realm without each realm
 *  re-deriving them — and so an absent fact drops its whole cell rather than
 *  rendering an empty one, which is what makes the strip read as evenly divided
 *  at any listing's level of completeness. */
export function appStatItems({
	detail,
	entry,
	onOpenHealth,
	onOpenReviews,
	scorecard,
	showRating,
	showTechnical,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
	onOpenHealth: () => void;
	onOpenReviews: () => void;
	scorecard: Scorecard | null;
	showRating: boolean;
	/** Include the Health cell. It links to the Health tab, which the same flag
	 *  hides — so the two must move together. */
	showTechnical: boolean;
}): ListingStat[] {
	// Annotated as `(ListingStat | null)[]` so an absent fact contributes `null`
	// rather than widening the array's inferred element union per branch.
	const ratingCount = entry.rating_count ?? 0;
	const version = detail?.version ?? entry.version ?? null;
	const updated = formatDate(detail?.updatedAt);
	const downloads = detail?.downloads ?? null;
	const surfaces = detail?.surfaces ?? entry.surfaces ?? [];
	const developer = detail?.developer ?? entry.developer ?? null;
	const category = detail?.category ?? entry.category ?? null;

	const cells: (ListingStat | null)[] = [
		showRating && ratingCount > 0
			? {
					label: `${formatCount(ratingCount)} Ratings`,
					// Apple's shape exactly: the number is the headline, the stars are
					// the caption. Clicking the cell opens the tab that loads them.
					onClick: onOpenReviews,
					sub: (
						<StarRating
							className="justify-center"
							size="size-3"
							value={entry.rating_average ?? 0}
						/>
					),
					value: (entry.rating_average ?? 0).toFixed(1),
				}
			: null,
		// Gated with the Health TAB it jumps to, not independently: leaving the cell
		// behind a hidden tab is a click that silently does nothing.
		showTechnical && scorecard?.grade && scorecard.score !== null
			? {
					label: "Health",
					onClick: onOpenHealth,
					sub: `${scorecard.score}/100`,
					value: scorecard.grade,
				}
			: null,
		version && !entry.descriptor_only
			? { label: "Version", value: `v${version.replace(/^v/, "")}` }
			: null,
		category ? { label: "Category", value: category } : null,
		developer ? { label: "Developer", value: developer } : null,
		updated ? { label: "Updated", value: updated } : null,
		isNativeNumber(downloads)
			? { label: "Downloads", value: formatCount(downloads) }
			: null,
		surfaces.length > 0
			? {
					label: "Runs on",
					value: surfaces.map((s) => surfaceLabel(s)).join(", "),
				}
			: null,
	];
	return cells.filter((item): item is ListingStat => item !== null);
}

/** The detail shell's right rail for an app/plugin: Information, then the
 *  listing's free-form tags. This is the material that used to sit at the BOTTOM
 *  of the Overview tab, below permissions — i.e. below the fold on every listing —
 *  where "who made this, what licence, where's the privacy policy" is exactly what
 *  a store visitor is scanning for before they install. */
export function AppDetailAside({
	detail,
	entry,
	onOpenHealth,
	scorecard,
	showTechnical,
}: {
	detail: PluginCatalogDetail | null;
	entry: CatalogEntry;
	onOpenHealth: () => void;
	scorecard: Scorecard | null;
	/** Show the reference material a technical reader wants. The Information grid
	 *  (developer, category, version, licence, links) is NOT gated by it — that is
	 *  exactly what a non-technical buyer scans. */
	showTechnical: boolean;
}) {
	const detailPrompts = detail?.examplePrompts ?? entry.example_prompts ?? [];
	const detailCapabilities = detail?.capabilities ?? entry.capabilities ?? [];
	const keywords = entry.keywords ?? [];
	const showTags = entry.tags.length > 0;
	const showKeywords = keywords.length > 0;
	const showPrompts = detailPrompts.length > 0;
	const showCapabilities = detailCapabilities.length > 0;
	// The Trust card's only control jumps to the Health tab, which is itself hidden
	// at the same level — so gating them together is what stops Simple offering a
	// click that goes nowhere.
	const showTrust = Boolean(scorecard) && showTechnical;
	const hasInfo = appInfoRows({ detail, entry }).length > 0;
	if (
		!(
			hasInfo ||
			showTags ||
			showKeywords ||
			showPrompts ||
			showCapabilities ||
			showTrust
		)
	) {
		return null;
	}
	return (
		<>
			<AppInformationSection detail={detail} entry={entry} />
			{showTrust && scorecard ? (
				<ListingAsideCard title="Trust">
					<ScorecardBadge onClick={onOpenHealth} scorecard={scorecard} />
				</ListingAsideCard>
			) : null}
			{showTags ? (
				<ListingAsideCard title="Tags">
					<div className="flex flex-wrap gap-1">
						{entry.tags.map((t) => (
							<Badge key={t} typography="normal" variant="outline">
								{t}
							</Badge>
						))}
					</div>
				</ListingAsideCard>
			) : null}
			{showKeywords ? (
				<ListingAsideCard title="Keywords">
					<div className="flex flex-wrap gap-1">
						{keywords.map((keyword) => (
							<Badge key={keyword} typography="normal" variant="secondary">
								{keyword}
							</Badge>
						))}
					</div>
				</ListingAsideCard>
			) : null}
			{showCapabilities ? (
				<ListingAsideCard title="Capabilities">
					<ul className="flex flex-col gap-1 text-muted-foreground text-sm">
						{detailCapabilities.map((capability) => (
							<li key={capability}>{capability}</li>
						))}
					</ul>
				</ListingAsideCard>
			) : null}
			{showPrompts ? (
				<ListingAsideCard title="Example prompts">
					<ul className="flex flex-col gap-2 text-muted-foreground text-sm">
						{detailPrompts.map((prompt) => (
							<li className="rounded-lg bg-muted px-2.5 py-2" key={prompt}>
								{prompt}
							</li>
						))}
					</ul>
				</ListingAsideCard>
			) : null}
		</>
	);
}

/** Presentational icon per bundled-runnable kind. Falls back to a package glyph
 *  for unknown kinds so an unrecognized runnable still renders a row. */
const RUNNABLE_KIND_ICONS = new Map<string, typeof Package01Icon>(
	Object.entries({
		agent: Target01Icon,
		companion: Package01Icon,
		mcp: ServerStack01Icon,
		skill: PotionIcon,
		tool: Wrench01Icon,
		workflow: WorkflowCircle06Icon,
	})
);

/** Short human label per runnable kind (falls back to a capitalized kind). */
const RUNNABLE_KIND_LABELS = new Map(
	Object.entries({
		agent: "Agent",
		companion: "Companion",
		mcp: "MCP",
		skill: "Skill",
		tool: "Tool",
		workflow: "Workflow",
	})
);

function runnableKindIcon(kind: string): typeof Package01Icon {
	return RUNNABLE_KIND_ICONS.get(kind) ?? Package01Icon;
}

/** Exported for unit tests — see the note on {@link isCompanionApp}. */
export function runnableKindLabel(kind: string): string {
	return (
		RUNNABLE_KIND_LABELS.get(kind) ??
		kind.charAt(0).toUpperCase() + kind.slice(1)
	);
}

/** "What's included": a read-only list of the bundled runnables a full app ships
 *  (desktop-only — `detail.runnables` is absent on the web read-only host, so the
 *  section renders nothing there). Informational rows, not functional toggles. */
export function AppIncludedSection({
	runnables,
}: {
	runnables?: PluginCatalogDetail["runnables"];
}) {
	if (!runnables || runnables.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-col gap-2">
			<h3 className="flex items-center gap-1.5 font-medium text-sm">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={Package01Icon}
				/>
				What&apos;s included
			</h3>
			<ul className="flex flex-col gap-1.5">
				{runnables.map((runnable) => (
					<li
						className="flex items-center gap-2.5 rounded-lg bg-muted px-3 py-2"
						key={runnable.id}
					>
						<HugeiconsIcon
							className="size-4 shrink-0 text-muted-foreground"
							icon={runnableKindIcon(runnable.kind)}
						/>
						<span className="min-w-0 flex-1 truncate text-sm">
							{runnable.name ?? runnable.id}
						</span>
						{/* The kind chip, EXCEPT for `companion`. In the Apps tab every
						    listing is one, so the badge repeated on every row of every
						    listing and distinguished nothing; the row's own glyph already
						    carries the kind. Deleting the map entry would not have done it
						    — `runnableKindLabel` falls back to a capitalized raw kind and
						    would still have printed "Companion". */}
						{runnable.kind === "companion" ? null : (
							<Badge className="shrink-0" variant="secondary">
								{runnableKindLabel(runnable.kind)}
							</Badge>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}
