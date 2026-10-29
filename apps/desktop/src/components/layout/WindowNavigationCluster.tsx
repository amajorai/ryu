import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCompactRail } from "@/src/hooks/useCompactRail.ts";
import {
	IconSidebarClosed,
	IconSidebarOpen,
} from "../icons/SidebarToggleIcon.tsx";
import { CompactRailMenuItem } from "./appearance-context-menu.tsx";
import { CompactRail } from "./CompactRail.tsx";

interface WindowNavigationClusterProps {
	canGoBack: boolean;
	canGoForward: boolean;
	isMac: boolean;
	isMobile: boolean;
	navClusterPosition: string;
	onGoBack: () => void;
	onGoForward: () => void;
	onSearch: () => void;
	onToggleSidebar: () => void;
	showSearch?: boolean;
	sidebarShown: boolean;
}

export function WindowNavigationCluster({
	canGoBack,
	canGoForward,
	isMac,
	isMobile,
	navClusterPosition,
	onGoBack,
	onGoForward,
	onSearch,
	showSearch = true,
	onToggleSidebar,
	sidebarShown,
}: WindowNavigationClusterProps) {
	const { t } = useI18n();
	// At narrow widths the collapsed navigation becomes the agent rail, which
	// carries its own way back to the full sidebar (and search), so this
	// cluster's corner belongs to the rail.
	const compactRail = useCompactRail(sidebarShown);
	const backLabel = t("shell.go-back", undefined, "Go back");
	const forwardLabel = t("shell.go-forward", undefined, "Go forward");
	const navigationLabel = sidebarShown
		? t("shell.close-navigation", undefined, "Close navigation")
		: t("shell.open-navigation", undefined, "Open navigation");
	const sidebarLabel = sidebarShown
		? t("shell.hide-sidebar", undefined, "Hide sidebar")
		: t("shell.show-sidebar", undefined, "Show sidebar");
	const searchLabel = t("shell.search", undefined, "Search");
	const searchShortcutLabel = t(
		"shell.search-shortcut",
		{ shortcut: isMac ? "⌘K" : "Ctrl K" },
		`Search ${isMac ? "⌘K" : "Ctrl K"}`
	);
	if (compactRail) {
		return (
			<CompactRail
				isMac={isMac}
				onOpenNavigation={onToggleSidebar}
				onSearch={onSearch}
				showSearch={showSearch}
			/>
		);
	}
	return (
		<ContextMenu>
			{/* The rail switch lives here too: with the rail off, this cluster is
			    what shows in its place, and Bot has no sidebar menu to offer it. */}
			<ContextMenuTrigger
				render={
					<div
						className={cn(
							"fixed z-[60] flex flex-row items-center gap-1",
							navClusterPosition
						)}
						data-tauri-drag-region={false}
						data-testid="window-navigation-cluster"
					/>
				}
			>
				{!isMobile && (
					<>
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										aria-label={backLabel}
										className="size-8"
										disabled={!canGoBack}
										onClick={onGoBack}
										size="icon"
										variant="ghost"
									>
										<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
									</Button>
								}
							/>
							<TooltipContent>{backLabel}</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										aria-label={forwardLabel}
										className="size-8"
										disabled={!canGoForward}
										onClick={onGoForward}
										size="icon"
										variant="ghost"
									>
										<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
									</Button>
								}
							/>
							<TooltipContent>{forwardLabel}</TooltipContent>
						</Tooltip>
					</>
				)}
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label={navigationLabel}
								className="size-8"
								onClick={onToggleSidebar}
								size="icon"
								variant="ghost"
							>
								{sidebarShown ? (
									<IconSidebarOpen className="size-4" />
								) : (
									<IconSidebarClosed className="size-4" />
								)}
							</Button>
						}
					/>
					<TooltipContent>{sidebarLabel}</TooltipContent>
				</Tooltip>
				{showSearch && (
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									aria-label={searchLabel}
									className="size-8"
									onClick={onSearch}
									size="icon"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={Search01Icon} />
								</Button>
							}
						/>
						<TooltipContent>{searchShortcutLabel}</TooltipContent>
					</Tooltip>
				)}
			</ContextMenuTrigger>
			<ContextMenuContent>
				<CompactRailMenuItem />
			</ContextMenuContent>
		</ContextMenu>
	);
}
