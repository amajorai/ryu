"use client";

import {
	ArrowDown01Icon,
	Loading03Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useState } from "react";
import { COMPOSER_SELECT_TRIGGER } from "@/components/agent-elements/input/composer-select.ts";

export interface ComposerSettingItem {
	description?: string | null;
	id: string;
	name: string;
}

/** A colour + icon applied to a setting item (see `ComposerSettingsSection.decorate`). */
export interface ItemDecoration {
	className: string;
	icon: IconSvgElement;
}

export interface ComposerSettingsSection {
	/** Overrides the trigger summary name (else the active item's name is used). */
	activeName?: string;
	ariaLabel: string;
	/**
	 * Optional per-item colour + icon (e.g. the approval section's CLI-style mode
	 * tones — accept-edits purple, plan green, bypass red, auto amber). Applied to
	 * both the submenu rows and the sub-trigger's active-value summary. Returning
	 * `undefined` for an item leaves it plain.
	 */
	decorate?: (item: ComposerSettingItem) => ItemDecoration | undefined;
	items: ComposerSettingItem[];
	key: string;
	/** Section header + the muted prefix in the trigger summary. */
	label: string;
	/**
	 * The section's options are still being probed (the per-agent ACP capability
	 * fetch is in flight). Keeps the section visible with a "Detecting…" spinner
	 * instead of silently hiding it while `items` is momentarily empty — so
	 * switching to an agent whose model/thinking pickers are still loading reads
	 * as loading, not missing.
	 */
	loading?: boolean;
	onChange: (id: string) => void;
	/**
	 * Custom body for the section (e.g. the agent picker's grouped/icon rows).
	 * When omitted, a plain checked-item list is rendered from `items`.
	 */
	renderContent?: (onSelect: (id: string) => void) => ReactNode;
	value: string | undefined;
}

export interface ComposerSettingsMenuProps {
	/** Anchor edge of the dropdown content. Defaults to `"start"`. */
	align?: "start" | "center" | "end";
	className?: string;
	/**
	 * Compact trigger: show ONLY the first section's active value (the agent
	 * name) instead of the full `Agent · Model · Approval` summary. Used in the
	 * composer's single-row compact mode, where the trigger reads
	 * `[agent logo] Ryu [usage] ⌄` — the model/approval settings still live
	 * inside the dropdown, just not spelled out in the trigger.
	 */
	compact?: boolean;
	/**
	 * Extra content pinned to the bottom of the dropdown, below the setting
	 * sections (e.g. the subscription usage meters in the composer's compact
	 * mode, where they no longer fit as standalone toolbar chips). The wrapper
	 * self-hides when the node renders nothing, so passing a component that may
	 * return `null` (like `UsageBar`) never leaves an empty bordered strip.
	 */
	footer?: ReactNode;
	/**
	 * A mark rendered at the START of the default trigger, before the summary —
	 * the active agent's engine logo or custom avatar image in compact mode. It
	 * must be a non-button node (a logo `<img>`/svg) so it nests safely inside
	 * the trigger `<button>`.
	 */
	leading?: ReactNode;
	/**
	 * Replaces the default sibling-submenu body (one `DropdownMenuSub` per
	 * section) with a caller-owned dropdown body — the universal picker's
	 * grouped `Ryu Portal · Providers · External Agents` layout. The trigger
	 * summary still derives from `sections` (so `Ryu · Sonnet · Plan` stays
	 * glanceable); only the popover body changes. `close` collapses the menu
	 * after a selection. When omitted, the sections render as before.
	 */
	renderBody?: (close: () => void) => ReactNode;
	sections: ComposerSettingsSection[];
	/** Side the dropdown content opens toward. Defaults to `"top"` (composer). */
	side?: "top" | "bottom" | "left" | "right";
	/**
	 * A node rendered at the END of the default trigger, after the summary — the
	 * subscription usage meters in compact mode, sat beside the agent name. Like
	 * `leading`, it must render non-button content (the `UsageBar`'s tooltip
	 * triggers are `<span>`s) so it nests safely inside the trigger `<button>`.
	 */
	trailing?: ReactNode;
	/**
	 * A custom trigger element rendered in place of the default summary Button —
	 * e.g. the empty-state agent logo. It receives the dropdown's open/close
	 * wiring via base-ui's `render`, so a caller gets the EXACT same Agent ·
	 * Model · Thinking dropdown behind a different-looking trigger. When omitted,
	 * the default `Ryu · Sonnet · Plan` summary button is shown.
	 */
	trigger?: ReactNode;
}

function activeItem(
	section: ComposerSettingsSection
): ComposerSettingItem | undefined {
	return (
		section.items.find((it) => it.id === section.value) ?? section.items[0]
	);
}

function activeItemName(section: ComposerSettingsSection): string | undefined {
	if (section.activeName) {
		return section.activeName;
	}
	return activeItem(section)?.name;
}

/**
 * One composer control that merges the agent, model, and approval-policy (plus
 * any agent-advertised config) pickers into a single dropdown. The trigger shows
 * every active setting at a glance (`Ryu · Sonnet · Plan`); the popover lists each
 * setting as its own labelled section. Sections with no options are skipped, so
 * an agent that advertises no model or no permission modes simply shows fewer
 * rows — nothing is hardcoded.
 */
export function ComposerSettingsMenu({
	sections,
	className,
	compact = false,
	footer,
	leading,
	trailing,
	trigger,
	renderBody,
	side = "top",
	align = "start",
}: ComposerSettingsMenuProps) {
	const [open, setOpen] = useState(false);

	// A section stays visible while its options are still being probed, even with
	// no items yet — so an in-flight agent switch shows a loading row, not nothing.
	const isLoadingEmpty = (s: ComposerSettingsSection) =>
		Boolean(s.loading) && s.items.length === 0;
	const visibleSections = sections.filter(
		(s) => s.items.length > 0 || isLoadingEmpty(s)
	);
	// With a custom body (the universal picker) the summary may be empty while the
	// body still has content, so only bail when there's nothing at all to show.
	if (visibleSections.length === 0 && !renderBody) {
		return null;
	}

	// Each trigger segment carries its section's active decoration (icon + tone),
	// so the approval mode reads in the trigger with the SAME icon/colour it shows
	// inside the dropdown (agent/model have no `decorate`, so they stay plain).
	const summary = visibleSections
		.map((section) => {
			if (isLoadingEmpty(section)) {
				return { name: "Detecting…", deco: undefined, loading: true };
			}
			const name = activeItemName(section);
			if (!name) {
				return null;
			}
			const deco = section.decorate?.(
				activeItem(section) ?? { id: "", name: "" }
			);
			return { name, deco, loading: false };
		})
		.filter(
			(
				s
			): s is {
				deco: ItemDecoration | undefined;
				loading: boolean;
				name: string;
			} => s !== null
		);

	const closeAfter = (section: ComposerSettingsSection) => (id: string) => {
		section.onChange(id);
		setOpen(false);
	};

	const renderRow =
		(section: ComposerSettingsSection) => (item: ComposerSettingItem) => {
			const isActive = item.id === (section.value ?? section.items[0]?.id);
			const deco = section.decorate?.(item);
			return (
				<DropdownMenuItem
					className={cn(
						"flex-col items-start gap-0.5",
						isActive && "bg-foreground/10"
					)}
					key={item.id}
					onClick={() => closeAfter(section)(item.id)}
				>
					<span className="flex w-full items-center gap-2.5">
						{deco && (
							<HugeiconsIcon
								className={cn("shrink-0", deco.className)}
								icon={deco.icon}
								size={16}
								strokeWidth={2}
							/>
						)}
						<span className={cn("flex-1 truncate", deco?.className)}>
							{item.name}
						</span>
						{isActive && (
							<HugeiconsIcon
								className="shrink-0 text-muted-foreground"
								icon={Tick02Icon}
								size={16}
								strokeWidth={2}
							/>
						)}
					</span>
					{item.description && (
						<span className="w-full truncate text-left font-normal text-muted-foreground text-xs">
							{item.description}
						</span>
					)}
				</DropdownMenuItem>
			);
		};

	return (
		<DropdownMenu onOpenChange={setOpen} open={open}>
			{trigger ? (
				<DropdownMenuTrigger render={trigger} />
			) : (
				<DropdownMenuTrigger
					render={
						<Button
							aria-label="Chat settings"
							className={cn(COMPOSER_SELECT_TRIGGER, className)}
							size="sm"
							type="button"
							variant="ghost"
						/>
					}
				>
					<span className="flex min-w-0 items-center gap-1 truncate font-medium">
						{leading}
						{compact ? (
							// Compact mode names only the agent (the first section); the model
							// and approval settings stay reachable inside the dropdown.
							<span className="truncate">{summary[0]?.name}</span>
						) : (
							summary.map(({ name, deco, loading }, i) => (
								<span className="flex items-center gap-1" key={name + i}>
									{i > 0 && <span className="text-muted-foreground/50">·</span>}
									{loading ? (
										<HugeiconsIcon
											className="shrink-0 animate-spin text-muted-foreground"
											icon={Loading03Icon}
											size={13}
											strokeWidth={2}
										/>
									) : (
										deco && (
											<HugeiconsIcon
												className={cn("shrink-0", deco.className)}
												icon={deco.icon}
												size={13}
												strokeWidth={2}
											/>
										)
									)}
									<span
										className={cn(
											"truncate",
											loading ? "text-muted-foreground" : deco?.className
										)}
									>
										{name}
									</span>
								</span>
							))
						)}
						{trailing}
					</span>
					<HugeiconsIcon
						className="shrink-0 text-muted-foreground"
						icon={ArrowDown01Icon}
						size={12}
					/>
				</DropdownMenuTrigger>
			)}
			<DropdownMenuContent
				align={align}
				className={cn(
					renderBody
						? "min-w-[260px] max-w-[320px]"
						: "min-w-[200px] max-w-[280px]"
				)}
				side={side}
				sideOffset={6}
			>
				{renderBody
					? renderBody(() => setOpen(false))
					: visibleSections.map((section) => {
					const loadingEmpty = isLoadingEmpty(section);
					const activeDeco = section.decorate?.(
						activeItem(section) ?? {
							id: "",
							name: "",
						}
					);
					let sectionBody: ReactNode;
					if (loadingEmpty) {
						sectionBody = (
							<div className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-muted-foreground">
								<HugeiconsIcon
									className="shrink-0 animate-spin"
									icon={Loading03Icon}
									size={14}
									strokeWidth={2}
								/>
								<span>Detecting available options…</span>
							</div>
						);
					} else if (section.renderContent) {
						sectionBody = section.renderContent(closeAfter(section));
					} else {
						sectionBody = section.items.map(renderRow(section));
					}
					return (
						<DropdownMenuSub key={section.key}>
							<DropdownMenuSubTrigger>
								<span className="flex-1 text-[13px] text-muted-foreground">
									{section.label}
								</span>
								<span
									className={cn(
										"flex max-w-[160px] items-center gap-1.5 text-[13px] text-muted-foreground",
										!loadingEmpty && activeDeco?.className
									)}
								>
									{loadingEmpty ? (
										<HugeiconsIcon
											className="shrink-0 animate-spin"
											icon={Loading03Icon}
											size={14}
											strokeWidth={2}
										/>
									) : (
										activeDeco && (
											<HugeiconsIcon
												className="shrink-0"
												icon={activeDeco.icon}
												size={14}
												strokeWidth={2}
											/>
										)
									)}
									<span className="truncate">
										{loadingEmpty ? "Detecting…" : activeItemName(section)}
									</span>
								</span>
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-80 min-w-[220px] max-w-[300px] overflow-hidden p-0">
								{sectionBody}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					);
				})}
				{footer && (
					<div className="mt-1 border-border/60 border-t px-2 pt-2 pb-1 empty:hidden">
						{footer}
					</div>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
