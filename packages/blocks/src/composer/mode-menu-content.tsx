"use client";

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type { ComponentType } from "react";
import { COMPOSER_SELECT_ITEM } from "./composer-select.ts";

export interface ModeOption {
	description?: string;
	group?: string;
	icon?: ComponentType<{ className?: string }>;
	id: string;
	label: string;
}

export function ModeMenuContent({
	modes,
	activeId,
	onSelect,
}: {
	modes: ModeOption[];
	activeId?: string;
	onSelect: (modeId: string) => void;
}) {
	const groups: { label: string | null; items: ModeOption[] }[] = [];
	for (const mode of modes) {
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
				{Icon ? <Icon className="mt-0.5 size-4 shrink-0" /> : null}
				<span className="min-w-0 flex-1">
					<span className="block truncate">{mode.label}</span>
					{mode.description ? (
						<span className="block truncate font-normal text-muted-foreground text-sm">
							{mode.description}
						</span>
					) : null}
				</span>
				{isActive ? (
					<HugeiconsIcon
						className="mt-0.5 shrink-0 text-muted-foreground"
						icon={Tick02Icon}
						size={16}
						strokeWidth={2}
					/>
				) : null}
			</Button>
		);
	};

	if (!hasGroups) {
		return <>{modes.map(renderRow)}</>;
	}
	return (
		<>
			{groups.map((group) => (
				<div key={group.label ?? "__ungrouped__"}>
					{group.label ? (
						<div className="px-3 pt-2 pb-1 font-medium text-[11px] text-muted-foreground">
							{group.label}
						</div>
					) : null}
					{group.items.map(renderRow)}
				</div>
			))}
		</>
	);
}
