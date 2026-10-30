// Grouped-navigation primitives for settings surfaces.
//
// `settings-items.tsx` already gives us the iOS grouped-table LOOK (a muted card
// of hairline-separated rows with a footer caption). What it never gave us is the
// iOS/macOS Settings *structure*: a pane that is too long to read is not a longer
// scroll, it is a short list of rows that PUSH a sub-page with a back button.
// This file is that half.
//
// - `SettingsIconTile` — the glyph left of a settings row. Plain by default: a
//   muted 16px icon that follows the row's foreground. `tone="tint"` opts back
//   into Apple's coloured rounded square. Purely decorative either way: a row is
//   still fully described by its label alone.
// - `SettingsNavRow` — a `SettingsItem`-shaped row that navigates: tile, title,
//   optional right-hand value, chevron.
// - `SettingsSubpages` — the index/detail switch. Give it pages; it renders the
//   index list, and pushes one page at a time with a back button above it.
//
// WHY THE PAGES ARE NODES AND NOT ROUTES: a settings pane is inside a modal that
// already owns the section state, and half of these panes are mid-form. Routing
// would put unsaved state one browser-back away from being lost, and would make
// every consumer thread a URL segment it does not otherwise have.
//
// SEARCH INTERACTION (load-bearing): a row inside a closed sub-page is NOT in the
// DOM, and the desktop settings search reveals a row by polling the content pane
// for its anchor, then silently giving up. So a sub-paged row would land the user
// on the right section with nothing highlighted. `revealPageId` is the fix — the
// host passes the sub-page a pending search result names, and this component
// opens it before the reveal poll expires. Keep `SettingsEntry.subpage` in
// `settings-index.ts` in step with the page ids used here.

import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useLocalizedString } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useEffect, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";

/**
 * The tint of a row's icon tile. Named rather than free-form so a surface cannot
 * invent a fourteenth blue: the point of the tile is that the same category is
 * the same color in every dialog, which only holds if the palette is closed.
 */
export type SettingsTint =
	| "blue"
	| "gray"
	| "green"
	| "indigo"
	| "orange"
	| "pink"
	| "purple"
	| "red"
	| "teal"
	| "yellow";

// Fixed 500-weight fills with white glyphs, in both themes deliberately: Apple's
// Settings tiles do not dim in dark mode either, and a tile that follows the
// theme stops being the constant landmark it exists to be.
const TINT_CLASS = {
	blue: "bg-blue-500",
	gray: "bg-zinc-500",
	green: "bg-emerald-500",
	indigo: "bg-indigo-500",
	orange: "bg-orange-500",
	pink: "bg-pink-500",
	purple: "bg-purple-500",
	red: "bg-red-500",
	teal: "bg-teal-500",
	yellow: "bg-amber-500",
} satisfies Record<SettingsTint, string>;

interface SettingsIconTileProps {
	className?: string;
	icon: IconSvgElement;
	/** `sm` for a sidebar row, `md` for a pane's nav list. Tinted tiles only. */
	size?: "md" | "sm";
	/** The tile colour under `tone="tint"`; ignored by a plain tile. */
	tint?: SettingsTint;
	/**
	 * `plain` (default): no fill, a muted 16px glyph that turns foreground when
	 * its sidebar row is hovered or active. `tint`: the coloured tile, opt-in.
	 */
	tone?: "plain" | "tint";
}

/**
 * The glyph that sits left of a settings row's label: a plain muted icon by
 * default, or the tinted rounded square under `tone="tint"`.
 *
 * `aria-hidden` and no label of its own: every caller renders a text title next
 * to it, so announcing the glyph too would just double every row for a screen
 * reader.
 */
export const SettingsIconTile = ({
	className,
	icon,
	size = "md",
	tone = "plain",
	tint = "gray",
}: SettingsIconTileProps) =>
	tone === "plain" ? (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-4 shrink-0 items-center justify-center text-muted-foreground transition-colors group-hover/menu-button:text-foreground group-data-active/menu-button:text-foreground",
				className
			)}
		>
			<HugeiconsIcon className="size-4!" icon={icon} size={16} />
		</span>
	) : (
		<span
			aria-hidden="true"
			className={cn(
				"flex shrink-0 items-center justify-center text-white",
				size === "sm"
					? "size-[18px] rounded-(--radius-artwork-compact)"
					: "size-6 rounded-sm",
				TINT_CLASS[tint],
				className
			)}
		>
			{/* Important: a sidebar row sizes every descendant svg (`[&_svg]:size-4`),
		    which would blow the glyph up to fill the tile and lose its inset. */}
			<HugeiconsIcon
				className={size === "sm" ? "size-2.5!" : "size-4!"}
				icon={icon}
				size={size === "sm" ? 10 : 16}
				strokeWidth={2}
			/>
		</span>
	);

interface SettingsNavRowProps {
	className?: string;
	/** iOS-style footer, extracted by {@link SettingsGroup} onto the card below. */
	description?: ReactNode;
	icon?: IconSvgElement;
	onClick: () => void;
	tint?: SettingsTint;
	title: ReactNode;
	/** Optional muted right-hand text — the current value, iOS-style. */
	value?: ReactNode;
}

/**
 * A row that navigates rather than sets: tile, title, optional current value,
 * chevron. Drop these into a {@link SettingsGroup} to get the hairline-separated
 * card Apple uses for a section's index.
 */
export const SettingsNavRow = ({
	className,
	description,
	icon,
	onClick,
	tint,
	title,
	value,
}: SettingsNavRowProps) => (
	<SettingsItem
		actions={
			<span className="flex items-center gap-2">
				{value ? (
					<span className="text-muted-foreground text-sm">{value}</span>
				) : null}
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={ArrowRight01Icon}
				/>
			</span>
		}
		className={cn(
			// `relative` is load-bearing: the title button's full-row overlay below
			// positions against this row, not against whatever ancestor happens to be
			// positioned.
			"relative cursor-pointer",
			className
		)}
		description={description}
		navigation
		title={
			<button
				className="flex w-full items-center gap-2 text-left"
				onClick={onClick}
				type="button"
			>
				{/* Tagged so the group's inset hairline starts past the tile, at the
				    title — where Apple starts it. */}
				{icon ? (
					<span className="contents" data-slot="settings-icon-tile">
						<SettingsIconTile icon={icon} tint={tint} />
					</span>
				) : null}
				<span className="min-w-0 truncate">{title}</span>
				{/* Stretches the button across the row so the whole row — chevron and
				    value included — is one click target, without nesting those nodes
				    inside the button (a button may not contain a button). */}
				<span aria-hidden="true" className="absolute inset-0" />
			</button>
		}
	/>
);

export interface SettingsSubpage {
	content: ReactNode;
	/** Optional footer caption under this row on the index list. */
	description?: ReactNode;
	/** One plain sentence under the sub-page's title, once opened. */
	hint?: string;
	icon?: IconSvgElement;
	/** Stable id — also the value `SettingsEntry.subpage` stores. Never rename. */
	id: string;
	tint?: SettingsTint;
	title: string;
	/** Muted right-hand text on the index row (the current value). */
	value?: ReactNode;
}

interface SettingsSubpagesProps {
	/** Label of the back button. Defaults to the pane's own name if given. */
	backLabel?: string;
	className?: string;
	/** Rendered above the index list — the one or two settings worth surfacing. */
	intro?: ReactNode;
	/** Section header above the index list. */
	label?: string;
	onOpenChange?: (id: string | null) => void;
	/** Controlled open page. Omit for self-managed navigation. */
	openId?: string | null;
	/**
	 * Rendered BELOW the index list. For the trailing content of a pane that is
	 * not a setting and does not deserve a row of its own — a plain-English
	 * summary, a "learn more" block, a legal note.
	 */
	outro?: ReactNode;
	pages: SettingsSubpage[];
	/**
	 * A pending settings-search reveal targeting one of these pages. Setting it
	 * opens that page, so the host's reveal poll finds the row it is looking for
	 * instead of timing out against a sub-page that was never mounted.
	 */
	revealPageId?: string | null;
}

/**
 * The index/detail switch: a short list of chevron rows, each of which pushes a
 * sub-page with a back button. This is the piece that turns a two-thousand-line
 * pane into something a person can actually scan.
 */
export const SettingsSubpages = ({
	backLabel = "Back",
	className,
	intro,
	label,
	onOpenChange,
	openId,
	outro,
	pages,
	revealPageId,
}: SettingsSubpagesProps) => {
	const [internalId, setInternalId] = useState<string | null>(null);
	const controlled = openId !== undefined;
	const currentId = controlled ? openId : internalId;
	const current = pages.find((p) => p.id === currentId) ?? null;
	const localizedCurrentTitle = useLocalizedString(current?.title);
	const localizedCurrentHint = useLocalizedString(current?.hint);
	const localizedBackLabel = useLocalizedString(backLabel);

	const setPage = (id: string | null) => {
		if (!controlled) {
			setInternalId(id);
		}
		onOpenChange?.(id);
	};

	// A search result naming a row inside a closed sub-page opens it. Guarded on
	// the page existing so a stale index entry (a page that was renamed away)
	// leaves the user on the index rather than on a blank detail pane.
	//
	// `pages` is deliberately NOT a dependency: every caller rebuilds it each
	// render (the page bodies are inline JSX), so depending on it would re-fire
	// this on every keystroke in any field inside a sub-page and trap the user on
	// whichever page the last search named.

	useEffect(() => {
		if (revealPageId && pages.some((p) => p.id === revealPageId)) {
			if (!controlled) {
				setInternalId(revealPageId);
			}
			onOpenChange?.(revealPageId);
		}
	}, [revealPageId]);

	if (current) {
		return (
			<div className={cn("flex flex-col gap-4", className)}>
				<div className="flex flex-col gap-1">
					{/* One back row: the back control and the page's single title. The
					    pane's own name is the button's accessible label. */}
					<div className="-ml-2 flex items-center gap-1">
						<Button
							aria-label={localizedBackLabel}
							onClick={() => setPage(null)}
							size="icon-sm"
							title={localizedBackLabel}
							variant="ghost-muted"
						>
							<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
						</Button>
						<h3 className="font-semibold text-lg tracking-tight">
							{localizedCurrentTitle}
						</h3>
					</div>
					{localizedCurrentHint ? (
						<p className="text-detail text-muted-foreground">
							{localizedCurrentHint}
						</p>
					) : null}
				</div>
				<div className="flex flex-col gap-6">{current.content}</div>
			</div>
		);
	}

	return (
		<div className={cn("flex flex-col gap-6", className)}>
			{intro}
			<SettingsSection title={label}>
				<SettingsGroup>
					{pages.map((page) => (
						<SettingsNavRow
							description={page.description}
							icon={page.icon}
							key={page.id}
							onClick={() => setPage(page.id)}
							tint={page.tint}
							title={page.title}
							value={page.value}
						/>
					))}
				</SettingsGroup>
			</SettingsSection>
			{outro}
		</div>
	);
};
