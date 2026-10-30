import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	type ActiveChip,
	FilterChipBar,
	TAG_ICON,
	tokenIcon,
} from "./chrome/catalog-badges.tsx";
import { CATALOG_TOKENS } from "./friendly.ts";
import {
	FORMAT_OPTIONS,
	formatCount,
	SORT_OPTIONS,
} from "./models-catalog-section-format.ts";
import {
	MODEL_CATEGORY_OPTIONS,
	type ModelCatalogSource,
	type ModelCategory,
	type ModelFormat,
	type ModelSort,
} from "./types.ts";

/**
 * Multi-select "Filter by tag" dropdown. Each checked token narrows the list
 * with AND logic (a model must carry every selected tag). Mirrors the clickable
 * token badges — both drive the same `activeTokens` set.
 */
function TagFilterDropdown({
	activeTokens,
	toggleToken,
}: {
	activeTokens: Set<string>;
	toggleToken: (id: string) => void;
}) {
	const count = activeTokens.size;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button size="sm" variant={count > 0 ? "secondary" : "ghost"}>
						<HugeiconsIcon className="size-4" icon={TAG_ICON} />
						Tags
						{count > 0 && (
							<Badge className="ml-1" size="download-label" variant="secondary">
								{formatCount(count)}
							</Badge>
						)}
					</Button>
				}
			/>
			<DropdownMenuContent
				align="start"
				className="max-h-80 w-60 overflow-auto"
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>Filter by tag (matches all)</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				{CATALOG_TOKENS.map((t) => (
					<DropdownMenuCheckboxItem
						checked={activeTokens.has(t.id)}
						closeOnClick={false}
						key={t.id}
						onCheckedChange={() => toggleToken(t.id)}
					>
						<HugeiconsIcon className="size-4" icon={tokenIcon(t.id)} />
						{t.label}
					</DropdownMenuCheckboxItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Bottom-nav filter panel: category + sort + friendly/installed switches + chips.
 *  The search box itself lives directly in the bar (see the section's
 *  useStoreToolbar call); this is the "Filters" region that morphs above it. */
export interface ModelsFilterPanelProps {
	activeSource: string;
	activeTokens: Set<string>;
	category: ModelCategory;
	chips: ActiveChip[];
	format: ModelFormat;
	friendly: boolean;
	installedOnly: boolean;
	selectingSource: boolean;
	selectSource: (id: string) => void;
	setCategory: (c: ModelCategory) => void;
	setFormat: (f: ModelFormat) => void;
	setFriendly: (v: boolean) => void;
	setInstalledOnly: (v: boolean) => void;
	setShowTags: (v: boolean) => void;
	setSort: (s: ModelSort) => void;
	showInstalledOnly: boolean;
	showTags: boolean;
	sort: ModelSort;
	sources: ModelCatalogSource[];
	toggleToken: (id: string) => void;
}

export function ModelsFilterPanel({
	category,
	setCategory,
	sort,
	setSort,
	format,
	setFormat,
	friendly,
	setFriendly,
	installedOnly,
	setInstalledOnly,
	showInstalledOnly,
	chips,
	sources,
	activeSource,
	selectSource,
	selectingSource,
	activeTokens,
	toggleToken,
	showTags,
	setShowTags,
}: ModelsFilterPanelProps) {
	// Only worth a picker when there's a real choice. The {value,label} items
	// prop is required so Base UI's SelectValue renders the friendly name.
	const sourceItems = sources.map((s) => ({
		value: s.id,
		label: s.displayName,
	}));
	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					{/* Catalog source (Hugging Face by default). Only shown when there's
					    more than one source to pick from. */}
					{sources.length > 1 && (
						<Select
							disabled={selectingSource}
							items={sourceItems}
							onValueChange={(value) => {
								if (value) {
									selectSource(value);
								}
							}}
							value={activeSource}
						>
							<SelectTrigger className="h-8 w-[150px]" size="sm">
								<SelectValue placeholder="Source" />
							</SelectTrigger>
							<SelectContent>
								{sourceItems.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					{/* Category narrows by Hugging Face task. Local models carry no
					    task metadata, so it's disabled in the installed-only view. */}
					<Select<ModelCategory>
						disabled={installedOnly}
						items={MODEL_CATEGORY_OPTIONS}
						onValueChange={(v) => setCategory(v)}
						value={category}
					>
						<SelectTrigger className="h-8 w-[160px]" size="sm">
							<SelectValue placeholder="All categories" />
						</SelectTrigger>
						<SelectContent searchable searchPlaceholder="Filter model types…">
							{MODEL_CATEGORY_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{/* Weight-format facet — picks which engine family's models the
					    catalog lists. Incompatible models still appear, annotated. */}
					<Select<ModelFormat>
						items={FORMAT_OPTIONS}
						onValueChange={(v) => v && setFormat(v)}
						value={format}
					>
						<SelectTrigger className="h-8 w-[170px]" size="sm">
							<SelectValue placeholder="Format" />
						</SelectTrigger>
						<SelectContent>
							{FORMAT_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select<ModelSort>
						items={SORT_OPTIONS}
						onValueChange={(v) => v && setSort(v)}
						value={sort}
					>
						<SelectTrigger className="h-8 w-[140px]" size="sm">
							<SelectValue placeholder="Sort" />
						</SelectTrigger>
						<SelectContent>
							{SORT_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<TagFilterDropdown
						activeTokens={activeTokens}
						toggleToken={toggleToken}
					/>
				</div>
				<div className="flex items-center gap-4 text-sm">
					<div className="flex items-center gap-2">
						<Switch
							aria-label="Friendly names and badges"
							checked={friendly}
							id="friendly-models"
							onCheckedChange={setFriendly}
						/>
						<label className="cursor-pointer" htmlFor="friendly-models">
							Friendly names
						</label>
					</div>
					<div className="flex items-center gap-2">
						<Switch
							aria-label="Show Hugging Face tags in the list"
							checked={showTags}
							id="show-tags"
							onCheckedChange={setShowTags}
						/>
						<label className="cursor-pointer" htmlFor="show-tags">
							Show tags
						</label>
					</div>
					{showInstalledOnly ? (
						<div className="flex items-center gap-2">
							<Switch
								aria-label="Show only installed models"
								checked={installedOnly}
								id="installed-only"
								onCheckedChange={setInstalledOnly}
							/>
							<label className="cursor-pointer" htmlFor="installed-only">
								Added only
							</label>
						</div>
					) : null}
				</div>
			</div>
			<FilterChipBar chips={chips} />
		</div>
	);
}
