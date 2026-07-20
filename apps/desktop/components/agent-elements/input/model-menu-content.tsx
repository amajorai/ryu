"use client";

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { cn } from "@ryu/ui/lib/utils";
import { useMemo, useState } from "react";
import { COMPOSER_SELECT_ITEM } from "@/components/agent-elements/input/composer-select.ts";
import {
	type ModelMenuOption,
	sortModelGroups,
} from "@/components/agent-elements/input/model-groups.ts";

export function ModelMenuContent({
	models,
	activeId,
	onSelect,
}: {
	models: ModelMenuOption[];
	activeId?: string;
	onSelect: (modelId: string) => void;
}) {
	const [query, setQuery] = useState("");
	const normalizedQuery = query.trim().toLowerCase();

	const groups = useMemo(() => {
		const filtered = normalizedQuery
			? models.filter((model) => {
					const hay =
						`${model.name} ${model.id} ${model.description ?? ""} ${model.group ?? ""}`.toLowerCase();
					return hay.includes(normalizedQuery);
				})
			: models;

		const grouped: { label: string | null; items: ModelMenuOption[] }[] = [];
		for (const model of filtered) {
			const label = model.group ?? null;
			const existing = grouped.find((g) => g.label === label);
			if (existing) {
				existing.items.push(model);
			} else {
				grouped.push({ label, items: [model] });
			}
		}
		return sortModelGroups(grouped);
	}, [models, normalizedQuery]);

	const hasGroups = groups.some((g) => g.label !== null);

	const renderRow = (model: ModelMenuOption) => {
		const isActive = model.id === activeId;
		return (
			<Button
				className={cn(
					COMPOSER_SELECT_ITEM,
					"flex-col items-start gap-0.5",
					isActive && "bg-accent"
				)}
				key={model.id}
				onClick={() => onSelect(model.id)}
				type="button"
				variant="ghost"
			>
				<span className="flex w-full items-center gap-2.5">
					<span className="flex-1 truncate">{model.name}</span>
					{isActive ? (
						<HugeiconsIcon
							className="shrink-0 text-muted-foreground"
							icon={Tick02Icon}
							size={16}
							strokeWidth={2}
						/>
					) : null}
				</span>
				{model.description ? (
					<span className="w-full truncate text-left font-normal text-muted-foreground text-xs">
						{model.description}
					</span>
				) : null}
			</Button>
		);
	};

	return (
		<div className="flex max-h-80 flex-col">
			<div className="sticky top-0 z-10 border-border/60 border-b bg-popover p-2">
				<Input
					aria-label="Filter models"
					className="h-8 text-[13px]"
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search models…"
					value={query}
				/>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-1">
				{groups.length === 0 ? (
					<p className="px-3 py-4 text-center text-muted-foreground text-xs">
						No models match &ldquo;{query.trim()}&rdquo;
					</p>
				) : null}
				{hasGroups
					? groups.map((group) => (
							<div key={group.label ?? "__ungrouped__"}>
								{group.label ? (
									<div className="px-3 pt-2 pb-1 font-medium text-[11px] text-muted-foreground">
										{group.label}
									</div>
								) : null}
								{group.items.map(renderRow)}
							</div>
						))
					: filteredFlat(groups).map(renderRow)}
			</div>
		</div>
	);
}

export function createModelMenuRenderer(
	models: ModelMenuOption[],
	activeId?: string
) {
	return (onSelect: (id: string) => void) => (
		<ModelMenuContent activeId={activeId} models={models} onSelect={onSelect} />
	);
}

function filteredFlat(
	groups: { label: string | null; items: ModelMenuOption[] }[]
): ModelMenuOption[] {
	return groups.flatMap((g) => g.items);
}
