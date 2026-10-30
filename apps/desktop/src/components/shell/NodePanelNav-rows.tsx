// apps/desktop/src/components/shell/NodePanelNav-rows.tsx
//
// The settings sections, cards and rows the node panel pages are built from.
// Re-exported from `NodePanelNav.tsx`, which remains the public import path.

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import {
	SettingsIconTile,
	type SettingsTint,
} from "@ryu/blocks/desktop/settings-nav.tsx";
import { ItemGroup } from "@ryu/ui/components/item.tsx";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils.ts";
import styles from "./NodePanelNav.module.css";

/**
 * One settings section — the same `SettingsSection` header/caption and
 * `settings-group` card the App Settings screens use, so the dialog reads as
 * part of Settings rather than a lookalike.
 */
export function PanelSection({
	children,
	footer,
	title,
	trailing,
}: {
	children: ReactNode;
	footer?: ReactNode;
	title?: ReactNode;
	trailing?: ReactNode;
}) {
	return (
		<SettingsSection caption={footer} headerAction={trailing} title={title}>
			<PanelGroup>{children}</PanelGroup>
		</SettingsSection>
	);
}

/**
 * The grouped card: Settings' `settings-group` surface, with inset hairlines
 * between rows (see `NodePanelNav.module.css`). An empty card collapses.
 */
export function PanelGroup({ children }: { children: ReactNode }) {
	return (
		<ItemGroup
			appearance="settings-group"
			className={cn("overflow-hidden empty:hidden", styles.group)}
			spacing="flush"
		>
			{children}
		</ItemGroup>
	);
}

/**
 * Settings rows are `SettingsItem`s; ours add one stretched button so the whole
 * row is the click target (the same overlay trick as `SettingsNavRow`), and
 * let the item title fill the row so a value can sit right-aligned in it.
 */
export const ROW_ITEM_CLASS =
	"relative focus-within:bg-foreground/5 [&_[data-slot=item-title]]:w-full";

type RowTone = "default" | "destructive" | "warning" | "accent";

const TONE_TEXT = {
	default: undefined,
	destructive: "text-status-destructive",
	warning: "text-status-warning",
	accent: "text-primary",
} satisfies Record<RowTone, string | undefined>;

/** The row's leading icon (the plain Settings tile), tagged so the card's hairlines can start past it. */
export function PanelRowIcon({
	icon,
	tint = "gray",
}: {
	icon: IconSvgElement;
	tint?: SettingsTint;
}) {
	return (
		<span className="contents" data-slot="panel-row-icon">
			<SettingsIconTile icon={icon} tint={tint} />
		</span>
	);
}

/** Muted right-hand value, iOS-style ("All running", "llama.cpp", a URL). */
export function RowValue({ children }: { children: ReactNode }) {
	return (
		<span
			className="flex min-w-0 max-w-[55%] shrink items-center justify-end gap-1.5 font-normal text-muted-foreground text-sm"
			title={typeof children === "string" ? children : undefined}
		>
			{typeof children === "string" ? (
				<span className="truncate">{children}</span>
			) : (
				children
			)}
		</span>
	);
}

export function Chevron() {
	return (
		<HugeiconsIcon
			aria-hidden
			className="size-4 shrink-0 text-muted-foreground/70 rtl:rotate-180"
			icon={ArrowRight01Icon}
		/>
	);
}

/** A tappable settings row: tile, title, value, trailing mark. */
export function PanelRow({
	children,
	className,
	current,
	disabled,
	icon,
	onClick,
	pressed,
	sideAction,
	tint,
	tone = "default",
	trailing,
	value,
}: {
	children: ReactNode;
	className?: string;
	/** The selected choice in a pick-one list (`aria-current`). */
	current?: boolean;
	/** Settings caption for this row. Read by an enclosing `SettingsGroup`,
	 *  which renders it under the card; the row itself never prints it. */
	description?: ReactNode;
	disabled?: boolean;
	icon?: IconSvgElement;
	onClick?: () => void;
	/** On/off state of an independent toggle row (`aria-pressed`). */
	pressed?: boolean;
	/** A second control beside the row (share, uninstall) — never nested in it. */
	sideAction?: ReactNode;
	tint?: SettingsTint;
	tone?: RowTone;
	/** A mark after the value: the selection tick, a busy label. */
	trailing?: ReactNode;
	value?: ReactNode;
}) {
	return (
		<SettingsItem
			actions={sideAction}
			className={cn(ROW_ITEM_CLASS, disabled && "opacity-50", className)}
			navigation={!disabled}
			title={
				<button
					aria-current={current ? "true" : undefined}
					aria-pressed={pressed}
					className={cn(
						"flex w-full min-w-0 items-center gap-2.5 text-start outline-none disabled:cursor-default",
						TONE_TEXT[tone]
					)}
					disabled={disabled}
					onClick={onClick}
					type="button"
				>
					{icon ? <PanelRowIcon icon={icon} tint={tint} /> : null}
					<span
						className="min-w-0 flex-1 truncate"
						title={typeof children === "string" ? children : undefined}
					>
						{children}
					</span>
					{value === undefined || value === null ? null : (
						<RowValue>{value}</RowValue>
					)}
					{trailing}
					<span aria-hidden="true" className="absolute inset-0" />
				</button>
			}
		/>
	);
}

/** A non-interactive row (the current state at the top of a layer page). */
export function PanelStaticRow({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<SettingsItem
			className={className}
			title={
				<span className="flex w-full min-w-0 items-center gap-2.5">
					{children}
				</span>
			}
		/>
	);
}
