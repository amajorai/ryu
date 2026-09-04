"use client";

// Shared iOS-style settings primitives.
//
// These mirror the grouped "settings table" look from the previous desktop app
// (ryuold): a section is a small muted-foreground header, a rounded `bg-muted/50`
// card of rows separated by hairlines, and an optional footer caption. Every
// settings surface (App Settings tabs + Gateway cards) renders through these so
// the design stays consistent instead of each tab inventing its own borders,
// card blocks, and header sizes.
//
// - `SettingsSection` is the load-bearing wrapper: header + arbitrary children +
//   caption. Use it for anything that is NOT a simple row (sliders, color
//   pickers, grids, lists with reorder controls) by passing custom children.
// - `SettingsGroup` is the rounded grouped card; drop `SettingsItem`s (or any
//   nodes) inside and they get hairline separators between them. A row's
//   `description` renders as a caption BELOW the card (iOS style), never inside
//   it: a row with a description closes its card, and description-less rows
//   merge into the next card.
// - `SettingsItem` is the simple "title + control" row.

import { messageIdForLiteral } from "@ryu/i18n/core";
import { useOptionalI18n } from "@ryu/i18n/react";
import {
	Item,
	ItemActions,
	ItemGroup,
	ItemSeparator,
	ItemTitle,
} from "@ryu/ui/components/item";
import { cn } from "@ryu/ui/lib/utils";
// biome-ignore lint/correctness/noUnresolvedImports: Children, Fragment, and isValidElement are valid React exports; biome's resolver misreports them
import {
	Children,
	cloneElement,
	Fragment,
	isValidElement,
	type ReactElement,
	type ReactNode,
} from "react";

const toItems = (children: ReactNode): ReactNode[] =>
	Children.toArray(children).filter(Boolean);

/**
 * Read the iOS-style footer text for a group child. `SettingsItem` carries it
 * as its `description` prop; wrapper components that render a `SettingsItem`
 * internally can opt in by accepting (and forwarding nothing for) a
 * `description` prop at their call site — the group only needs to see it here.
 */
const localizeSettingText = (
	i18n: ReturnType<typeof useOptionalI18n>,
	value: ReactNode,
	settingsId: string | undefined,
	field: "caption" | "description" | "title"
): ReactNode => {
	if (!i18n || typeof value !== "string" || value.trim().length === 0) {
		return value;
	}
	const id = settingsId
		? `settings.${settingsId}.${field}`
		: messageIdForLiteral(value);
	return i18n.t(id, {}, value);
};

const childDescription = (
	child: ReactNode,
	i18n: ReturnType<typeof useOptionalI18n>
): ReactNode => {
	if (!isValidElement(child)) {
		return null;
	}
	const props = child.props as {
		description?: ReactNode;
		settingsId?: string;
	};
	return localizeSettingText(
		i18n,
		props.description,
		props.settingsId,
		"description"
	);
};

/**
 * The shared card surface — a subtle muted fill with modest rounding, tuned to
 * look like an iOS grouped table, not a bubble. Borderless by design: the card
 * edge reads from the `bg-muted/40` fill alone, never an outline. Row hairlines
 * (`ItemSeparator`) still separate items inside a group; this is only the outer
 * card. Do not add a `border` here — it has been removed deliberately.
 */
const SURFACE = "rounded-[10px] bg-muted/40";

/**
 * Read the `bare` opt-out from a group child.
 *
 * A control that is ALREADY a box — a tall textarea, a code/JSON editor — put
 * inside the card surface reads as a box inside a box: the muted card fill draws
 * one edge, the control's own border draws a second one a few pixels in. `bare`
 * drops the surface for that one setting so the control's own border is the only
 * edge, which is the whole reason the escape hatch is a primitive here rather
 * than a `className` override at each call site. A per-row override is how this
 * drifts back one file at a time.
 */
const childIsBare = (child: ReactNode): boolean => {
	if (!isValidElement(child)) {
		return false;
	}
	return (child.props as { bare?: boolean }).bare === true;
};

const isFullBleedTextControl = (child: ReactNode): boolean => {
	if (!isValidElement(child)) {
		return false;
	}

	const type = child.type;
	if (typeof type !== "function") {
		return false;
	}

	return type.name === "Input" || type.name === "Textarea";
};

const renderSettingControl = (children: ReactNode): ReactNode => {
	if (!isFullBleedTextControl(children)) {
		return children;
	}

	const control = children as ReactElement<{ className?: string }>;
	return cloneElement(control, {
		className: cn(
			"-mx-3.5 w-[calc(100%+1.75rem)] rounded-none",
			control.props.className
		),
	});
};

const hasFullBleedTextControl = (children: ReactNode): boolean =>
	isFullBleedTextControl(children);

interface SettingsGroupProps {
	children: ReactNode;
	className?: string;
}

/**
 * A grouped card of rows with hairline separators between them. Overrides the
 * base `ItemGroup` gap so rows sit flush and clips children to the card.
 *
 * iOS-style footers: a child that carries a `description` closes the current
 * card and its description renders as a muted caption below that card;
 * description-less children merge together into the same card. The description
 * never renders inside the card.
 */
export const SettingsGroup = ({ children, className }: SettingsGroupProps) => {
	const i18n = useOptionalI18n();
	const items = toItems(children);

	// Partition rows into card slices: rows accumulate until one carries a
	// description, which terminates its slice (the description becomes the
	// slice's footer caption). A `bare` row terminates the slice too and is then
	// rendered OUTSIDE any card, so a tall text control keeps its position in the
	// column without inheriting the card fill behind it.
	const slices: {
		bare?: boolean;
		caption: ReactNode;
		rows: ReactNode[];
	}[] = [];
	let pending: ReactNode[] = [];
	for (const child of items) {
		if (childIsBare(child)) {
			if (pending.length > 0) {
				slices.push({ caption: null, rows: pending });
				pending = [];
			}
			// No caption here: a bare row renders its OWN description, so it looks the
			// same whether it sits inside a group or stands alone in a section.
			// Rendering it in both places would print the caption twice.
			slices.push({ bare: true, caption: null, rows: [child] });
			continue;
		}
		pending.push(child);
		const caption = childDescription(child, i18n);
		if (caption) {
			slices.push({ caption, rows: pending });
			pending = [];
		}
	}
	if (pending.length > 0) {
		slices.push({ caption: null, rows: pending });
	}

	const renderCard = (rows: ReactNode[]) => (
		<ItemGroup
			className={cn(
				// `ItemGroup`'s base sets a conditional `has-data-[size=sm]:gap-2.5`
				// that a plain `gap-0` can't override (different merge group),
				// which would wrap every row + hairline in 10px of dead space. Zero out
				// the size-conditional gaps too so rows sit flush against the separator.
				"gap-0 overflow-hidden shadow-none has-data-[size=sm]:gap-0 has-data-[size=xs]:gap-0",
				SURFACE,
				className
			)}
		>
			{rows.map((child, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: row order is static within a render
				<Fragment key={index}>
					{child}
					{index < rows.length - 1 ? <ItemSeparator className="my-0" /> : null}
				</Fragment>
			))}
		</ItemGroup>
	);

	if (slices.length === 1 && !(slices[0].caption || slices[0].bare)) {
		return renderCard(slices[0].rows);
	}

	return (
		<div className="space-y-1.5">
			{slices.map((slice, sliceIndex) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: slice order is static within a render
				<Fragment key={sliceIndex}>
					{slice.bare ? slice.rows : renderCard(slice.rows)}
					{slice.caption ? (
						<p className="px-3.5 pb-1.5 text-muted-foreground text-xs leading-snug">
							{slice.caption}
						</p>
					) : null}
				</Fragment>
			))}
		</div>
	);
};

interface SettingsCardProps {
	/**
	 * Drop the card surface: no fill, no padding, so the child's own border is
	 * the only edge. For a setting whose ONLY control already draws a box that
	 * fills the card — a tall textarea (system prompt, custom instructions), a
	 * JSON/code editor — where the surface just adds a second edge a few pixels
	 * outside the first.
	 *
	 * The discriminator is "is the big control alone in here?". A card holding a
	 * textarea AND other fields still needs its surface: baring it strips the
	 * card from the siblings too, which is a regression, not a fix.
	 */
	bare?: boolean;
	children: ReactNode;
	className?: string;
}

/**
 * The same card surface as {@link SettingsGroup} but with internal padding, for
 * arbitrary (non-row) content — sliders, color pickers, selects, forms, an
 * avatar uploader. Use this instead of letting custom content float bare so
 * every section reads as a consistent card.
 *
 * `bare` keeps the call site reading as a settings card while painting no
 * surface — see the prop's own note for when that is the right answer.
 */
export const SettingsCard = ({
	bare,
	children,
	className,
}: SettingsCardProps) =>
	bare ? (
		<div className={className}>{children}</div>
	) : (
		<div className={cn(SURFACE, "p-3.5", className)}>{children}</div>
	);

interface SettingsItemProps {
	actions?: ReactNode;
	/**
	 * Render this row OUTSIDE its group's card: title on its own line, `children`
	 * full-width beneath it, no card fill behind either. For a row whose control
	 * is a tall text area — a prompt, an instruction block, a JSON blob — which
	 * inside the card reads as a box in a box, and squeezed into `actions` reads
	 * as a text field pretending to be a textarea.
	 *
	 * Pass the big control as `children`, not `actions`: `actions` is the row's
	 * right-hand column and stays narrow even here.
	 *
	 * {@link SettingsGroup} reads this off the child, so a bare row still sits in
	 * the same place in the same group — it just breaks the card around itself.
	 */
	bare?: boolean;
	children?: ReactNode;
	className?: string;
	/**
	 * iOS-style footer for this row. Never rendered inside the card — the
	 * enclosing {@link SettingsGroup} extracts it and renders it as a muted
	 * caption below the card this row closes.
	 */
	description?: ReactNode;
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

/**
 * A single settings row: a title on the left and an optional control
 * (`actions`) on the right, vertically centered to the whole row. Optional
 * `children` render full-width below the row (e.g. an inline input that
 * belongs to this setting).
 */
export const SettingsItem = ({
	actions,
	bare,
	children,
	className,
	description,
	settingsId,
	title,
}: SettingsItemProps) => {
	const i18n = useOptionalI18n();
	const localizedTitle = localizeSettingText(i18n, title, settingsId, "title");
	const localizedDescription = localizeSettingText(
		i18n,
		description,
		settingsId,
		"description"
	);
	return bare ? (
		// No `Item` here: its padding is what insets a row from the card edge, and
		// a bare row has no card to be inset from. The title keeps the standard
		// 3.5 gutter so it lines up with every section header and caption; the
		// control runs the full width, flush with the cards above and below it.
		//
		// A bare row also renders its own `description`, unlike a carded one whose
		// group renders it as the card's footer — there is no card here to hang a
		// footer off, and a bare row is equally valid standing alone in a section
		// where no group would see it at all.
		<div
			className={cn("flex w-full flex-col gap-1.5", className)}
			data-setting-id={settingsId}
		>
			<div className="flex items-center justify-between gap-3 px-3.5">
				<ItemTitle className="font-medium text-sm">{localizedTitle}</ItemTitle>
				{actions ? (
					<ItemActions className="shrink-0">{actions}</ItemActions>
				) : null}
			</div>
			{children}
			{localizedDescription ? (
				<p className="px-3.5 text-muted-foreground text-xs leading-snug">
					{localizedDescription}
				</p>
			) : null}
		</div>
	) : (
		<Item
			className={cn(
				"flex-col items-stretch gap-2 rounded-none border-0 px-3.5 py-2.5",
				className
			)}
			data-setting-id={settingsId}
			size="sm"
		>
			<div className="flex w-full items-center justify-between gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<ItemTitle className="font-medium text-sm">
						{localizedTitle}
					</ItemTitle>
				</div>
				{actions && !hasFullBleedTextControl(actions) ? (
					<ItemActions className="shrink-0">{actions}</ItemActions>
				) : null}
			</div>
			{actions && hasFullBleedTextControl(actions)
				? renderSettingControl(actions)
				: null}
			{renderSettingControl(children)}
		</Item>
	);
};

interface SettingsSectionProps {
	/** Optional caption rendered below the group, in muted text. */
	caption?: ReactNode;
	children: ReactNode;
	className?: string;
	/** Optional node rendered on the right of the header row (e.g. an action). */
	headerAction?: ReactNode;
	/** Section header label. Omit for an unlabeled section. */
	title?: ReactNode;
}

/**
 * The standard settings block: a small header, a body (any children — typically
 * a {@link SettingsGroup} but can be sliders, grids, lists), and an optional
 * footer caption. This is the single building block every settings surface uses.
 */
export const SettingsSection = ({
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
};
