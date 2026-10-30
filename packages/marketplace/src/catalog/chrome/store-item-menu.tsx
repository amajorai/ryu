import {
	Alert02Icon,
	Delete01Icon,
	Download04Icon,
	MoreHorizontalIcon,
	PauseIcon,
	PlayIcon,
	Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ContextMenuItem,
	ContextMenuSeparator,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Fragment } from "react";
import type { StoreItemActionProps } from "./store-item-action-props.ts";

/**
 * Shared menu items used by both the installed DropdownMenu and the
 * not-installed ContextMenu. Renders Settings, the Enable/Disable toggle,
 * Report, and Remove — each conditionally.
 */
export function StoreItemMenuItems({
	hasEnableConcept,
	isEnabled,
	canReport,
	onEnable,
	onDisable,
	onOpenSettings,
	onReport,
	onUninstall,
	enableLabel = "Enable",
	disableLabel = "Disable",
}: {
	canReport: boolean;
	disableLabel?: string;
	enableLabel?: string;
	hasEnableConcept: boolean;
	isEnabled: boolean;
	onDisable?: () => void;
	onEnable?: () => void;
	onOpenSettings?: () => void;
	onReport: () => void;
	onUninstall?: () => void;
}) {
	// Whether a toggle row actually renders — an enable concept with no handler for
	// the CURRENT direction renders nothing, so the separator must not assume one.
	const hasToggleItem =
		hasEnableConcept && Boolean(isEnabled ? onDisable : onEnable);
	return (
		<>
			{/* Settings leads the menu: it is the reason a user opens it on an item
			    that is already installed and working. */}
			{onOpenSettings ? (
				<DropdownMenuItem onClick={onOpenSettings}>
					<HugeiconsIcon className="size-4" icon={Settings01Icon} />
					Settings
				</DropdownMenuItem>
			) : null}
			{hasEnableConcept &&
				(isEnabled ? (
					// A one-way toggle (an Engines "Text" row can be SWAPPED to, never
					// switched off) passes no `onDisable` — render nothing rather than a
					// menu entry that does nothing when clicked.
					onDisable ? (
						<DropdownMenuItem onClick={onDisable}>
							<HugeiconsIcon className="size-4" icon={PauseIcon} />
							{disableLabel}
						</DropdownMenuItem>
					) : null
				) : onEnable ? (
					<DropdownMenuItem onClick={onEnable}>
						<HugeiconsIcon className="size-4" icon={PlayIcon} />
						{enableLabel}
					</DropdownMenuItem>
				) : null)}
			{canReport ? (
				<DropdownMenuItem onClick={onReport}>
					<HugeiconsIcon className="size-4" icon={Alert02Icon} />
					Report
				</DropdownMenuItem>
			) : null}
			{onUninstall ? (
				<>
					{hasToggleItem || canReport ? <DropdownMenuSeparator /> : null}
					<DropdownMenuItem onClick={onUninstall} variant="destructive">
						<HugeiconsIcon className="size-4" icon={Delete01Icon} />
						Remove
					</DropdownMenuItem>
				</>
			) : null}
		</>
	);
}

/**
 * The rows of a catalog card's RIGHT-CLICK menu — the same verbs the card's own
 * control offers, in the same order.
 *
 * It exists because the two menus cannot share a renderer: the dropdown is built
 * from `DropdownMenuItem` and a context menu from `ContextMenuItem`, and Base UI
 * gives each its own keyboard/roving-focus wiring, so one cannot be nested in
 * the other's content. Only the DECISIONS are shared, and they are stated once
 * here in the same shape {@link StoreItemAction} uses.
 *
 * Before this, right-click reached only NOT-installed cards, and only through
 * the Add button rather than the card — so the gesture worked on exactly the
 * listings you had not adopted yet and did nothing on the ones you manage. An
 * installed listing is the one with more to do to it, not less.
 *
 * Returns `undefined` when it would render nothing, so a caller can pass the
 * result straight to `contextMenu` and get no menu rather than an empty one.
 */
export function storeItemContextMenu({
	canReport,
	disableLabel = "Disable",
	enabled,
	enableLabel = "Enable",
	extra,
	incompatible = null,
	installed = false,
	locked = false,
	onDisable,
	onEnable,
	onInstall,
	onOpenSettings,
	onReport,
	onUninstall,
}: {
	canReport?: boolean;
	disableLabel?: string;
	/** `undefined` = no enable/disable concept, exactly as in StoreItemAction. */
	enabled?: boolean;
	enableLabel?: string;
	/** Extra rows, already `ContextMenuItem`s. Appended last. */
	extra?: React.ReactNode;
	/** Non-null when host floors are unmet — Get and Enable are withheld, since
	 *  Core refuses both, but Remove for an on-disk copy stays. */
	incompatible?: string | null;
	installed?: boolean;
	/** Built-in / un-removable: no Remove row. */
	locked?: boolean;
	onDisable?: () => void;
	onEnable?: () => void;
	onInstall?: () => void;
	onOpenSettings?: () => void;
	onReport?: () => void;
	onUninstall?: () => void;
}): React.ReactNode | undefined {
	const rows: React.ReactNode[] = [];
	const report = canReport && onReport ? onReport : undefined;

	if (!installed) {
		if (onInstall && !incompatible) {
			rows.push(
				<ContextMenuItem key="add" onClick={onInstall}>
					<HugeiconsIcon className="size-4" icon={Download04Icon} />
					Get
				</ContextMenuItem>
			);
		}
		if (report) {
			if (rows.length > 0) {
				rows.push(<ContextMenuSeparator key="sep-report" />);
			}
			rows.push(
				<ContextMenuItem key="report" onClick={report}>
					<HugeiconsIcon className="size-4" icon={Alert02Icon} />
					Report
				</ContextMenuItem>
			);
		}
		if (extra) {
			rows.push(<Fragment key="extra">{extra}</Fragment>);
		}
		return rows.length > 0 ? rows : undefined;
	}

	// Installed. Settings leads for the same reason it leads the dropdown: it is
	// why you open the menu on something that is already working.
	if (onOpenSettings) {
		rows.push(
			<ContextMenuItem key="settings" onClick={onOpenSettings}>
				<HugeiconsIcon className="size-4" icon={Settings01Icon} />
				Settings
			</ContextMenuItem>
		);
	}
	// An unmet host floor means the item cannot run here at all, so the toggle is
	// withheld — offering Enable would read as "one click from working".
	if (enabled !== undefined && !incompatible) {
		if (enabled && onDisable) {
			rows.push(
				<ContextMenuItem key="disable" onClick={onDisable}>
					<HugeiconsIcon className="size-4" icon={PauseIcon} />
					{disableLabel}
				</ContextMenuItem>
			);
		} else if (!enabled && onEnable) {
			rows.push(
				<ContextMenuItem key="enable" onClick={onEnable}>
					<HugeiconsIcon className="size-4" icon={PlayIcon} />
					{enableLabel}
				</ContextMenuItem>
			);
		}
	}
	if (report) {
		rows.push(
			<ContextMenuItem key="report" onClick={report}>
				<HugeiconsIcon className="size-4" icon={Alert02Icon} />
				Report
			</ContextMenuItem>
		);
	}
	if (extra) {
		rows.push(<Fragment key="extra">{extra}</Fragment>);
	}
	if (onUninstall && !locked) {
		if (rows.length > 0) {
			rows.push(<ContextMenuSeparator key="sep-remove" />);
		}
		rows.push(
			<ContextMenuItem key="remove" onClick={onUninstall} variant="destructive">
				<HugeiconsIcon className="size-4" icon={Delete01Icon} />
				Remove
			</ContextMenuItem>
		);
	}
	return rows.length > 0 ? rows : undefined;
}

/**
 * Standalone 3-dot overflow for items whose primary control is static — the
 * locked (built-in) status glyph, the read-only web affordance, and the "Required"
 * badge a mandatory listing renders instead of lifecycle buttons. Holds Settings
 * and/or Report; renders nothing when it would be empty, so a caller can mount it
 * unconditionally.
 *
 * Exported because the mandatory-listing branch has no StoreItemAction to hang
 * these off: it deliberately renders no lifecycle control, but a required app is
 * still configurable and its settings must stay reachable from the card.
 */
export function StoreItemOverflowMenu({
	onOpenSettings,
	onReport,
	className,
	extra,
}: {
	className?: string;
	/** Appended after Settings/Report — see {@link StoreItemActionProps.extra}. */
	extra?: React.ReactNode;
	onOpenSettings?: () => void;
	onReport?: () => void;
}) {
	if (!(onOpenSettings || onReport || extra)) {
		return null;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label="More actions"
						className={className}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				{onOpenSettings ? (
					<DropdownMenuItem onClick={onOpenSettings}>
						<HugeiconsIcon className="size-4" icon={Settings01Icon} />
						Settings
					</DropdownMenuItem>
				) : null}
				{onReport ? (
					<DropdownMenuItem onClick={onReport}>
						<HugeiconsIcon className="size-4" icon={Alert02Icon} />
						Report
					</DropdownMenuItem>
				) : null}
				{extra}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
