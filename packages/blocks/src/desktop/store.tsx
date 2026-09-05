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

import {
	Cancel01Icon,
	Search01Icon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString, useOptionalI18n } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
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
import { Input } from "@ryu/ui/components/input.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";

export interface StoreSectionTab {
	/** Total items in the section. This is intentionally separate from the
	 * currently loaded page length so paginated catalogs can report an
	 * authoritative total without lying in the tab chrome. */
	count?: number;
	/**
	 * Optional cluster key. Adjacent sections sharing a group render together; a
	 * thin divider is drawn where the group changes, so the wrapped pill reads as
	 * labelled clusters (Discover · Build · Manage · Account) without needing a
	 * separate grouped-nav component.
	 */
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
	if (typeof icon === "string") {
		return <Icon className="shrink-0" icon={icon} size={16} />;
	}
	if (!Array.isArray(icon)) {
		return null;
	}
	return <HugeiconsIcon className="size-4 shrink-0" icon={icon} />;
}

const noop = () => {
	// Default no-op handler for the presentational layer.
};

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
 * The strip is the shared `pills` tab variant (`@ryu/ui/components/tabs.tsx`)
 * rather than hand-rolled buttons, so it wears the same active pill as every
 * other tab strip in the app and inherits Base UI's roving arrow-key navigation.
 * `pills`, not `pills-lg`: this is an open-ended, horizontally scrolling section
 * nav under a page title, not the primary control of the surface, and a
 * 56px-tall pill × a dozen sections reads as a toolbar, not a nav. The shared
 * `TabsList` owns the overflow behavior: it stays on one line, fades only the
 * edges that still have content, hides the native scrollbar, and reveals a
 * compact hover popover with fully rounded back/forward buttons. That keeps the
 * behavior at the tab primitive instead of making Library and Store each carry
 * a second scrolling wrapper.
 *
 * A thin divider is drawn wherever `group` changes, so clusters still read as
 * clusters without a second component.
 */
export function StoreSectionTabs({
	sections,
	active,
	onSelect = noop,
	className,
}: {
	active: string;
	className?: string;
	onSelect?: (value: string) => void;
	sections: StoreSectionTab[];
}) {
	const i18n = useOptionalI18n();
	const localizedSectionsLabel = useLocalizedString("Sections");
	return (
		<Tabs
			className={cn("w-full min-w-0", className)}
			onValueChange={(value) => onSelect(String(value))}
			value={active}
		>
			<TabsList
				aria-label={localizedSectionsLabel}
				className="w-full flex-nowrap"
				data-slot="store-section-tabs-scroller"
				manageLayout={false}
				variant="pills"
			>
				{sections.map((s, i) => {
					const prev = i > 0 ? sections[i - 1] : undefined;
					const showDivider = Boolean(prev && prev.group !== s.group);
					return (
						<Fragment key={s.value}>
							{showDivider ? (
								<span
									aria-hidden
									className="mx-1 h-4 w-px shrink-0 self-center bg-border"
								/>
							) : null}
							<TabsTrigger className="shrink-0 gap-1.5" value={s.value}>
								<SectionTabIcon icon={s.icon} iconNode={s.iconNode} />
								<span className="whitespace-nowrap">
									{i18n?.t(`marketplace.section.${s.value}`, {}, s.label) ??
										s.label}
								</span>
								{s.count === undefined ? null : (
									<span
										className="text-muted-foreground tabular-nums"
										data-slot="store-section-tab-count"
									>
										{formatCount(s.count) ?? "—"}
									</span>
								)}
							</TabsTrigger>
						</Fragment>
					);
				})}
			</TabsList>
		</Tabs>
	);
}

/**
 * The Store's / Library's GLOBAL search: one large muted pill, in the page flow,
 * ABOVE the section tabs.
 *
 * It used to float at the bottom of the page (`StoreBottomSearch`), pinned
 * `absolute` over a padded content column. Two things were wrong with that. The
 * control that searches EVERYTHING sat below the tabs that scope a search to one
 * realm, so the page read bottom-up; and it forced every section in the shell to
 * reserve height for it whether or not it was scrolled to. Above the tabs it
 * reads in the order it works — search everything, or pick a realm — and the
 * shell's title row, which said nothing the tab strip did not already say, is
 * gone with it.
 *
 * `size="lg"` is the default because this is the primary control of the surface;
 * the compact expanding {@link StoreSearchButton} still exists for per-section
 * toolbars, which are scoped searches sitting beside a list.
 *
 * The row's trailing slot (`trailing`) holds the section's own filter/source
 * controls, so the search and the things that narrow it stay on one line.
 */
export function StoreGlobalSearch({
	value,
	onChange,
	placeholder = "Search…",
	className,
	trailing,
	size = "lg",
}: {
	className?: string;
	onChange: (value: string) => void;
	placeholder?: string;
	size?: "default" | "lg";
	/** Filter / source controls rendered beside the field, outside its pill. */
	trailing?: ReactNode;
	value: string;
}) {
	const localizedPlaceholder = useLocalizedString(placeholder);
	return (
		<div className={cn("flex w-full min-w-0 items-center gap-2", className)}>
			<div
				className={cn(
					"flex min-w-0 flex-1 items-center gap-2 rounded-full bg-muted px-4",
					size === "lg" ? "h-11" : "h-9"
				)}
			>
				<HugeiconsIcon
					aria-hidden
					className="size-4 shrink-0 text-muted-foreground"
					icon={Search01Icon}
				/>
				<input
					aria-label={localizedPlaceholder}
					// `type=search` for the semantics (role=searchbox), with the native
					// WebKit clear glyph suppressed — the row already has an explicit
					// Clear button, and two clear affordances in one field is chrome the
					// bare-input brief exists to avoid.
					className="h-full w-full min-w-0 border-none bg-transparent text-sm outline-none placeholder:text-muted-foreground focus:outline-none focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none"
					data-slot="store-global-search"
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Escape" && value.length > 0) {
							onChange("");
						}
					}}
					placeholder={localizedPlaceholder}
					type="search"
					value={value}
				/>
				{value ? (
					<Button
						aria-label="Clear search"
						className="shrink-0"
						onClick={() => onChange("")}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
					</Button>
				) : null}
			</div>
			{trailing}
		</div>
	);
}

/**
 * A search control shaped like the toolbar buttons beside it: a compact button
 * that expands into its input in place, and collapses again on Escape / an
 * outside click / blur while empty.
 *
 * A permanently-open full-width field is the wrong default for these pages — most
 * visits browse rather than search, and the field pushed the source and filter
 * buttons onto their own row. Expanding in place keeps one toolbar row and keeps
 * a non-empty query visible (it never auto-collapses while it has text).
 */
export function StoreSearchButton({
	value,
	onChange,
	placeholder = "Search…",
	className,
}: {
	className?: string;
	onChange: (value: string) => void;
	placeholder?: string;
	value: string;
}) {
	const localizedPlaceholder = useLocalizedString(placeholder);
	const localizedSearch = useLocalizedString("Search");
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const expanded = open || value.length > 0;

	useEffect(() => {
		if (open) {
			inputRef.current?.focus();
		}
	}, [open]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setOpen(false);
			}
		};
		const onPointer = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onPointer);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onPointer);
		};
	}, [open]);

	return (
		<div className={cn("flex items-center", className)} ref={rootRef}>
			<Button
				aria-label="Search"
				className="gap-1.5"
				onClick={() => setOpen((prev) => !prev)}
				size="sm"
				variant={expanded ? "secondary" : "ghost"}
			>
				<HugeiconsIcon className="size-3.5" icon={Search01Icon} />
				{expanded ? null : localizedSearch}
			</Button>
			<div
				className={cn(
					"grid transition-[grid-template-columns] duration-200 ease-out",
					expanded ? "grid-cols-[1fr]" : "grid-cols-[0fr]"
				)}
			>
				<div className="min-w-0 overflow-hidden">
					<Input
						aria-hidden={!expanded}
						className="h-8 w-56 max-w-[40vw] border-none bg-transparent shadow-none focus-visible:ring-0"
						onChange={(e) => onChange(e.target.value)}
						placeholder={localizedPlaceholder}
						ref={inputRef}
						tabIndex={expanded ? 0 : -1}
						value={value}
					/>
				</div>
			</div>
			{value ? (
				<Button
					aria-label="Clear search"
					onClick={() => {
						onChange("");
						setOpen(false);
					}}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
				</Button>
			) : null}
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

export type StoreItemState =
	| "available"
	| "installing"
	| "installed"
	| "failed";

/** The install / lifecycle action cluster for a generic catalog card. */
export function StoreItemAction({
	state,
	progressLabel,
	onInstall = noop,
	onUninstall = noop,
	onRetry = noop,
}: {
	state: StoreItemState;
	/** Optional progress text shown while installing (e.g. "Adding 48%"). */
	progressLabel?: string;
	onInstall?: () => void;
	onUninstall?: () => void;
	onRetry?: () => void;
}) {
	const i18n = useOptionalI18n();
	if (state === "installing") {
		return (
			<span className="flex items-center gap-2 text-muted-foreground text-xs">
				<Spinner className="size-3.5" />{" "}
				{progressLabel ??
					i18n?.t("marketplace.adding", undefined, "Adding…") ??
					"Adding…"}
			</span>
		);
	}
	if (state === "installed") {
		return (
			<div className="flex items-center gap-2">
				<Badge variant="secondary">
					{i18n?.t("common.added", undefined, "Added") ?? "Added"}
				</Badge>
				<Button onClick={onUninstall} size="sm" variant="ghost">
					{i18n?.t("common.remove") ?? "Remove"}
				</Button>
			</div>
		);
	}
	if (state === "failed") {
		return (
			<div className="flex items-center gap-2">
				<Badge variant="destructive">
					{i18n?.t("common.failed", undefined, "Failed") ?? "Failed"}
				</Badge>
				<Button onClick={onRetry} size="sm" variant="ghost">
					{i18n?.t("common.retry") ?? "Retry"}
				</Button>
			</div>
		);
	}
	return (
		<Button
			className="self-start"
			onClick={onInstall}
			size="sm"
			variant="ghost"
		>
			{i18n?.t("common.add") ?? "Add"}
		</Button>
	);
}

export interface StoreCatalogCardData {
	/** Store-taxonomy category (unused by the card chrome, carried for callers). */
	category?: string | null;
	description: string;
	/** Resolvable logo URL; falls back to the item's initial when null/absent. */
	iconUrl?: string | null;
	name: string;
	progressLabel?: string;
	/** Mean review rating; the compact star row renders when `ratingCount > 0`. */
	ratingAverage?: number;
	/** Number of reviews behind the average. */
	ratingCount?: number;
	state: StoreItemState;
	/** Short category/kind chip rendered top-right. */
	tag?: string;
}

/** Item logo, or an initial-letter placeholder when no icon URL is set. */
function StoreCardLogo({
	iconUrl,
	name,
}: {
	iconUrl?: string | null;
	name: string;
}) {
	if (iconUrl) {
		return (
			<img
				alt={`${name} logo`}
				className="size-9 shrink-0 rounded-lg border border-border object-cover"
				loading="lazy"
				src={iconUrl}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted font-medium text-muted-foreground text-sm uppercase"
		>
			{name.trim().charAt(0) || "?"}
		</span>
	);
}

/** Compact "★ 4.5 (12)" rating row; renders only when there are reviews. */
export function StoreCardRating({
	average,
	count,
}: {
	average?: number;
	count?: number;
}) {
	if (!count || count <= 0) {
		return null;
	}
	return (
		<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
			<HugeiconsIcon
				aria-hidden="true"
				className="size-3.5 text-amber-400"
				icon={StarIcon}
			/>
			<span className="font-medium text-foreground tabular-nums">
				{(Math.round((average ?? 0) * 10) / 10).toFixed(1)}
			</span>
			<span className="tabular-nums">({formatCount(count) ?? "—"})</span>
		</span>
	);
}

/** A generic catalog card: logo, name, kind chip, rating, description, action. */
export function StoreCatalogCard({
	item,
	onInstall = noop,
	onUninstall = noop,
	onRetry = noop,
}: {
	item: StoreCatalogCardData;
	onInstall?: () => void;
	onUninstall?: () => void;
	onRetry?: () => void;
}) {
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
			<div className="flex items-start justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2.5">
					<StoreCardLogo iconUrl={item.iconUrl} name={item.name} />
					<div className="min-w-0">
						<span className="block truncate font-medium">{item.name}</span>
						<StoreCardRating
							average={item.ratingAverage}
							count={item.ratingCount}
						/>
					</div>
				</div>
				{item.tag ? <Badge variant="outline">{item.tag}</Badge> : null}
			</div>
			<p className="flex-1 text-muted-foreground text-sm">{item.description}</p>
			<StoreItemAction
				onInstall={onInstall}
				onRetry={onRetry}
				onUninstall={onUninstall}
				progressLabel={item.progressLabel}
				state={item.state}
			/>
		</div>
	);
}

/** Two-column responsive grid for catalog cards. */
export function StoreCardGrid({ children }: { children: ReactNode }) {
	return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

/** Skeleton card grid for the loading state. */
export function StoreLoadingGrid({ count = 4 }: { count?: number }) {
	return (
		<div className="scroll-fade grid flex-1 grid-cols-2 gap-3 overflow-auto p-4">
			{Array.from({ length: count }, (_, i) => i).map((i) => (
				<div
					className="space-y-3 rounded-xl border border-border bg-card p-4"
					key={i}
				>
					<div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
					<div className="h-3 w-3/4 animate-pulse rounded bg-muted/60" />
					<div className="h-7 w-20 animate-pulse rounded bg-muted/60" />
				</div>
			))}
		</div>
	);
}
