"use client";

import "./universal-picker-body.module.css";

import {
	ArrowDown01Icon,
	Search01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { memo, useCallback, useMemo, useState } from "react";

import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { friendlyModelDisplay } from "@/src/lib/catalog/friendly.ts";
import type { ModelOption } from "../types.ts";

// Below this many models the picker stays a plain list; at or above it a sticky
// filter box appears so long model rosters stay navigable.
const SEARCH_THRESHOLD = 7;

export interface ModelPickerProps {
	className?: string;
	defaultValue?: string;
	models: ModelOption[];
	onChange?: (modelId: string) => void;
	placeholder?: string;
	value?: string;
}

export const ModelPicker = memo(function ModelPicker({
	models,
	value,
	defaultValue,
	onChange,
	placeholder = "Auto",
	className,
}: ModelPickerProps) {
	const isControlled = value !== undefined;
	const [internalValue, setInternalValue] = useState(defaultValue);
	const activeId = isControlled ? value : internalValue;
	const activeModel = models.find((m) => m.id === activeId) ?? models[0];
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const tl = useLiteralMessages();
	const [friendly] = useFriendlyMode();
	// Friendly mode cleans raw developer model names AND quant labels (reusing the
	// store's vocabulary, so a quant reads "Balanced (recommended)", never
	// "Q4_K_M") to match the rest of the app. Selection is by `id`, so the
	// friendlier text is purely cosmetic and never changes what's sent. The raw
	// original (plus the quant explanation) is kept for the hover `title`.
	const display = (name: string) => {
		if (!friendly) {
			return { name, label: name, tooltip: name };
		}
		const d = friendlyModelDisplay(name);
		return { name: d.name, label: d.label, tooltip: d.tooltip };
	};

	const normalizedQuery = query.trim().toLowerCase();
	const showSearch = models.length >= SEARCH_THRESHOLD;
	// Match on the raw id/name/version AND the friendly display text, so a search
	// works whichever vocabulary the user sees.
	const filteredModels = useMemo(() => {
		if (!normalizedQuery) {
			return models;
		}
		return models.filter((model) => {
			const d = friendly ? friendlyModelDisplay(model.name) : null;
			const hay =
				`${model.name} ${model.id} ${model.version ?? ""} ${d?.name ?? ""} ${d?.label ?? ""}`.toLowerCase();
			return hay.includes(normalizedQuery);
		});
	}, [models, normalizedQuery, friendly]);

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

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<Button
						appearance="composer-settings"
						aria-label="Select model"
						className={className}
						size="sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				<span
					className="font-medium"
					title={
						activeModel?.name ? display(activeModel.name).tooltip : undefined
					}
				>
					{activeModel?.name ? display(activeModel.name).name : placeholder}
				</span>
				{activeModel?.version && (
					<span className="font-normal text-muted-foreground/70">
						{activeModel.version}
					</span>
				)}
				<HugeiconsIcon
					className="text-muted-foreground"
					icon={ArrowDown01Icon}
					size={12}
				/>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				// `overflow-hidden` cancels the shared popover's scroller: the search
				// field below is sticky and the rows scroll in their own container, so
				// the popup itself must not scroll too (two nested scrollers read as a
				// list that will not move).
				className={cn(
					"flex max-h-80 w-auto min-w-[200px] max-w-[280px] flex-col overflow-hidden"
				)}
				data-desktop-picker-popover="true"
				side="top"
				sideOffset={6}
				spacing="small-inset"
			>
				{showSearch && (
					<div className="sticky top-0 z-10 mb-1">
						<div className="relative">
							<HugeiconsIcon
								className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
								icon={Search01Icon}
							/>
							<Input
								aria-label="Filter models"
								onChange={(e) => setQuery(e.target.value)}
								onKeyDown={(e) => e.stopPropagation()}
								placeholder="Search models"
								purpose="picker-filter"
								spellCheck={false}
								value={query}
							/>
						</div>
					</div>
				)}
				<div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
					{filteredModels.length === 0 ? (
						<p className="px-3 py-4 text-center text-muted-foreground text-xs">
							{tl("No models match “{query}”", { query: query.trim() })}
						</p>
					) : (
						filteredModels.map((model) => {
							const isActive = model.id === activeModel?.id;
							return (
								<Button
									appearance={
										isActive ? "composer-mode-active" : "composer-mode"
									}
									className="items-center"
									key={model.id}
									onClick={() => handleSelect(model.id)}
									type="button"
									variant="ghost"
								>
									<span
										className="flex-1 truncate"
										title={display(model.name).tooltip}
									>
										{display(model.name).label}
										{model.version && (
											<span className="ml-1 font-normal text-muted-foreground">
												{model.version}
											</span>
										)}
									</span>
									{isActive && (
										<HugeiconsIcon
											className="shrink-0 text-muted-foreground"
											icon={Tick02Icon}
											size={16}
											strokeWidth={2}
										/>
									)}
								</Button>
							);
						})
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
});

export interface ModelBadgeProps {
	className?: string;
	models: ModelOption[];
	placeholder?: string;
	value?: string;
}

export const ModelBadge = memo(function ModelBadge({
	models,
	value,
	placeholder = "Auto",
	className,
}: ModelBadgeProps) {
	const activeModel = models.find((m) => m.id === value) ?? models[0];
	return (
		<div
			className={cn(
				"inline-flex h-7 items-center px-2 text-foreground/30 text-xs leading-4",
				className
			)}
		>
			<span className="font-medium">{activeModel?.name ?? placeholder}</span>
			{activeModel?.version && (
				<span className="ml-0.5 font-normal text-foreground/20">
					{activeModel.version}
				</span>
			)}
		</div>
	);
});
