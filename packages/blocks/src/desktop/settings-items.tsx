"use client";
import navigationStyles from "./settings-nav.module.css";

// Shared settings primitives.
//
// Every settings surface (App Settings tabs, Gateway panes, web settings)
// renders through these so the rows stay consistent instead of each tab
// inventing its own borders, card blocks and header sizes. The standard look is
// quiet and flush: a section is a small semibold title, its rows are separated
// by full-width hairlines, and nothing sits in a card.
//
// - `SettingsSection` is the load-bearing wrapper: title + arbitrary children +
//   caption. Use it for anything that is NOT a simple row (sliders, colour
//   pickers, grids, lists with reorder controls) by passing custom children.
// - `SettingsGroup` is one flush list of rows; drop `SettingsItem`s (or any
//   nodes) inside and they get hairlines between them.
// - `SettingsItem` is the simple "label + control" row. Its `description` is one
//   muted line under the label, inside the row.
//
// `appearance="grouped"` on `SettingsGroup`, `SettingsCard` and
// `SettingsSection` keeps the older iOS grouped-card look for a caller that
// genuinely needs it (see `settings-items-grouped.tsx`). Nothing uses it by
// default.

import { useOptionalI18n } from "@ryu/i18n/react";
import {
	Item,
	ItemActions,
	ItemGroup,
	ItemTitle,
} from "@ryu/ui/components/item";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useContext } from "react";
import {
	GROUPED_SURFACE,
	GroupedSettingsGroup,
	isFullBleedTextControl,
	localizeSettingText,
	renderGroupedSettingControl,
	type SettingsAppearance,
	SettingsAppearanceContext,
	toItems,
} from "./settings-items-grouped.tsx";

export type { SettingsAppearance } from "./settings-items-grouped.tsx";

interface SettingsGroupProps {
	/** `grouped` restores the legacy grouped-card look. Default `flush`. */
	appearance?: SettingsAppearance;
	children: ReactNode;
	className?: string;
}

/**
 * One flush list of rows with full-width hairlines between them and none after
 * the last. Rows render their own descriptions; a `bare` row (a tall text
 * control) sits in the list like any other.
 */
export const SettingsGroup = ({
	appearance = "flush",
	children,
	className,
}: SettingsGroupProps) => {
	if (appearance === "grouped") {
		return (
			<GroupedSettingsGroup className={className}>
				{children}
			</GroupedSettingsGroup>
		);
	}
	return (
		<SettingsAppearanceContext.Provider value="flush">
			<ItemGroup className={className} variant="flush">
				{toItems(children)}
			</ItemGroup>
		</SettingsAppearanceContext.Provider>
	);
};

interface SettingsCardProps {
	/** `grouped` restores the legacy padded card surface. Default `flush`. */
	appearance?: SettingsAppearance;
	/**
	 * Drop the card surface under `appearance="grouped"`, so the child's own
	 * border is the only edge. A flush card never paints a surface.
	 */
	bare?: boolean;
	children: ReactNode;
	className?: string;
}

/**
 * A container for arbitrary (non-row) settings content — sliders, colour
 * pickers, forms, an avatar uploader. Flush by default: a plain block with no
 * fill, padding or border, so it sits in the pane like the rows around it.
 */
export const SettingsCard = ({
	appearance = "flush",
	bare,
	children,
	className,
}: SettingsCardProps) =>
	appearance === "grouped" && !bare ? (
		<div
			className={cn(GROUPED_SURFACE, "p-3.5", className)}
			data-slot="settings-card"
		>
			{children}
		</div>
	) : (
		<div className={className} data-slot="settings-card">
			{children}
		</div>
	);

interface SettingsItemProps {
	actions?: ReactNode;
	/**
	 * Lay the row out for a tall control: the title on its own line and
	 * `children` full-width beneath it. For a prompt, an instruction block or a
	 * JSON blob, which squeezed into `actions` reads as a text field pretending to
	 * be a textarea. Pass the big control as `children`, not `actions`.
	 */
	bare?: boolean;
	children?: ReactNode;
	className?: string;
	/**
	 * One short line under the label, in muted text. Under a grouped
	 * `SettingsGroup` the group renders it as the card's footer instead.
	 */
	description?: ReactNode;
	navigation?: boolean;
	/**
	 * Optional stable id from the desktop settings search index. Emitted as
	 * `data-setting-id`, which is the authoritative anchor a search result jumps
	 * to. Rows without one are still reachable — the reveal falls back to
	 * matching this row's `title` text — so this is an opt-in precision upgrade
	 * for rows whose title is ambiguous (several "Light theme"s, say), not
	 * something every row must carry.
	 */
	settingsId?: string;
	title: ReactNode;
}

/** The flush row geometry: 48px, no card inset, set off by hairlines alone. */
const FLUSH_ROW =
	"min-h-12 px-0 py-3 not-in-data-[slot=item-group]:rounded-none not-in-data-[slot=item-group]:bg-transparent";

const RowDescription = ({ children }: { children: ReactNode }) =>
	children ? (
		<p className="text-detail text-muted-foreground">{children}</p>
	) : null;

/**
 * A single settings row: a label (plus an optional one-line description) on the
 * left and an optional control (`actions`) on the right, vertically centred.
 * Optional `children` render full-width below the row (e.g. an inline input that
 * belongs to this setting).
 */
export const SettingsItem = ({
	navigation,
	actions,
	bare,
	children,
	className,
	description,
	settingsId,
	title,
}: SettingsItemProps) => {
	const i18n = useOptionalI18n();
	const grouped = useContext(SettingsAppearanceContext) === "grouped";
	const localizedTitle = localizeSettingText(i18n, title, settingsId, "title");
	const localizedDescription = localizeSettingText(
		i18n,
		description,
		settingsId,
		"description"
	);
	const renderControl = grouped
		? renderGroupedSettingControl
		: (node: ReactNode) => node;
	const fullBleedAction = actions ? isFullBleedTextControl(actions) : false;

	if (bare) {
		// No `Item` here: a bare row is a title line over a full-width control, and
		// it always renders its own description (a grouped card has no footer to
		// hang it off, because the bare row breaks the card around itself).
		return (
			<div
				className={cn(
					"flex w-full flex-col",
					grouped ? "gap-1.5" : "gap-2 py-3",
					className
				)}
				data-setting-id={settingsId}
			>
				<div
					className={cn(
						"flex items-center justify-between",
						grouped ? "gap-3 px-3.5" : "gap-6"
					)}
				>
					<ItemTitle typography="settings-label">{localizedTitle}</ItemTitle>
					{actions ? (
						<ItemActions className="ml-auto shrink-0">{actions}</ItemActions>
					) : null}
				</div>
				{children}
				{localizedDescription && grouped ? (
					<p className="px-3.5 text-muted-foreground text-xs leading-snug">
						{localizedDescription}
					</p>
				) : (
					<RowDescription>{localizedDescription}</RowDescription>
				)}
			</div>
		);
	}

	return (
		<Item
			className={cn(!grouped && FLUSH_ROW, className)}
			data-setting-id={settingsId}
			purpose="settings-row"
			render={
				navigation ? (
					<div className={navigationStyles.navigationRow} />
				) : undefined
			}
			size="sm"
		>
			{/* Wraps the controls under the title when the row is too narrow for
			    both, instead of squeezing the title underneath them. */}
			<div
				className={cn(
					"flex w-full flex-wrap items-center justify-between gap-y-2",
					grouped ? "gap-x-3" : "gap-x-6"
				)}
			>
				<div className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
					<ItemTitle typography="settings-label">{localizedTitle}</ItemTitle>
					{grouped ? null : (
						<RowDescription>{localizedDescription}</RowDescription>
					)}
				</div>
				{actions && !fullBleedAction ? (
					<ItemActions className="ml-auto shrink-0">{actions}</ItemActions>
				) : null}
			</div>
			{actions && fullBleedAction ? renderControl(actions) : null}
			{renderControl(children)}
		</Item>
	);
};

interface SettingsSectionProps {
	/** `grouped` restores the legacy inset muted header. Default `flush`. */
	appearance?: SettingsAppearance;
	/** Optional caption rendered below the body, in muted text. */
	caption?: ReactNode;
	children: ReactNode;
	className?: string;
	/** Optional node rendered on the right of the header row (e.g. an action). */
	headerAction?: ReactNode;
	/** Section title. Omit for an unlabeled section. */
	title?: ReactNode;
}

/**
 * The standard settings block: a semibold title, a body (any children —
 * typically a {@link SettingsGroup} but can be sliders, grids, lists), and an
 * optional caption. Sections are 32px apart; the first one has no top margin.
 */
export const SettingsSection = ({
	appearance = "flush",
	caption,
	children,
	className,
	headerAction,
	title,
}: SettingsSectionProps) => {
	const i18n = useOptionalI18n();
	const localizedTitle = localizeSettingText(i18n, title, undefined, "title");
	const localizedCaption = localizeSettingText(
		i18n,
		caption,
		undefined,
		"caption"
	);
	if (appearance === "grouped") {
		return (
			<div className={cn("space-y-1.5", className)}>
				{localizedTitle || headerAction ? (
					<div className="flex items-center justify-between px-3.5">
						{localizedTitle ? (
							<h3 className="font-medium text-foreground/70 text-xs">
								{localizedTitle}
							</h3>
						) : (
							<span />
						)}
						{headerAction}
					</div>
				) : null}
				{children}
				{localizedCaption ? (
					<p className="px-3.5 text-muted-foreground text-xs leading-snug">
						{localizedCaption}
					</p>
				) : null}
			</div>
		);
	}
	return (
		<div className={cn("mt-8 first:mt-0", className)}>
			{localizedTitle || headerAction ? (
				<div className="mb-1 flex items-center justify-between gap-2">
					{localizedTitle ? (
						<h3 className="font-semibold text-foreground text-sm">
							{localizedTitle}
						</h3>
					) : (
						<span />
					)}
					{headerAction}
				</div>
			) : null}
			{children}
			{localizedCaption ? (
				<p className="mt-2 text-detail text-muted-foreground">
					{localizedCaption}
				</p>
			) : null}
		</div>
	);
};
