import {
	Item,
	ItemActions,
	ItemGroup,
	ItemTitle,
} from "@ryu/ui/components/item.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Children, type ReactNode } from "react";

// Quiet, flush settings primitives for @ryu/settings.
//
// Local equivalents of SettingsSection / SettingsGroup / SettingsItem /
// SettingsCard from `packages/blocks/src/desktop/settings-items.tsx`, which this
// package cannot import (@ryu/settings does not depend on @ryu/blocks). Keep the
// classes in step with that file so the shared web tabs look like the desktop
// Settings panes: a section is a small semibold title, its rows are separated by
// full-width hairlines, and nothing sits in a card. Deliberately smaller: no
// i18n lookup (the @ryu/ui primitives localize themselves) and no `bare` rows.

/** Section header class, for a header that must be a `legend`/`label`. */
export const SETTINGS_SECTION_HEADER_CLASS =
	"font-semibold text-foreground text-sm";

/** Muted caption below a section body. */
const SETTINGS_CAPTION_CLASS = "mt-2 text-detail text-muted-foreground";

/** The flush row geometry: 48px, no card inset, set off by hairlines alone. */
const FLUSH_ROW =
	"min-h-12 px-0 py-3 not-in-data-[slot=item-group]:rounded-none not-in-data-[slot=item-group]:bg-transparent";

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

/**
 * A semibold title, a body and an optional caption. Sections are 32px apart;
 * the first one has no top margin.
 */
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
			className={cn("mt-8 first:mt-0", className)}
		>
			{title || headerAction ? (
				<div className="mb-1 flex items-center justify-between gap-2">
					{title ? (
						<h3 className={SETTINGS_SECTION_HEADER_CLASS} id={titleId}>
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
 * One flush list of rows with full-width hairlines between them and none after
 * the last. Children are usually {@link SettingsItem}s, or
 * `Item purpose="settings-row"` when a row needs custom markup (e.g. rendered
 * as a `label`).
 */
export function SettingsGroup({ children, className }: SettingsGroupProps) {
	return (
		<ItemGroup className={className} variant="flush">
			{Children.toArray(children)}
		</ItemGroup>
	);
}

interface SettingsItemProps {
	/** Control on the right of the row (Switch, Button, Badge, value text). */
	actions?: ReactNode;
	/** Full-width content below the title line (meta text, inline fields). */
	children?: ReactNode;
	className?: string;
	/** One short muted line under the label, inside the row. */
	description?: ReactNode;
	title: ReactNode;
}

/** One settings row: title left, optional control right, optional body below. */
export function SettingsItem({
	actions,
	children,
	className,
	description,
	title,
}: SettingsItemProps) {
	return (
		<Item className={cn(FLUSH_ROW, className)} purpose="settings-row" size="sm">
			{/* Wraps the controls under the title when the row is too narrow for
			    both, instead of squeezing the title underneath them. */}
			<div className="flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2">
				<div className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
					<ItemTitle typography="settings-label">{title}</ItemTitle>
					{description ? (
						<p className="text-detail text-muted-foreground">{description}</p>
					) : null}
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
 * A container for non-row content (empty states, forms with several fields,
 * charts, tables, long lists). Flush: a plain block with no fill, padding or
 * border, so it sits in the pane like the rows around it.
 */
export function SettingsCard({ children, className }: SettingsCardProps) {
	return (
		<div className={className} data-slot="settings-card">
			{children}
		</div>
	);
}

/**
 * Hover reveal for a row's trailing action: hidden until the row is hovered or
 * holds focus, always shown where there is no hover (touch). The slot keeps
 * its width while hidden, so nothing reflows when it appears.
 */
export const SETTINGS_ROW_REVEAL_CLASS =
	"opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-focus-within/item:opacity-100 group-hover/item:opacity-100 group-hover/item:duration-0 [@media(hover:none)]:opacity-100";
