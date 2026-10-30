import { FilterHorizontalIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import type { ChangeEvent } from "react";
import {
	MEMORY_CATEGORIES,
	MEMORY_SCOPES,
	type MemoryCategory,
	type MemoryScope,
} from "@/src/lib/api/memory.ts";
import {
	ALL,
	categoryFilterItems,
	scopeFilterItems,
} from "./MemoryLibraryParts.tsx";

/** The Memory library's search field and one Filters popover holding the scope,
 *  category and tag filters. */
export function MemoryLibraryFilters({
	categoryFilter,
	categoryLabels,
	presentTags,
	query,
	scopeFilter,
	scopeLabels,
	setCategoryFilter,
	setQuery,
	setScopeFilter,
	setTagFilter,
	tagFilter,
	tagFilterItems,
}: {
	categoryFilter: MemoryCategory | typeof ALL;
	categoryLabels: Record<MemoryCategory, string>;
	presentTags: string[];
	query: string;
	scopeFilter: MemoryScope | typeof ALL;
	scopeLabels: Record<MemoryScope, string>;
	setCategoryFilter: (value: MemoryCategory | typeof ALL) => void;
	setQuery: (value: string) => void;
	setScopeFilter: (value: MemoryScope | typeof ALL) => void;
	setTagFilter: (value: string) => void;
	tagFilter: string;
	tagFilterItems: { label: string; value: string }[];
}) {
	const activeCount = [scopeFilter, categoryFilter, tagFilter].filter(
		(value) => value !== ALL
	).length;
	return (
		<div className="flex items-center gap-2">
			<div className="relative min-w-48 flex-1">
				<HugeiconsIcon
					className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					icon={Search01Icon}
				/>
				<Input
					aria-label="Search memories"
					leadingAdornment="default"
					onChange={(e: ChangeEvent<HTMLInputElement>) =>
						setQuery(e.target.value)
					}
					placeholder="Search memories…"
					value={query}
				/>
			</div>
			<Popover>
				<PopoverTrigger
					render={
						<Button size="sm" variant={activeCount > 0 ? "secondary" : "ghost"}>
							<HugeiconsIcon className="size-4" icon={FilterHorizontalIcon} />
							Filters
							{activeCount > 0 ? (
								<span className="text-muted-foreground text-xs tabular-nums">
									{activeCount}
								</span>
							) : null}
						</Button>
					}
				/>
				<PopoverContent align="end" className="flex w-64 flex-col gap-2">
					<Select<MemoryScope | typeof ALL>
						items={scopeFilterItems(scopeLabels)}
						onValueChange={(v) => setScopeFilter(v)}
						value={scopeFilter}
					>
						<SelectTrigger aria-label="Filter by scope" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All scopes</SelectItem>
							{MEMORY_SCOPES.map((s) => (
								<SelectItem key={s} value={s}>
									{scopeLabels[s]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select<MemoryCategory | typeof ALL>
						items={categoryFilterItems(categoryLabels)}
						onValueChange={(v) => setCategoryFilter(v)}
						value={categoryFilter}
					>
						<SelectTrigger aria-label="Filter by category" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All categories</SelectItem>
							{MEMORY_CATEGORIES.map((c) => (
								<SelectItem key={c} value={c}>
									{categoryLabels[c]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{presentTags.length > 0 ? (
						<Select
							items={tagFilterItems}
							onValueChange={(v) => setTagFilter(v)}
							value={tagFilter}
						>
							<SelectTrigger aria-label="Filter by tag" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL}>All tags</SelectItem>
								{presentTags.map((tag) => (
									<SelectItem key={tag} value={tag}>
										#{tag}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : null}
				</PopoverContent>
			</Popover>
		</div>
	);
}
