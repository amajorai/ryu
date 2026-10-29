import {
	ContextMenuCheckboxItem,
	ContextMenuRadioGroup,
	ContextMenuRadioItem,
	ContextMenuSeparator,
} from "@ryu/ui/components/context-menu.tsx";
import type { ReactNode } from "react";
import type { AgentRowStyle } from "@/src/hooks/useAgentRowStyle.ts";
import { useCompactRailPreference } from "@/src/hooks/useCompactRail.ts";
import {
	TAB_LAYOUT_OPTIONS,
	type TabLayout,
} from "@/src/hooks/useTabLayout.ts";

/** Persisted key for the sidebar's searchable overflow presentation. */
export const SIDEBAR_OVERFLOW_POPOVER_KEY = "ryu:sidebar-overflow-popover";

export function ContextMenuSectionHeading({
	children,
}: {
	children: ReactNode;
}) {
	return (
		<div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
			{children}
		</div>
	);
}

export function TabLayoutMenuItems({
	onChange,
	value,
}: {
	onChange: (layout: TabLayout) => void;
	value: TabLayout;
}) {
	return (
		<>
			<ContextMenuSeparator />
			<ContextMenuSectionHeading>Tab view</ContextMenuSectionHeading>
			<ContextMenuRadioGroup
				onValueChange={(next) => {
					const option = TAB_LAYOUT_OPTIONS.find(
						(candidate) => candidate.value === next
					);
					if (option) {
						onChange(option.value);
					}
				}}
				value={value}
			>
				{TAB_LAYOUT_OPTIONS.map((option) => (
					<ContextMenuRadioItem key={option.value} value={option.value}>
						{option.label}
					</ContextMenuRadioItem>
				))}
			</ContextMenuRadioGroup>
		</>
	);
}

export function TabBarAppearanceMenuItems({
	floatingTabs,
	setFloatingTabs,
	setTabDropdownEnabled,
	setTabSearchButtonVisible,
	tabDropdownEnabled,
	tabSearchButtonVisible,
}: {
	floatingTabs: boolean;
	setFloatingTabs: (value: boolean) => void;
	setTabDropdownEnabled: (value: boolean) => void;
	setTabSearchButtonVisible: (value: boolean) => void;
	tabDropdownEnabled: boolean;
	tabSearchButtonVisible: boolean;
}) {
	return (
		<>
			<ContextMenuSeparator />
			<ContextMenuCheckboxItem
				checked={tabDropdownEnabled}
				onCheckedChange={setTabDropdownEnabled}
			>
				Show tabs as a dropdown
			</ContextMenuCheckboxItem>
			<ContextMenuCheckboxItem
				checked={tabSearchButtonVisible}
				disabled={tabDropdownEnabled}
				onCheckedChange={setTabSearchButtonVisible}
			>
				Show tab search button
			</ContextMenuCheckboxItem>
			<ContextMenuCheckboxItem
				checked={floatingTabs}
				onCheckedChange={setFloatingTabs}
			>
				Floating tab pills
			</ContextMenuCheckboxItem>
		</>
	);
}

export function SidebarListAppearanceMenuItems({
	activeModeKey,
	agentRowStyle,
	groupByDate,
	groupedNav,
	setAgentRowStyle,
	setGroupByDate,
	setGroupedNav,
	setShowSidebarChatPreview,
	setSidebarOverflowPopover,
	showSidebarChatPreview,
	sidebarOverflowPopover,
}: {
	activeModeKey: string;
	agentRowStyle: AgentRowStyle;
	groupByDate: boolean;
	groupedNav: boolean;
	setAgentRowStyle: (style: AgentRowStyle) => void;
	setGroupByDate: (value: boolean) => void;
	setGroupedNav: (value: boolean) => void;
	setShowSidebarChatPreview: (value: boolean) => void;
	setSidebarOverflowPopover: (value: boolean) => void;
	showSidebarChatPreview: boolean;
	sidebarOverflowPopover: boolean;
}) {
	return (
		<>
			<ContextMenuSectionHeading>List presentation</ContextMenuSectionHeading>
			<ContextMenuCheckboxItem
				checked={groupByDate}
				onCheckedChange={setGroupByDate}
			>
				Group lists by date
			</ContextMenuCheckboxItem>
			<ContextMenuCheckboxItem
				checked={groupedNav}
				onCheckedChange={setGroupedNav}
			>
				Projects & Spaces as pickers
			</ContextMenuCheckboxItem>
			<ContextMenuCheckboxItem
				checked={showSidebarChatPreview}
				onCheckedChange={setShowSidebarChatPreview}
			>
				Show latest message / tool state
			</ContextMenuCheckboxItem>
			<ContextMenuCheckboxItem
				checked={sidebarOverflowPopover}
				onCheckedChange={setSidebarOverflowPopover}
			>
				Search section overflow in a popover
			</ContextMenuCheckboxItem>
			<ContextMenuCheckboxItem
				checked={agentRowStyle === "messaging"}
				disabled={activeModeKey === "agent"}
				onCheckedChange={(checked) =>
					setAgentRowStyle(checked ? "messaging" : "compact")
				}
			>
				Messaging-style agent rows
			</ContextMenuCheckboxItem>
			<CompactRailMenuItem />
		</>
	);
}

/** The compact-rail switch. It reads its own preference so the sidebar menu and
 *  the rail's menu offer the same row without threading state through either. */
export function CompactRailMenuItem() {
	const [enabled, setEnabled] = useCompactRailPreference();
	return (
		<ContextMenuCheckboxItem checked={enabled} onCheckedChange={setEnabled}>
			Agent rail in narrow windows
		</ContextMenuCheckboxItem>
	);
}
