"use client";

import {
	ArrowDown01Icon,
	Search01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { cn } from "@ryu/ui/lib/utils";
import type { ComponentType, ReactNode } from "react";
import { memo, useCallback, useMemo, useState } from "react";
import {
	COMPOSER_SELECT_ITEM,
	COMPOSER_SELECT_POPOVER,
	COMPOSER_SELECT_TRIGGER,
} from "@/components/agent-elements/input/composer-select.ts";

// Below this many options the picker stays a plain list; at or above it a sticky
// filter box appears so long agent/team rosters stay navigable.
const SEARCH_THRESHOLD = 7;

export interface ModeOption {
	description?: string;
	/** Optional section header. Options sharing a group render under one label. */
	group?: string;
	icon?: ComponentType<{ className?: string }>;
	id: string;
	label: string;
}

export interface ModeSelectorProps {
	className?: string;
	defaultValue?: string;
	modes: ModeOption[];
	onChange?: (modeId: string) => void;
	value?: string;
}

/**
 * The grouped option rows of the agent picker, factored out so other surfaces
 * (e.g. the clickable empty-state logo) can render the identical switch menu.
 * Pure presentation — the caller owns open/close state and selection.
 */
export function ModeMenuContent({
	modes,
	activeId,
	onSelect,
	searchable = true,
}: {
	modes: ModeOption[];
	activeId?: string;
	onSelect: (modeId: string) => void;
	/** Show a sticky filter box for long lists. On by default. */
	searchable?: boolean;
}) {
	const [query, setQuery] = useState("");
	const normalizedQuery = query.trim().toLowerCase();
	const showSearch = searchable && modes.length >= SEARCH_THRESHOLD;

	const filtered = useMemo(() => {
		if (!normalizedQuery) {
			return modes;
		}
		return modes.filter((mode) => {
			const hay =
				`${mode.label} ${mode.description ?? ""} ${mode.group ?? ""}`.toLowerCase();
			return hay.includes(normalizedQuery);
		});
	}, [modes, normalizedQuery]);

	// Group options under section headers, preserving first-seen order. When no
	// option declares a group, render one ungrouped (header-less) section so the
	// flat behaviour is unchanged.
	const groups: { label: string | null; items: ModeOption[] }[] = [];
	for (const mode of filtered) {
		const label = mode.group ?? null;
		const existing = groups.find((g) => g.label === label);
		if (existing) {
			existing.items.push(mode);
		} else {
			groups.push({ label, items: [mode] });
		}
	}
	const hasGroups = groups.some((g) => g.label !== null);

	const renderRow = (mode: ModeOption) => {
		const isActive = mode.id === activeId;
		const Icon = mode.icon;
		return (
			<Button
				className={cn(
					COMPOSER_SELECT_ITEM,
					"items-start",
					isActive && "bg-accent"
				)}
				key={mode.id}
				onClick={() => onSelect(mode.id)}
				type="button"
				variant="ghost"
			>
				{Icon && <Icon className="mt-0.5 size-4 shrink-0" />}
				<span className="min-w-0 flex-1">
					<span className="block truncate">{mode.label}</span>
					{mode.description && (
						<span className="block truncate font-normal text-muted-foreground text-sm">
							{mode.description}
						</span>
					)}
				</span>
				{isActive && (
					<HugeiconsIcon
						className="mt-0.5 shrink-0 text-muted-foreground"
						icon={Tick02Icon}
						size={16}
						strokeWidth={2}
					/>
				)}
			</Button>
		);
	};

	let body: ReactNode;
	if (filtered.length === 0) {
		body = (
			<p className="px-3 py-4 text-center text-muted-foreground text-xs">
				No matches for &ldquo;{query.trim()}&rdquo;
			</p>
		);
	} else if (hasGroups) {
		body = groups.map((group) => (
			<div key={group.label ?? "__ungrouped__"}>
				{group.label && (
					<div className="px-3 pt-2 pb-1 font-medium text-[11px] text-muted-foreground">
						{group.label}
					</div>
				)}
				{group.items.map(renderRow)}
			</div>
		));
	} else {
		body = filtered.map(renderRow);
	}

	if (!showSearch) {
		return <div className="max-h-80 overflow-y-auto">{body}</div>;
	}

	return (
		<div className="flex max-h-80 flex-col">
			<div className="sticky top-0 z-10 mb-1 bg-muted/90 pb-1 backdrop-blur-2xl">
				<div className="relative">
					<HugeiconsIcon
						className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
						icon={Search01Icon}
					/>
					<Input
						aria-label="Filter agents"
						className="h-7 border-transparent bg-transparent pl-7 text-[12px]"
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => e.stopPropagation()}
						placeholder="Search"
						spellCheck={false}
						value={query}
					/>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
		</div>
	);
}

export const ModeSelector = memo(function ModeSelector({
	modes,
	value,
	defaultValue,
	onChange,
	className,
}: ModeSelectorProps) {
	const isControlled = value !== undefined;
	const [internalValue, setInternalValue] = useState(defaultValue);
	const activeId = isControlled ? value : internalValue;
	const activeMode = modes.find((m) => m.id === activeId) ?? modes[0];
	const [open, setOpen] = useState(false);

	const handleSelect = useCallback(
		(id: string) => {
			if (!isControlled) {
				setInternalValue(id);
			}
			onChange?.(id);
			setOpen(false);
		},
		[isControlled, onChange]
	);

	if (modes.length === 0) {
		return null;
	}
	const ActiveIcon = activeMode?.icon;
	const hasMultiple = modes.length > 1;

	const triggerContent = (
		<>
			{ActiveIcon && <ActiveIcon className="size-3.5 shrink-0" />}
			<span className="font-medium">{activeMode?.label}</span>
			{hasMultiple && (
				<HugeiconsIcon
					className="text-muted-foreground"
					icon={ArrowDown01Icon}
					size={12}
				/>
			)}
		</>
	);

	if (!hasMultiple) {
		return (
			<div
				className={cn(
					"pointer-events-none inline-flex items-center",
					COMPOSER_SELECT_TRIGGER,
					className
				)}
			>
				{triggerContent}
			</div>
		);
	}

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<Button
						aria-label="Select mode"
						className={cn(COMPOSER_SELECT_TRIGGER, className)}
						size="sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				{triggerContent}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className={COMPOSER_SELECT_POPOVER}
				side="top"
				sideOffset={6}
			>
				<ModeMenuContent
					activeId={activeMode?.id}
					modes={modes}
					onSelect={handleSelect}
				/>
			</PopoverContent>
		</Popover>
	);
});
