"use client";

import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
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
import { isValidElement, type ReactNode, useState } from "react";
import styles from "./composer-settings-menu.module.css";
import {
	FullAccessSelectionProvider,
	isFullAccessEquivalent,
	useFullAccessSelectionGuard,
} from "./full-access-warning.tsx";

export interface ComposerSettingItem {
	description?: string | null;
	id: string;
	name: string;
}

export interface ItemDecoration {
	className: string;
	icon: IconSvgElement;
}

export interface ComposerSettingsSection {
	activeName?: string;
	ariaLabel: string;
	decorate?: (item: ComposerSettingItem) => ItemDecoration | undefined;
	items: ComposerSettingItem[];
	key: string;
	label: string;
	onChange: (id: string) => void;
	renderContent?: (onSelect: (id: string) => void) => ReactNode;
	value: string | undefined;
	/**
	 * How the section's options are picked. `"list"` (the default) is the checked
	 * submenu; `"slider"` renders them inline as a stepped slider — one detent per
	 * item, in the advertised order. Only for ORDERED scales (reasoning effort),
	 * and the detent count is the live list's length, so a 3-level agent and a
	 * 5-level one each get their own. Surfaces that do not implement the slider
	 * fall back to the list, so setting it is always safe.
	 */
	variant?: "list" | "slider";
}

export interface ComposerSettingsMenuProps {
	align?: "start" | "center" | "end";
	className?: string;
	compact?: boolean;
	footer?: ReactNode;
	leading?: ReactNode;
	sections: ComposerSettingsSection[];
	side?: "top" | "bottom" | "left" | "right";
	tone?: "muted" | "foreground";
	trailing?: ReactNode;
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

export function ComposerSettingsMenu(props: ComposerSettingsMenuProps) {
	const agentSection = props.sections.find(
		(section) => section.key === "agent"
	);
	return (
		<FullAccessSelectionProvider
			agentName={agentSection ? activeItemName(agentSection) : undefined}
		>
			<ComposerSettingsMenuContent {...props} />
		</FullAccessSelectionProvider>
	);
}

function ComposerSettingsMenuContent({
	sections,
	className,
	compact = false,
	tone = "muted",
	footer,
	leading,
	trailing,
	trigger,
	side = "top",
	align = "start",
}: ComposerSettingsMenuProps) {
	const [open, setOpen] = useState(false);
	const selectionGuard = useFullAccessSelectionGuard();

	const visibleSections = sections.filter((s) => s.items.length > 0);
	if (visibleSections.length === 0) {
		return null;
	}

	const summary = visibleSections
		.map((section) => {
			const name = activeItemName(section);
			if (!name) {
				return null;
			}
			const deco = section.decorate?.(
				activeItem(section) ?? { id: "", name: "" }
			);
			return { name, deco };
		})
		.filter(
			(s): s is { deco: ItemDecoration | undefined; name: string } => s !== null
		);

	const closeAfter = (section: ComposerSettingsSection) => (id: string) => {
		const item = section.items.find((candidate) => candidate.id === id);
		const apply = () => {
			section.onChange(id);
			setOpen(false);
		};
		if (item && isFullAccessEquivalent(item, section.label)) {
			setOpen(false);
		}
		selectionGuard?.request(item ?? { id, name: id }, apply, section.label);
	};

	const renderRow =
		(section: ComposerSettingsSection) => (item: ComposerSettingItem) => {
			const isActive = item.id === (section.value ?? section.items[0]?.id);
			const deco = section.decorate?.(item);
			return (
				<DropdownMenuItem
					active={isActive}
					className="flex-col items-start"
					key={item.id}
					onClick={() => closeAfter(section)(item.id)}
					spacing="tight"
				>
					<span className="flex w-full items-center gap-2.5">
						{deco ? (
							<HugeiconsIcon
								className={cn("shrink-0", deco.className)}
								icon={deco.icon}
								size={16}
								strokeWidth={2}
							/>
						) : null}
						<span className={cn("flex-1 truncate", deco?.className)}>
							{item.name}
						</span>
						{isActive ? (
							<HugeiconsIcon
								className="shrink-0 text-muted-foreground"
								icon={Tick02Icon}
								size={16}
								strokeWidth={2}
							/>
						) : null}
					</span>
					{item.description ? (
						<span className="w-full truncate text-left font-normal text-muted-foreground text-xs">
							{item.description}
						</span>
					) : null}
				</DropdownMenuItem>
			);
		};

	return (
		<DropdownMenu onOpenChange={setOpen} open={open}>
			{trigger ? (
				<DropdownMenuTrigger
					render={
						isValidElement(trigger) ? (
							trigger
						) : (
							<Button
								appearance={
									tone === "foreground"
										? "composer-settings-foreground"
										: "composer-settings"
								}
								className={className}
								size="sm"
								type="button"
								variant="ghost"
							>
								{trigger}
							</Button>
						)
					}
				/>
			) : (
				<DropdownMenuTrigger
					render={
						<Button
							appearance={
								tone === "foreground"
									? "composer-settings-foreground"
									: "composer-settings"
							}
							aria-label="Chat settings"
							className={className}
							size="sm"
							type="button"
							variant="ghost"
						/>
					}
				>
					<span className="flex min-w-0 items-center gap-1 truncate font-medium">
						{leading}
						{compact ? (
							<span className="truncate">{summary[0]?.name}</span>
						) : (
							summary.map(({ name, deco }, i) => (
								<span className="flex items-center gap-1" key={name + i}>
									{i > 0 ? (
										<span className="text-muted-foreground/50">·</span>
									) : null}
									{deco ? (
										<HugeiconsIcon
											className={cn("shrink-0", deco.className)}
											icon={deco.icon}
											size={13}
											strokeWidth={2}
										/>
									) : null}
									<span className={cn("truncate", deco?.className)}>
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
				className="min-w-[200px] max-w-[280px]"
				side={side}
				sideOffset={6}
			>
				{visibleSections.map((section) => {
					const activeDeco = section.decorate?.(
						activeItem(section) ?? {
							id: "",
							name: "",
						}
					);
					return (
						<DropdownMenuSub key={section.key}>
							<DropdownMenuSubTrigger>
								<span className="type-detail flex-1 text-muted-foreground">
									{section.label}
								</span>
								<span
									className={cn(
										"type-detail flex max-w-[160px] items-center gap-1.5",
										activeDeco?.className
									)}
								>
									{activeDeco ? (
										<HugeiconsIcon
											className="shrink-0"
											icon={activeDeco.icon}
											size={14}
											strokeWidth={2}
										/>
									) : null}
									<span className="truncate">{activeItemName(section)}</span>
								</span>
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent
								className="max-h-80 min-w-[220px] max-w-[300px] overflow-hidden"
								render={<div className={styles.submenu} />}
							>
								{section.renderContent
									? section.renderContent(closeAfter(section))
									: section.items.map(renderRow(section))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					);
				})}
				{footer ? (
					<div className="mt-1 border-border/60 border-t px-2 pt-2 pb-1 empty:hidden">
						{footer}
					</div>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
