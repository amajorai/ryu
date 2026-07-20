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

import {
	Item,
	ItemActions,
	ItemGroup,
	ItemSeparator,
	ItemTitle,
} from "@ryu/ui/components/item";
import { cn } from "@ryu/ui/lib/utils";
// biome-ignore lint/correctness/noUnresolvedImports: Children, Fragment, and isValidElement are valid React exports; biome's resolver misreports them
import { Children, Fragment, isValidElement, type ReactNode } from "react";

const toItems = (children: ReactNode): ReactNode[] =>
	Children.toArray(children).filter(Boolean);

/**
 * Read the iOS-style footer text for a group child. `SettingsItem` carries it
 * as its `description` prop; wrapper components that render a `SettingsItem`
 * internally can opt in by accepting (and forwarding nothing for) a
 * `description` prop at their call site — the group only needs to see it here.
 */
const childDescription = (child: ReactNode): ReactNode => {
	if (!isValidElement(child)) {
		return null;
	}
	const props = child.props as { description?: ReactNode };
	return props.description ?? null;
};

/**
 * The shared card surface — a subtle muted fill with modest rounding, tuned to
 * look like an iOS grouped table, not a bubble. Borderless by design: the card
 * edge reads from the `bg-muted/40` fill alone, never an outline. Row hairlines
 * (`ItemSeparator`) still separate items inside a group; this is only the outer
 * card. Do not add a `border` here — it has been removed deliberately.
 */
const SURFACE = "rounded-[10px] bg-muted/40";

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
	const items = toItems(children);

	// Partition rows into card slices: rows accumulate until one carries a
	// description, which terminates its slice (the description becomes the
	// slice's footer caption).
	const slices: { caption: ReactNode; rows: ReactNode[] }[] = [];
	let pending: ReactNode[] = [];
	for (const child of items) {
		pending.push(child);
		const caption = childDescription(child);
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
				// that a plain `gap-0` can't override (different tailwind-merge group),
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

	if (slices.length === 1 && !slices[0].caption) {
		return renderCard(slices[0].rows);
	}

	return (
		<div className="space-y-1.5">
			{slices.map((slice, sliceIndex) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: slice order is static within a render
				<Fragment key={sliceIndex}>
					{renderCard(slice.rows)}
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
	children: ReactNode;
	className?: string;
}

/**
 * The same card surface as {@link SettingsGroup} but with internal padding, for
 * arbitrary (non-row) content — sliders, color pickers, selects, forms, an
 * avatar uploader. Use this instead of letting custom content float bare so
 * every section reads as a consistent card.
 */
export const SettingsCard = ({ children, className }: SettingsCardProps) => (
	<div className={cn(SURFACE, "p-3.5", className)}>{children}</div>
);

interface SettingsItemProps {
	actions?: ReactNode;
	children?: ReactNode;
	className?: string;
	/**
	 * iOS-style footer for this row. Never rendered inside the card — the
	 * enclosing {@link SettingsGroup} extracts it and renders it as a muted
	 * caption below the card this row closes.
	 */
	description?: ReactNode;
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
	children,
	className,
	title,
}: SettingsItemProps) => (
	<Item
		className={cn(
			"flex-col items-stretch gap-2 rounded-none border-0 px-3.5 py-2.5",
			className
		)}
		size="sm"
	>
		<div className="flex w-full items-center justify-between gap-3">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<ItemTitle className="font-medium text-sm">{title}</ItemTitle>
			</div>
			{actions ? (
				<ItemActions className="shrink-0">{actions}</ItemActions>
			) : null}
		</div>
		{children}
	</Item>
);

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
}: SettingsSectionProps) => (
	<div className={cn("space-y-1.5", className)}>
		{title || headerAction ? (
			<div className="flex items-center justify-between px-3.5">
				{title ? (
					<h3 className="font-medium text-foreground/70 text-xs">{title}</h3>
				) : (
					<span />
				)}
				{headerAction}
			</div>
		) : null}
		{children}
		{caption ? (
			<p className="px-3.5 text-muted-foreground text-xs leading-snug">
				{caption}
			</p>
		) : null}
	</div>
);
