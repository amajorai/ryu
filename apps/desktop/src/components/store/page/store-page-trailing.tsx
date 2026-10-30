import {
	Download01Icon,
	HelpCircleIcon,
	Key01Icon,
	MoreHorizontalIcon,
	Package01Icon,
	SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ViewMode, ViewToggle } from "@ryu/blocks/desktop/view-toggle.tsx";
import MarketplaceHelpDialog from "@ryu/marketplace/catalog/chrome/marketplace-help-dialog";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { type Dispatch, type SetStateAction, useState } from "react";
import type { StoreToolbarConfig } from "@/src/components/store/storeToolbar.tsx";
import { storeShowcaseSupported } from "./store-sections.ts";

/** The Store chrome's trailing actions beside the search: the view toggle, the
 *  active section's filter panel (only when it publishes one), the Installed
 *  switch, and one `⋯` menu holding the private-package actions and Help. */
export function StorePageTrailingActions({
	installedOnly,
	onOpenPrivateInstall,
	onOpenPrivateShare,
	section,
	sectionFilters,
	setInstalledOnly,
	setStoredStoreView,
	showStoreView,
	storeView,
}: {
	installedOnly: boolean;
	onOpenPrivateInstall: () => void;
	onOpenPrivateShare: () => void;
	section: string;
	sectionFilters: StoreToolbarConfig | null;
	setInstalledOnly: Dispatch<SetStateAction<boolean>>;
	setStoredStoreView: (mode: ViewMode) => void;
	showStoreView: boolean;
	storeView: ViewMode;
}) {
	const [helpOpen, setHelpOpen] = useState(false);
	return (
		<>
			{showStoreView ? (
				<ViewToggle
					onChange={setStoredStoreView}
					showShowcase={storeShowcaseSupported(section)}
					value={storeView}
				/>
			) : null}
			{sectionFilters?.panel ? (
				<Popover>
					<PopoverTrigger
						render={
							<Button size="sm" variant="ghost">
								<HugeiconsIcon
									className="size-4"
									icon={sectionFilters.panelIcon ?? SlidersHorizontalIcon}
								/>
								{sectionFilters.panelLabel ?? "Filters"}
							</Button>
						}
					/>
					<PopoverContent
						align="end"
						className="w-[min(30rem,90vw)]"
						spacing="flush"
					>
						{sectionFilters.panel}
					</PopoverContent>
				</Popover>
			) : null}
			{section === "marketplaces" ? null : (
				<Button
					aria-pressed={installedOnly}
					onClick={() => setInstalledOnly((on) => !on)}
					size="sm"
					variant={installedOnly ? "secondary" : "ghost"}
				>
					<HugeiconsIcon className="size-4" icon={Download01Icon} />
					Installed
				</Button>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							aria-label="More store actions"
							size="icon-sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
						</Button>
					}
				/>
				<DropdownMenuContent align="end" className="min-w-52">
					<DropdownMenuItem onClick={onOpenPrivateInstall}>
						<HugeiconsIcon className="size-4" icon={Package01Icon} />
						Install from code
					</DropdownMenuItem>
					<DropdownMenuItem onClick={onOpenPrivateShare}>
						<HugeiconsIcon className="size-4" icon={Key01Icon} />
						Share package
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => setHelpOpen(true)}>
						<HugeiconsIcon className="size-4" icon={HelpCircleIcon} />
						About apps and plugins
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<MarketplaceHelpDialog
				onOpenChange={setHelpOpen}
				open={helpOpen}
				showTrigger={false}
			/>
		</>
	);
}
