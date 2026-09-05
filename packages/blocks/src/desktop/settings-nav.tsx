// Grouped-navigation primitives for settings surfaces.
//
// `settings-items.tsx` already gives us the iOS grouped-table LOOK (a muted card
// of hairline-separated rows with a footer caption). What it never gave us is the
// iOS/macOS Settings *structure*: a pane that is too long to read is not a longer
// scroll, it is a short list of rows that PUSH a sub-page with a back button.
// This file is that half.
//
// - `SettingsIconTile` — the rounded-square tinted glyph Apple puts left of every
//   Settings row. Purely decorative: it is a landmark for the eye, so a row is
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
import { SettingsGroup, SettingsItem, SettingsSection } from "./settings-items";

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
const TINT_CLASS: Record<SettingsTint, string> = {
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
};

interface SettingsIconTileProps {
	className?: string;
	icon: IconSvgElement;
	/** `sm` for a sidebar row, `md` for a pane's nav list. */
	size?: "md" | "sm";
	tint?: SettingsTint;
}

/**
 * The tinted rounded square that sits left of a settings row's label.
 *
 * `aria-hidden` and no label of its own: every caller renders a text title next
 * to it, so announcing the glyph too would just double every row for a screen
 * reader.
 */
export const SettingsIconTile = ({
	className,
	icon,
	size = "md",
	tint = "gray",
}: SettingsIconTileProps) => (
	<span
		aria-hidden="true"
		className={cn(
			"flex shrink-0 items-center justify-center text-white",
			size === "sm" ? "size-[18px] rounded-[5px]" : "size-6 rounded-[7px]",
			TINT_CLASS[tint],
			className
		)}
	>
		<HugeiconsIcon
			className={size === "sm" ? "size-3" : "size-4"}
			icon={icon}
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
			<span className="flex items-center gap-1.5">
				{value ? (
					<span className="text-muted-foreground text-sm">{value}</span>
				) : null}
				<HugeiconsIcon
					className="size-4 text-muted-foreground/70"
					icon={ArrowRight01Icon}
				/>
			</span>
		}
		className={cn(
			// `relative` is load-bearing: the title button's full-row overlay below
			// positions against this row, not against whatever ancestor happens to be
			// positioned.
			"relative cursor-pointer transition-colors hover:bg-foreground/[0.04]",
			className
		)}
		description={description}
		title={
			<button
				className="flex w-full items-center gap-2.5 text-left"
				onClick={onClick}
				type="button"
			>
				{icon ? <SettingsIconTile icon={icon} tint={tint} /> : null}
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above — pages is a fresh array every render
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
					<Button
						className="-ml-2 h-7 w-fit gap-1 px-2 text-muted-foreground"
						onClick={() => setPage(null)}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
						{backLabel}
					</Button>
					<div className="flex items-center gap-2.5 px-0.5">
						{current.icon ? (
							<SettingsIconTile icon={current.icon} tint={current.tint} />
						) : null}
						<h3 className="font-medium text-base">{localizedCurrentTitle}</h3>
					</div>
					{localizedCurrentHint ? (
						<p className="px-0.5 text-muted-foreground text-sm leading-snug">
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
