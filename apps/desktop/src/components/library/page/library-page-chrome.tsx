import { Add01Icon, ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { LibraryToolbar } from "@ryu/blocks/desktop/library.tsx";
import {
	StoreGlobalSearch,
	type StoreSectionTab,
	StoreSectionTabs,
} from "@ryu/blocks/desktop/store.tsx";
import type { LibraryViewMode } from "@ryu/blocks/desktop/view-toggle.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import type { LibraryItemType } from "@/src/lib/library.ts";
import {
	LIBRARY_ITEM_TYPES,
	type LibrarySection,
	SORT_OPTIONS,
	TYPE_META,
} from "./library-sections.ts";

/** The Library's inline page chrome: the library-wide search with the active
 *  collection's controls beside it, then the section tabs. */
export function LibraryPageChrome({
	active,
	cta,
	customSurface,
	mixedView,
	navSections,
	onViewChange,
	presentTypes,
	query,
	section,
	setActive,
	setQuery,
	setSort,
	setTypeFilter,
	showCollectionToolbar,
	showShowcase,
	sort,
	typeFilter,
	view,
}: {
	active: string;
	cta: { label: string; onCta: () => void } | null;
	customSurface: boolean;
	mixedView: boolean;
	navSections: StoreSectionTab[];
	onViewChange: (view: LibraryViewMode) => void;
	presentTypes: ReadonlySet<LibraryItemType>;
	query: string;
	section: LibrarySection;
	setActive: (value: string) => void;
	setQuery: (query: string) => void;
	setSort: (sort: string) => void;
	setTypeFilter: (type: LibraryItemType | null) => void;
	showCollectionToolbar: boolean;
	showShowcase: boolean;
	sort: string;
	typeFilter: LibraryItemType | null;
	view: LibraryViewMode;
}) {
	return (
		<div className="mx-auto w-full max-w-4xl shrink-0 px-4 pt-4">
			{customSurface ? null : (
				<StoreGlobalSearch
					onChange={setQuery}
					placeholder="Search your library…"
					trailing={
						showCollectionToolbar ? (
							<LibraryToolbar
								className="shrink-0 p-0"
								ctaIcon={cta ? Add01Icon : undefined}
								ctaLabel={cta?.label}
								filterSlot={
									mixedView ? (
										<LibraryTypeFilter
											presentTypes={presentTypes}
											setTypeFilter={setTypeFilter}
											typeFilter={typeFilter}
										/>
									) : undefined
								}
								onCta={cta?.onCta}
								onSortChange={setSort}
								onViewChange={onViewChange}
								showGraph={section === "skills"}
								showSearch={false}
								showShowcase={showShowcase}
								sort={section === "recents" ? undefined : sort}
								sortOptions={section === "recents" ? [] : SORT_OPTIONS}
								view={view}
							/>
						) : null
					}
					value={query}
				/>
			)}
			<StoreSectionTabs
				active={active}
				inset="library-sections"
				onSelect={setActive}
				sections={navSections}
			/>
		</div>
	);
}

/** The mixed views' type filter: one quiet dropdown, shown only when the view
 *  actually holds two or more types, or while a type filter is still applied
 *  (so a filter whose other types disappeared can always be cleared). */
function LibraryTypeFilter({
	presentTypes,
	setTypeFilter,
	typeFilter,
}: {
	presentTypes: ReadonlySet<LibraryItemType>;
	setTypeFilter: (type: LibraryItemType | null) => void;
	typeFilter: LibraryItemType | null;
}) {
	const tl = useLiteralMessages();
	const types = LIBRARY_ITEM_TYPES.filter(
		(type) => presentTypes.has(type) || type === typeFilter
	);
	if (types.length < 2 && typeFilter === null) {
		return null;
	}
	const current = typeFilter ? TYPE_META[typeFilter].label : "All types";
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={tl("Filter by type: {typeLabel}", {
							typeLabel: current,
						})}
						size="sm"
						variant={typeFilter ? "secondary" : "ghost"}
					>
						{current}
						<HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
					</Button>
				}
			/>
			<DropdownMenuContent align="end" className="min-w-44">
				<DropdownMenuRadioGroup
					onValueChange={(value) => {
						const next = types.find((type) => type === value);
						setTypeFilter(next ?? null);
					}}
					value={typeFilter ?? "all"}
				>
					<DropdownMenuRadioItem value="all">All types</DropdownMenuRadioItem>
					{types.map((type) => (
						<DropdownMenuRadioItem key={type} value={type}>
							<HugeiconsIcon className="size-4" icon={TYPE_META[type].icon} />
							{TYPE_META[type].label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
