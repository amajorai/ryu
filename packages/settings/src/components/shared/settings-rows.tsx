import {
	Item,
	ItemActions,
	ItemGroup,
	ItemSeparator,
	ItemTitle,
} from "@ryu/ui/components/item.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Children, Fragment, isValidElement, type ReactNode } from "react";

// iOS-style settings primitives for @ryu/settings.
//
// Local equivalents of SettingsSection / SettingsGroup / SettingsItem /
// SettingsCard from `packages/blocks/src/desktop/settings-items.tsx`, which this
// package cannot import (@ryu/settings does not depend on @ryu/blocks). Keep the
// classes in step with that file so the shared web tabs look like the desktop
// Settings panes. Deliberately smaller: no i18n lookup (the @ryu/ui primitives
// localize themselves), no `bare` rows, and no description-to-footer slicing —
// callers put explanatory text on the section `caption`.

/** Small muted section header, for a header that must be a `legend`/`label`. */
export const SETTINGS_SECTION_HEADER_CLASS =
	"px-3.5 font-medium text-foreground/70 text-xs";

/** Muted caption below a section body. */
const SETTINGS_CAPTION_CLASS =
	"px-3.5 text-muted-foreground text-xs leading-snug";

/**
 * Borderless card surface shared by groups and cards — the same
 * `rounded-xl bg-grouped-card` as the desktop `SURFACE`, so a `grouped-pane`
 * raises it to white-on-grey and a plain page keeps the muted tint.
 */
const SETTINGS_SURFACE_CLASS = "rounded-xl bg-grouped-card";

interface SettingsSectionProps {
	/**
	 * Root element. Use `section` when the block is a landmark-style region
	 * (tests or assistive tech look it up by `<section>`), `fieldset` for a
	 * group of form controls. Defaults to `div`, like the desktop primitive.
	 */
	as?: "div" | "fieldset" | "section";
	/** Optional caption rendered below the body, in muted text. */
	caption?: ReactNode;
	children: ReactNode;
	className?: string;
	/** Optional node rendered on the right of the header row (e.g. an action). */
	headerAction?: ReactNode;
	/** Section header label. Omit for an unlabeled section. */
	title?: ReactNode;
	/**
	 * Id for the header `h3`. When set, the root is labelled by it
	 * (`aria-labelledby`), so a `section`/`fieldset` gets an accessible name.
	 */
	titleId?: string;
}

/** A small muted header, a body, and an optional caption below it. */
export function SettingsSection({
	as: Root = "div",
	caption,
	children,
	className,
	headerAction,
	title,
	titleId,
}: SettingsSectionProps) {
	return (
		<Root
			aria-labelledby={title && titleId ? titleId : undefined}
			className={cn("space-y-1.5", className)}
		>
			{title || headerAction ? (
				<div className="flex items-center justify-between gap-3 px-3.5">
					{title ? (
						<h3 className="font-medium text-foreground/70 text-xs" id={titleId}>
							{title}
						</h3>
					) : (
						<span />
					)}
					{headerAction}
				</div>
			) : null}
			{children}
			{caption ? <p className={SETTINGS_CAPTION_CLASS}>{caption}</p> : null}
		</Root>
	);
}

interface SettingsGroupProps {
	children: ReactNode;
	className?: string;
}

/**
 * The rounded grouped card of rows, with hairline separators between them.
 * Children are usually {@link SettingsItem}s, or `Item purpose="settings-row"`
 * when a row needs custom markup (e.g. rendered as a `label`).
 */
export function SettingsGroup({ children, className }: SettingsGroupProps) {
	const rows = Children.toArray(children);
	return (
		<ItemGroup
			appearance="settings-group"
			className={cn("overflow-hidden", className)}
			spacing="flush"
		>
			{rows.map((row, index) => (
				// Children.toArray keys every element, so the row's own key is stable.
				<Fragment key={isValidElement(row) ? row.key : String(row)}>
					{index > 0 ? <ItemSeparator className="my-0" /> : null}
					{row}
				</Fragment>
			))}
		</ItemGroup>
	);
}

interface SettingsItemProps {
	/** Control on the right of the row (Switch, Button, Badge, value text). */
	actions?: ReactNode;
	/** Full-width content below the title line (meta text, inline fields). */
	children?: ReactNode;
	className?: string;
	title: ReactNode;
}

/** One settings row: title left, optional control right, optional body below. */
export function SettingsItem({
	actions,
	children,
	className,
	title,
}: SettingsItemProps) {
	return (
		<Item className={className} purpose="settings-row" size="sm">
			{/* Wraps the controls under the title when the row is too narrow for
			    both, instead of squeezing the title underneath them. */}
			<div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2">
				<div className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
					<ItemTitle typography="settings-label">{title}</ItemTitle>
				</div>
				{actions ? (
					<ItemActions className="ml-auto shrink-0">{actions}</ItemActions>
				) : null}
			</div>
			{children}
		</Item>
	);
}

interface SettingsCardProps {
	children: ReactNode;
	className?: string;
}

/**
 * The same surface as {@link SettingsGroup} with padding, for non-row content:
 * empty states, forms with several fields, charts, tables, long lists.
 */
export function SettingsCard({ children, className }: SettingsCardProps) {
	return (
		<div className={cn(SETTINGS_SURFACE_CLASS, "p-3.5", className)}>
			{children}
		</div>
	);
}
