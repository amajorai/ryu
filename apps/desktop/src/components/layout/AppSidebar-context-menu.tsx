import {
	ArchiveRestoreIcon,
	ArrowDown01Icon,
	ArrowUp01Icon,
	SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import {
	ContextMenuContent,
	ContextMenuSeparator,
} from "@ryu/ui/components/context-menu.tsx";
import {
	setAgentRowStyle,
	useAgentRowStylePref,
} from "@/src/hooks/useAgentRowStyle.ts";
import { useChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { useSidebarChatPreview } from "@/src/hooks/useSidebarChatPreview.ts";
import { useSidebarGroupedNav } from "@/src/hooks/useSidebarGroupedNav.ts";
import {
	sidebarModeSchema,
	type useSidebarMode,
} from "@/src/hooks/useSidebarMode.ts";
import type { useSidebarModes } from "@/src/hooks/useSidebarModes.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { setTabLayout, useTabLayout } from "@/src/hooks/useTabLayout.ts";
import {
	ContextMenuSectionHeading,
	SIDEBAR_OVERFLOW_POPOVER_KEY,
	SidebarListAppearanceMenuItems,
	TabLayoutMenuItems,
} from "./appearance-context-menu.tsx";
import {
	CheckedContextMenuItem,
	SidebarContextMenuItem,
} from "./sidebar-chrome-buttons.tsx";
import type { SidebarModeDescriptor } from "./sidebar-modes.ts";

/** The sidebar-wide menu opened by right-clicking the sidebar background:
 *  mode, style, list appearance, tab layout, and section/customize actions. */
export function SidebarRootContextMenuContent({
	activeMode,
	handleCollapseAll,
	handleExpandAll,
	handleResetSidebar,
	setCustomizeOpen,
	setSidebarMode,
	sidebarModes,
}: {
	activeMode: SidebarModeDescriptor;
	handleCollapseAll: () => void;
	handleExpandAll: () => void;
	handleResetSidebar: () => void;
	setCustomizeOpen: (open: boolean) => void;
	setSidebarMode: ReturnType<typeof useSidebarMode>[1];
	sidebarModes: ReturnType<typeof useSidebarModes>["modes"];
}) {
	const tabLayout = useTabLayout();
	const [sidebarVariant, setSidebarVariant] = useSidebarVariant();
	const [groupByDate, setGroupByDate] = useChatDateGrouping();
	const [groupedNav, setGroupedNav] = useSidebarGroupedNav();
	const [showSidebarChatPreview, setShowSidebarChatPreview] =
		useSidebarChatPreview();
	const [sidebarOverflowPopover, setSidebarOverflowPopover] =
		usePersistedToggle(SIDEBAR_OVERFLOW_POPOVER_KEY, false);
	const agentRowStyle = useAgentRowStylePref();
	return (
		<ContextMenuContent>
			<ContextMenuSectionHeading>Sidebar mode</ContextMenuSectionHeading>
			{/* One row per mode on offer, built-in and contributed alike — the
					    menu has no idea which is which, which is the point. */}
			{sidebarModes.map((mode) => (
				<CheckedContextMenuItem
					checked={activeMode.key === mode.key}
					key={mode.key}
					onClick={() => setSidebarMode(sidebarModeSchema.parse(mode.key))}
				>
					{mode.title}
				</CheckedContextMenuItem>
			))}
			<ContextMenuSeparator />
			<ContextMenuSectionHeading>Sidebar style</ContextMenuSectionHeading>
			<CheckedContextMenuItem
				checked={sidebarVariant === "floating"}
				onClick={() => setSidebarVariant("floating")}
			>
				Floating
			</CheckedContextMenuItem>
			<CheckedContextMenuItem
				checked={sidebarVariant === "inset"}
				onClick={() => setSidebarVariant("inset")}
			>
				Inset
			</CheckedContextMenuItem>
			<ContextMenuSeparator />
			<SidebarListAppearanceMenuItems
				activeModeKey={activeMode.key}
				agentRowStyle={agentRowStyle}
				groupByDate={groupByDate}
				groupedNav={groupedNav}
				setAgentRowStyle={setAgentRowStyle}
				setGroupByDate={setGroupByDate}
				setGroupedNav={setGroupedNav}
				setShowSidebarChatPreview={setShowSidebarChatPreview}
				setSidebarOverflowPopover={setSidebarOverflowPopover}
				showSidebarChatPreview={showSidebarChatPreview}
				sidebarOverflowPopover={sidebarOverflowPopover}
			/>
			<ContextMenuSeparator />
			<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
			<ContextMenuSeparator />
			<ContextMenuSectionHeading>Sections</ContextMenuSectionHeading>
			<SidebarContextMenuItem icon={ArrowDown01Icon} onClick={handleExpandAll}>
				Expand all sections
			</SidebarContextMenuItem>
			<SidebarContextMenuItem icon={ArrowUp01Icon} onClick={handleCollapseAll}>
				Collapse all sections
			</SidebarContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuSectionHeading>Customize</ContextMenuSectionHeading>
			<SidebarContextMenuItem
				icon={SlidersHorizontalIcon}
				onClick={() => setCustomizeOpen(true)}
			>
				Customize sidebar
			</SidebarContextMenuItem>
			<SidebarContextMenuItem
				icon={ArchiveRestoreIcon}
				onClick={handleResetSidebar}
			>
				Reset sidebar layout
			</SidebarContextMenuItem>
		</ContextMenuContent>
	);
}
