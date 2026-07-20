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
	ArrowUp01Icon,
	Cancel01Icon,
	Search01Icon,
	SlidersHorizontalIcon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import { cn } from "@ryu/ui/lib/utils";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";

export interface StoreSectionTab {
	/**
	 * Optional cluster key. Adjacent sections sharing a group render together; a
	 * thin divider is drawn where the group changes, so the wrapped pill reads as
	 * labelled clusters (Discover · Build · Manage · Account) without needing a
	 * separate grouped-nav component.
	 */
	group?: string;
	icon: IconSvgElement;
	label: string;
	value: string;
}

const noop = () => {
	// Default no-op handler for the presentational layer.
};

/**
 * Bottom-fixed filter/sort bar for the Store. Search and section tabs live in
 * the left list column ({@link StoreListHeader} in desktop); this bar only
 * exposes the expandable filters panel.
 */
export function StoreFilterBar({
	panel,
	panelLabel = "Filters",
	panelIcon = SlidersHorizontalIcon,
}: {
	panel?: ReactNode;
	panelLabel?: string;
	panelIcon?: IconSvgElement;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

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

	if (!panel) {
		return null;
	}

	return (
		<div
			className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 px-4 py-3"
			ref={rootRef}
		>
			<div
				className={cn(
					"pointer-events-auto w-full max-w-3xl origin-bottom overflow-hidden rounded-2xl bg-muted/70 shadow-lg backdrop-blur-md transition-all duration-300 ease-out",
					open
						? "max-h-72 translate-y-0 opacity-100"
						: "pointer-events-none max-h-0 translate-y-2 opacity-0"
				)}
			>
				{panel}
			</div>

			<button
				aria-expanded={open}
				aria-label={panelLabel}
				className={cn(
					"pointer-events-auto flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-muted/70 px-3 font-medium text-foreground/60 text-sm shadow-lg outline-none backdrop-blur-md transition-colors",
					"hover:bg-muted hover:text-foreground",
					"focus-visible:ring-2 focus-visible:ring-ring",
					open && "bg-foreground text-background hover:bg-foreground/90"
				)}
				onClick={() => setOpen((prev) => !prev)}
				type="button"
			>
				<HugeiconsIcon className="size-4 shrink-0" icon={panelIcon} />
				<span>{panelLabel}</span>
				<HugeiconsIcon
					className={cn(
						"size-3.5 shrink-0 transition-transform duration-300",
						open && "rotate-180"
					)}
					icon={ArrowUp01Icon}
				/>
			</button>
		</div>
	);
}

/**
 * The Store shell's section tab nav, rendered as a floating "expandable action
 * bar" (beUI-style): a centered, rounded pill that floats above the section
 * content. Each section is an icon-only button that expands to reveal its label
 * on hover/focus; the active section always shows its label. The label width
 * tweens via the CSS `grid-template-columns` 0fr→1fr trick — no JS or
 * framer-motion, which the shared block boundary deliberately avoids.
 */
export function StoreSectionNav({
	sections,
	active,
	onSelect = noop,
	search,
	panel,
	panelLabel = "Filters",
	panelIcon = SlidersHorizontalIcon,
}: {
	sections: StoreSectionTab[];
	active: string;
	onSelect?: (value: string) => void;
	/** Optional inline, collapsible search folded into the bar itself. */
	search?: {
		value: string;
		onChange: (value: string) => void;
		placeholder?: string;
	};
	/**
	 * Optional "additional section" (filters / sort / view / CTA) that morphs up
	 * above the bar when its toggle is pressed — beUI-style expandable tabs.
	 */
	panel?: ReactNode;
	panelLabel?: string;
	panelIcon?: IconSvgElement;
}) {
	// Menu-like: only one expandable region is open at a time.
	const [mode, setMode] = useState<"none" | "search" | "panel">("none");
	const rootRef = useRef<HTMLDivElement>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);

	const searchOpen = mode === "search";
	const panelOpen = mode === "panel";

	// Escape or an outside click collapses the expanded region.
	useEffect(() => {
		if (mode === "none") {
			return;
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setMode("none");
			}
		};
		const onPointer = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setMode("none");
			}
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onPointer);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onPointer);
		};
	}, [mode]);

	// Focus the field the moment the inline search expands.
	useEffect(() => {
		if (searchOpen) {
			searchInputRef.current?.focus();
		}
	}, [searchOpen]);

	// Switching sections swaps the whole toolbar (each section owns its search +
	// filters), so collapse any open region — a panel/search left open from the
	// previous tab shouldn't linger over the new one. `active` is intentionally a
	// dep even though the body doesn't read it: the reset fires on tab change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: run the reset when the active section changes.
	useEffect(() => {
		setMode("none");
	}, [active]);

	return (
		<div
			className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-2 px-4 py-3"
			ref={rootRef}
		>
			{panel ? (
				<div
					className={cn(
						"pointer-events-auto w-full max-w-3xl origin-bottom overflow-hidden rounded-2xl bg-muted/70 shadow-lg backdrop-blur-md transition-all duration-300 ease-out",
						panelOpen
							? "max-h-72 translate-y-0 opacity-100"
							: "pointer-events-none max-h-0 translate-y-2 opacity-0"
					)}
				>
					{panel}
				</div>
			) : null}

			<div
				aria-label="Sections"
				className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full bg-muted/70 p-1.5 shadow-lg backdrop-blur-md"
				role="tablist"
			>
				{sections.map((s, i) => {
					const isActive = s.value === active;
					const prev = i > 0 ? sections[i - 1] : undefined;
					const showDivider = Boolean(prev && prev.group !== s.group);
					return (
						<Fragment key={s.value}>
							{showDivider ? (
								<span
									aria-hidden
									className="mx-0.5 h-5 w-px shrink-0 self-center bg-border/60"
								/>
							) : null}
							<button
								aria-label={s.label}
								aria-selected={isActive}
								className={cn(
									"group/action relative flex h-9 items-center rounded-full px-2.5 font-medium text-foreground/60 text-sm outline-none transition-colors",
									"hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10",
									"focus-visible:ring-2 focus-visible:ring-ring",
									isActive &&
										"bg-foreground text-background hover:bg-foreground/90 hover:text-background dark:bg-white dark:text-black dark:hover:bg-white/90"
								)}
								data-active={isActive}
								onClick={() => onSelect(s.value)}
								role="tab"
								title={s.label}
								type="button"
							>
								<HugeiconsIcon className="size-4 shrink-0" icon={s.icon} />
								<span
									className={cn(
										"grid transition-[grid-template-columns,opacity] duration-300 ease-out",
										isActive
											? "grid-cols-[1fr] opacity-100"
											: "grid-cols-[0fr] opacity-0 group-hover/action:grid-cols-[1fr] group-hover/action:opacity-100 group-focus-visible/action:grid-cols-[1fr] group-focus-visible/action:opacity-100"
									)}
								>
									<span className="min-w-0 overflow-hidden whitespace-nowrap pl-2">
										{s.label}
									</span>
								</span>
							</button>
						</Fragment>
					);
				})}

				{search || panel ? (
					<span
						aria-hidden
						className="mx-0.5 h-5 w-px shrink-0 self-center bg-border/60"
					/>
				) : null}

				{search ? (
					<div className="flex items-center">
						<button
							aria-label={searchOpen ? "Close search" : "Search"}
							className={cn(
								"flex h-9 shrink-0 items-center justify-center rounded-full px-2.5 text-foreground/60 outline-none transition-colors",
								"hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10",
								"focus-visible:ring-2 focus-visible:ring-ring",
								searchOpen && "text-foreground"
							)}
							onClick={() => setMode(searchOpen ? "none" : "search")}
							type="button"
						>
							<HugeiconsIcon
								className="size-4"
								icon={searchOpen ? Cancel01Icon : Search01Icon}
							/>
						</button>
						<div
							className={cn(
								"grid transition-[grid-template-columns] duration-300 ease-out",
								searchOpen ? "grid-cols-[1fr]" : "grid-cols-[0fr]"
							)}
						>
							<div className="min-w-0 overflow-hidden">
								<Input
									aria-hidden={!searchOpen}
									className="h-9 w-56 max-w-[40vw] border-none bg-transparent shadow-none focus-visible:ring-0"
									onChange={(e) => search.onChange(e.target.value)}
									placeholder={search.placeholder ?? "Search…"}
									ref={searchInputRef}
									tabIndex={searchOpen ? 0 : -1}
									value={search.value}
								/>
							</div>
						</div>
					</div>
				) : null}

				{panel ? (
					<button
						aria-expanded={panelOpen}
						aria-label={panelLabel}
						className={cn(
							"flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-medium text-foreground/60 text-sm outline-none transition-colors",
							"hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10",
							"focus-visible:ring-2 focus-visible:ring-ring",
							panelOpen &&
								"bg-foreground text-background hover:bg-foreground/90 hover:text-background dark:bg-white dark:text-black dark:hover:bg-white/90"
						)}
						onClick={() => setMode(panelOpen ? "none" : "panel")}
						type="button"
					>
						<HugeiconsIcon className="size-4 shrink-0" icon={panelIcon} />
						<span className="hidden sm:inline">{panelLabel}</span>
						<HugeiconsIcon
							className={cn(
								"size-3.5 shrink-0 transition-transform duration-300",
								panelOpen && "rotate-180"
							)}
							icon={ArrowUp01Icon}
						/>
					</button>
				) : null}
			</div>
		</div>
	);
}

/** Placeholder shown for sections whose catalog is not wired up yet. */
export function StoreComingSoon({
	icon,
	label,
}: {
	icon: IconSvgElement;
	label: string;
}) {
	return (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={icon} />
				</EmptyMedia>
				<EmptyTitle>{label} coming soon</EmptyTitle>
				<EmptyDescription>
					Browsing and installing {label.toLowerCase()} from the Store is on the
					way.
				</EmptyDescription>
			</EmptyHeader>
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
	/** Optional progress text shown while installing (e.g. "Installing 48%"). */
	progressLabel?: string;
	onInstall?: () => void;
	onUninstall?: () => void;
	onRetry?: () => void;
}) {
	if (state === "installing") {
		return (
			<span className="flex items-center gap-2 text-muted-foreground text-xs">
				<Spinner className="size-3.5" /> {progressLabel ?? "Installing…"}
			</span>
		);
	}
	if (state === "installed") {
		return (
			<div className="flex items-center gap-2">
				<Badge variant="secondary">Installed</Badge>
				<Button onClick={onUninstall} size="sm" variant="ghost">
					Remove
				</Button>
			</div>
		);
	}
	if (state === "failed") {
		return (
			<div className="flex items-center gap-2">
				<Badge variant="destructive">Failed</Badge>
				<Button onClick={onRetry} size="sm" variant="ghost">
					Retry
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
			Install
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
			<span className="tabular-nums">({count})</span>
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
		<div className="grid flex-1 grid-cols-2 gap-3 overflow-auto p-4">
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
