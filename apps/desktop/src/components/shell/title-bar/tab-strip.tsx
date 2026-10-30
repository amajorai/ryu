import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { ContextMenuTrigger } from "@ryu/ui/components/context-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode, RefObject, WheelEvent } from "react";
import { TabDropdown } from "@/src/components/layout/tab-dropdown.tsx";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import { PinnedTab } from "./pinned-tab.tsx";
import { RegularTab } from "./regular-tab.tsx";
import {
	GroupHeaderPill,
	SplitBracketHeader,
	TabBracket,
} from "./tab-brackets.tsx";
import { TabGlyph } from "./tab-glyph.tsx";
import type { Segment } from "./tab-segments.ts";

/** The scrollable horizontal tab row: pinned chips, then tabs and brackets. */
export function TabStrip({
	activeTabId,
	onWheel,
	pinnedTabs,
	scrollRef,
	segments,
}: {
	activeTabId: string;
	onWheel: (e: WheelEvent<HTMLDivElement>) => void;
	pinnedTabs: Tab[];
	scrollRef: RefObject<HTMLDivElement | null>;
	segments: Segment[];
}) {
	return (
		<div
			className="group/tabstrip flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden pb-8 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			data-tauri-drag-region={false}
			onWheel={onWheel}
			ref={scrollRef}
		>
			{/* Pinned tabs lead, as compact icon-only chips */}
			{pinnedTabs.map((tab) => (
				<PinnedTab isActive={tab.id === activeTabId} key={tab.id} tab={tab} />
			))}

			{/* Then ungrouped tabs, group brackets, and split brackets */}
			{segments.map((seg) => {
				if (seg.type === "tab") {
					return (
						<RegularTab
							inGroup={false}
							isActive={seg.tab.id === activeTabId}
							key={seg.tab.id}
							tab={seg.tab}
						/>
					);
				}
				if (seg.type === "split") {
					return (
						<TabBracket
							bracketId={seg.split.id}
							className="flex shrink-0 items-center gap-1 rounded-lg"
							key={seg.split.id}
						>
							<SplitBracketHeader
								anyMemberId={seg.members[0]?.id ?? ""}
								split={seg.split}
							/>
							{seg.members.map((tab) => (
								<RegularTab
									inGroup
									isActive={tab.id === activeTabId}
									key={tab.id}
									tab={tab}
								/>
							))}
						</TabBracket>
					);
				}
				return (
					<TabBracket
						bracketId={seg.group.id}
						className={cn("flex shrink-0 items-center gap-1 rounded-lg")}
						key={seg.group.id}
					>
						<GroupHeaderPill group={seg.group} />
						{!seg.group.collapsed &&
							seg.members.map((tab) => (
								<RegularTab
									inGroup
									isActive={tab.id === activeTabId}
									key={tab.id}
									tab={tab}
								/>
							))}
					</TabBracket>
				);
			})}
		</div>
	);
}

/** Right-side page actions, offset to clear Windows caption buttons. */
export function TitleBarActions({
	children,
	pageActionsMargin,
}: {
	children: ReactNode;
	pageActionsMargin: string;
}) {
	return (
		<div
			className={cn(
				"relative z-50 flex shrink-0 flex-row items-center gap-1",
				// Windows caption buttons (min/max/close) sit at the top-right;
				// give the page actions wide clearance so they never crowd them.
				// macOS keeps its controls on the left, so only a small inset.
				// A phone width is always the browser build — no caption
				// buttons to clear, and 12rem of dead margin would push the
				// actions off screen.
				pageActionsMargin
			)}
			data-tauri-drag-region={false}
		>
			{children}
		</div>
	);
}

/** The tab strip in dropdown mode: the active tab's picker plus "new tab". */
export function TabDropdownStrip({
	activateTab,
	activeTab,
	activeTabId,
	closeTab,
	handleNewTab,
	tabs,
}: {
	activateTab: (id: string) => void;
	activeTab: Tab | undefined;
	activeTabId: string;
	closeTab: (id: string) => void;
	handleNewTab: () => void;
	tabs: Tab[];
}) {
	const { t } = useI18n();
	return (
		<ContextMenuTrigger
			className="flex min-w-0 flex-1 items-center"
			data-tauri-drag-region
		>
			<div
				className="flex min-w-0 flex-1 items-center gap-1"
				data-tauri-drag-region
			>
				<TabDropdown
					activateTab={activateTab}
					activeIcon={
						activeTab ? (
							<TabGlyph
								busy={activeTab.busy}
								busySpeed={activeTab.busySpeed}
								className="size-4"
								icon={activeTab.icon}
								logoSize="16px"
								path={activeTab.path}
								unloaded={activeTab.unloaded}
							/>
						) : undefined
					}
					activeTabId={activeTabId}
					closeTab={closeTab}
					tabs={tabs}
				/>
				<Button
					aria-label={t("shell.new-chat-tab", undefined, "New chat tab")}
					className="ml-0.5 shrink-0"
					data-tauri-drag-region={false}
					onClick={handleNewTab}
					size="icon-sm"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
				</Button>
				<div aria-hidden className="min-w-0 flex-1" data-tauri-drag-region />
			</div>
		</ContextMenuTrigger>
	);
}
