"use client";

import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { Spinner } from "@ryu/ui/components/spinner";
import { useMemo, useState } from "react";
import type { PiModelOption } from "./agent-edit-pi-config.tsx";

function sortPiModelGroups(
	groups: { label: string | null; items: PiModelOption[] }[]
): { label: string | null; items: PiModelOption[] }[] {
	const rank = (label: string | null): number => (label === "Local" ? 0 : 1);
	return [...groups].sort((a, b) => {
		const ra = rank(a.label);
		const rb = rank(b.label);
		if (ra !== rb) {
			return ra - rb;
		}
		return (a.label ?? "").localeCompare(b.label ?? "");
	});
}

export function PiModelPicker({
	id,
	options,
	value,
	onValueChange,
	loading,
}: {
	id: string;
	options: PiModelOption[];
	value: string;
	onValueChange?: (v: string) => void;
	loading?: boolean;
}) {
	const tl = useLiteralMessages();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const normalizedQuery = query.trim().toLowerCase();

	const groups = useMemo(() => {
		const filtered = normalizedQuery
			? options.filter((model) => {
					const hay =
						`${model.name} ${model.id} ${model.group ?? ""}`.toLowerCase();
					return hay.includes(normalizedQuery);
				})
			: options;

		const grouped: { label: string | null; items: PiModelOption[] }[] = [];
		for (const model of filtered) {
			const label = model.group ?? null;
			const existing = grouped.find((g) => g.label === label);
			if (existing) {
				existing.items.push(model);
			} else {
				grouped.push({ label, items: [model] });
			}
		}
		return sortPiModelGroups(grouped);
	}, [options, normalizedQuery]);

	const hasGroups = groups.some((g) => g.label !== null);
	const selectedLabel =
		options.find((o) => o.id === value)?.name ?? value ?? "Pick a model";

	const renderRow = (model: PiModelOption) => {
		const isActive = model.id === value;
		return (
			<Button
				appearance="agent-model-option"
				key={model.id}
				onClick={() => {
					onValueChange?.(model.id);
					setOpen(false);
					setQuery("");
				}}
				type="button"
				variant={isActive ? "secondary" : "ghost"}
			>
				<span className="flex w-full items-center gap-2">
					<span className="flex-1 truncate" title={model.name}>
						{model.name}
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
			</Button>
		);
	};

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<Button
						appearance="agent-model-picker"
						aria-labelledby={id}
						id={id}
						type="button"
						variant="outline"
					>
						<span className="truncate">{selectedLabel}</span>
						<HugeiconsIcon
							className="shrink-0 opacity-50"
							icon={ArrowDown01Icon}
							size={16}
						/>
					</Button>
				}
			/>
			<PopoverContent
				align="start"
				className="w-[min(300px,var(--available-width))]"
				spacing="flush"
			>
				<div className="flex max-h-80 flex-col">
					<div className="sticky top-0 z-10">
						<Input
							aria-label="Filter models"
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search models…"
							size="agent-detail"
							value={query}
						/>
					</div>
					<div className="scroll-fade min-h-0 flex-1 overflow-y-auto p-1">
						{loading ? (
							<p className="flex items-center gap-2 px-3 py-4 text-muted-foreground text-xs">
								<Spinner className="size-3" /> Loading models…
							</p>
						) : null}
						{!loading && groups.length === 0 ? (
							<p className="px-3 py-4 text-center text-muted-foreground text-xs">
								{tl("No models match “{query}”", { query: query.trim() })}
							</p>
						) : null}
						{loading || hasGroups
							? groups.map((group) => (
									<div key={group.label ?? "__ungrouped__"}>
										{group.label ? (
											<div className="type-caption px-3 pt-2 pb-1 font-medium text-muted-foreground">
												{group.label}
											</div>
										) : null}
										{group.items.map(renderRow)}
									</div>
								))
							: groups.flatMap((g) => g.items).map(renderRow)}
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
