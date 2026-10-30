"use client";
// Presentational layer of the desktop Store. The live Store shell
// (`apps/desktop/src/pages/StorePage.tsx`) and the Agents catalog section
// (`apps/desktop/src/components/store/AgentsCatalogSection.tsx`) consume these
// components; the storyboard renders the same components with mock data and no-op
// handlers. One source of truth, so editing this block changes the real desktop
// too.
//
// Scope note: the Store is a multi-section shell — most sections (Plugins, Models,
// Skills, MCP, Engines, Services) are deeply hook-coupled master-detail surfaces
// kept in their own files. This block extracts the shared chrome: the section tab
// nav, the generic catalog card + its install/lifecycle action button, the card
// grid, and the "coming soon" placeholder. The storyboard's Store screen renders a
// generic catalog grid via these, which faithfully matches the section shell.
//
// The search field lives in `store-search.tsx` and the generic catalog cards in
// `store-catalog-card.tsx`; both are re-exported here so import paths stay stable.

import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString, useOptionalI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { noop } from "./store-catalog-card.tsx";
import { StoreSectionMore, splitStoreSections } from "./store-section-more.tsx";

export type {
	StoreCatalogCardData,
	StoreItemState,
} from "./store-catalog-card.tsx";
export {
	StoreCardGrid,
	StoreCardRating,
	StoreCatalogCard,
	StoreItemAction,
	StoreLoadingGrid,
} from "./store-catalog-card.tsx";
export { StoreGlobalSearch, StoreSearchButton } from "./store-search.tsx";

export interface StoreSectionTab {
	/** Total items in the section. This is intentionally separate from the
	 * currently loaded page length so paginated catalogs can report an
	 * authoritative total without lying in the tab chrome. */
	count?: number;
	/** Optional cluster key (Discover, Money, …). Kept for callers that order or
	 *  filter by it; the strip itself no longer draws dividers between groups. */
	group?: string;
	/**
	 * The pill glyph. A `IconSvgElement` for the shell's own sections (authored
	 * against Hugeicons), or a STRING icon id for an app-registered tab, whose
	 * manifest can only carry a name — resolved through the shared `<Icon>`
	 * primitive (Iconify `prefix:name`, a bare Hugeicons name, or a URL).
	 */
	icon: IconSvgElement | string;
	/**
	 * A rendered glyph that REPLACES `icon` for this tab — for a section whose
	 * mark is a component rather than a path set (Agents wears the animated Ryu
	 * logo). A separate slot rather than widening `icon`: `IconSvgElement` is an
	 * array type and so is a `ReactNode` fragment, so a `typeof icon === "string"`
	 * narrowing cannot tell the two apart and would hand a component to
	 * `HugeiconsIcon`. `icon` stays required so every tab keeps a path fallback.
	 */
	iconNode?: ReactNode;
	label: string;
	value: string;
}

/** Render either glyph form of a {@link StoreSectionTab.icon}. */
function SectionTabIcon({
	icon,
	iconNode,
}: {
	icon: IconSvgElement | string;
	iconNode?: ReactNode;
}) {
	if (iconNode) {
		return (
			<span className="flex size-4 shrink-0 items-center">{iconNode}</span>
		);
	}
	if (isNativeText(icon)) {
		return <Icon className="shrink-0" icon={icon} size={16} />;
	}
	if (!Array.isArray(icon)) {
		return null;
	}
	return <HugeiconsIcon className="size-4 shrink-0" icon={icon} />;
}

/**
 * The section tabs for a multi-section shell (the Store, the Library), rendered
 * INLINE at the top of the page as an ordinary element.
 *
 * This used to be a floating, bottom-fixed pill bar over a translucent
 * `bg-muted/70` backdrop, with the search field and the filter panel folded into
 * it. That bar had to be discovered, it covered the last row of whatever was
 * behind it, its icon-only pills only revealed their labels on hover, and it grew
 * every time an app registered a section — which it now does, so the list is
 * open-ended by design. Tabs belong in the page flow, at the top, labelled: they
 * scroll with a long list instead of wrapping into a floating blob, and the
 * controls that used to hide inside them (search, source, filters) are ordinary
 * toolbar buttons beside the content they act on.
 *
 * The one thing that DID come back to the bottom of the page is the Store's
 * global search field (`StoreBottomSearch`) — a single bare input, not a bar of
 * chrome, and the shell pads its content column by the bar's height so the last
 * row stays reachable. That was the old bar's actual sin; being at the bottom
 * was not.
 *
 * The strip is the shared `muted-pills` tab variant
 * (`@ryu/ui/components/tabs.tsx`) rather than hand-rolled buttons, so it inherits
 * Base UI's roving arrow-key navigation. The active section is a muted wash, not
 * an inverted pill: the strip is navigation under the search, not the loudest
 * control on the page. Counts show only when there is something to count, at the
 * tertiary muted tone.
 *
 * `primaryValues` caps the strip: only those sections show as tabs, the rest sit
 * behind a "More" menu ({@link StoreSectionMore}), and an active overflow section
 * is promoted into the strip so the selected tab is always visible. Without it the
 * strip lists every section and the shared `TabsList` scrolls the overflow.
 */
export function StoreSectionTabs({
	sections,
	active,
	onSelect = noop,
	className,
	inset,
	primaryValues,
}: {
	active: string;
	className?: string;
	inset?: "store-sections" | "library-sections";
	onSelect?: (value: string) => void;
	/** Sections shown as tabs; everything else moves into "More". */
	primaryValues?: readonly string[];
	sections: StoreSectionTab[];
}) {
	const i18n = useOptionalI18n();
	const localizedSectionsLabel = useLocalizedString("Sections");
	const { overflow, visible } = splitStoreSections(
		sections,
		active,
		primaryValues
	);
	return (
		<div className={cn("flex w-full min-w-0 items-center gap-1", className)}>
			<Tabs
				className="min-w-0 shrink"
				inset={inset}
				onValueChange={(value) => onSelect(String(value))}
				value={active}
			>
				<TabsList
					aria-label={localizedSectionsLabel}
					className="max-w-full flex-nowrap"
					data-slot="store-section-tabs-scroller"
					manageLayout={false}
					variant="muted-pills"
				>
					{visible.map((s) => (
						<TabsTrigger
							className="h-8 shrink-0 gap-2 px-3! py-0! text-sm!"
							key={s.value}
							value={s.value}
						>
							<SectionTabIcon icon={s.icon} iconNode={s.iconNode} />
							<span className="whitespace-nowrap">
								{i18n?.t(`marketplace.section.${s.value}`, {}, s.label) ??
									s.label}
							</span>
							{s.count !== undefined && s.count > 0 ? (
								<span
									className="text-muted-foreground/70 text-xs tabular-nums"
									data-slot="store-section-tab-count"
								>
									{formatCount(s.count)}
								</span>
							) : null}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			<StoreSectionMore items={overflow} onSelect={onSelect} />
		</div>
	);
}

/** Placeholder shown for sections whose catalog is not wired up yet. */
export function StoreComingSoon({
	icon,
	label,
	onBrowse,
}: {
	icon: IconSvgElement;
	label: string;
	onBrowse?: () => void;
}) {
	const i18n = useOptionalI18n();
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={icon} />
				</EmptyMedia>
				<EmptyTitle>
					{i18n?.t(
						"marketplace.coming-soon",
						{ label },
						`${label} coming soon`
					) ?? `${label} coming soon`}
				</EmptyTitle>
				<EmptyDescription>
					{i18n?.t(
						"marketplace.coming-soon-description",
						{ label: label.toLowerCase() },
						`Browsing and installing ${label.toLowerCase()} from the Store is on the way.`
					) ??
						`Browsing and installing ${label.toLowerCase()} from the Store is on the way.`}
				</EmptyDescription>
			</EmptyHeader>
			{onBrowse ? (
				<EmptyContent>
					<Button onClick={onBrowse} size="sm">
						{i18n?.t(
							"marketplace.browse-home",
							undefined,
							"Browse the Store home"
						) ?? "Browse the Store home"}
					</Button>
				</EmptyContent>
			) : null}
		</Empty>
	);
}
