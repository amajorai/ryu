// The palette's result-type filters: a short row of plain chips (no icons) and
// a "More" menu for every other lane, so the row never runs past the dialog.

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CommandPaletteTab } from "./types.ts";

/** The lanes shown as chips when the host does not choose its own. */
export const DEFAULT_PRIMARY_TAB_IDS = ["all", "chats", "apps", "settings"];
/** How many chips show before the rest move into "More". */
const MAX_PRIMARY_TABS = 4;

/** Split the host's lanes into visible chips and the "More" overflow. */
export function splitPaletteTabs(
	tabs: CommandPaletteTab[],
	primaryTabIds: string[] = DEFAULT_PRIMARY_TAB_IDS
): { overflow: CommandPaletteTab[]; primary: CommandPaletteTab[] } {
	// Preferred lanes first, topped up in host order, so a host with only a few
	// lanes still shows all of them as chips.
	const preferred = tabs.filter((tab) => primaryTabIds.includes(tab.id));
	const rest = tabs.filter((tab) => !preferred.includes(tab));
	const primary = [...preferred, ...rest]
		.slice(0, MAX_PRIMARY_TABS)
		.sort((a, b) => tabs.indexOf(a) - tabs.indexOf(b));
	const overflow = tabs.filter((tab) => !primary.includes(tab));
	return { overflow, primary };
}

function chipClass(active: boolean) {
	return cn(
		"h-auto shrink-0 rounded-full px-2 py-1 font-normal text-xs transition-colors duration-150 hover:duration-0",
		active
			? "bg-muted text-foreground hover:bg-muted"
			: "text-muted-foreground hover:bg-muted hover:text-foreground"
	);
}

export function PaletteFilters({
	onTabChange,
	primaryTabIds,
	selectedTab,
	tabs,
}: {
	onTabChange?: (tabId: string) => void;
	primaryTabIds?: string[];
	selectedTab: string | undefined;
	tabs: CommandPaletteTab[];
}) {
	const moreLabel = useLocalizedString("More");
	const groupLabel = useLocalizedString("Search result types");
	const { overflow, primary } = splitPaletteTabs(tabs, primaryTabIds);
	const activeOverflow = overflow.find((tab) => tab.id === selectedTab);

	return (
		<div
			className="flex min-w-0 items-center gap-1 overflow-hidden px-2 py-2"
			data-slot="command-palette-filters"
		>
			<Tabs
				className="min-w-0 shrink"
				onValueChange={(value) => onTabChange?.(String(value))}
				value={primary.some((tab) => tab.id === selectedTab) ? selectedTab : ""}
			>
				<TabsList
					aria-label={groupLabel}
					className="flex-nowrap"
					persistLayout={false}
					variant="muted-pills"
				>
					{primary.map((tab) => (
						<TabsTrigger className="shrink-0" key={tab.id} value={tab.id}>
							{tab.label}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			{overflow.length > 0 ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								aria-pressed={activeOverflow !== undefined}
								className={cn(chipClass(activeOverflow !== undefined), "gap-1")}
								size="sm"
								type="button"
								variant="ghost"
							>
								{activeOverflow?.label ?? moreLabel}
								<HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
							</Button>
						}
					/>
					<DropdownMenuContent align="start" className="max-h-80">
						<DropdownMenuRadioGroup
							onValueChange={(value) => onTabChange?.(String(value))}
							value={activeOverflow?.id ?? ""}
						>
							{overflow.map((tab) => (
								<DropdownMenuRadioItem key={tab.id} value={tab.id}>
									{tab.label}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</div>
	);
}
