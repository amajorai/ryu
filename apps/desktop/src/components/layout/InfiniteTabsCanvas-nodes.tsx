import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type NodeProps, NodeResizer, type NodeTypes } from "@xyflow/react";
import { TabLayoutMenuItems } from "@/src/components/layout/appearance-context-menu.tsx";
import { TabViewPane } from "@/src/components/layout/TabViewPane.tsx";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import { setTabLayout, type useTabLayout } from "@/src/hooks/useTabLayout.ts";
import layoutStyles from "./InfiniteTabsCanvas.module.css";
import type {
	RegionCanvasNode,
	TabCanvasNode,
} from "./InfiniteTabsCanvas-model.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { TabGlyph } from "./TitleBar.tsx";
import { GROUP_COLOR_CLASSES } from "./TitleBar-tab-shared.tsx";
import {
	TAB_CANVAS_MIN_HEIGHT,
	TAB_CANVAS_MIN_WIDTH,
} from "./tab-canvas-layout.ts";

function CanvasRegionNodeView({ data }: NodeProps<RegionCanvasNode>) {
	return (
		<div
			className={cn(
				"pointer-events-none h-full w-full rounded-3xl border border-border p-4"
			)}
			data-canvas-region={data.label}
		>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="flex items-center gap-1.5 truncate font-medium text-sm">
						<span
							aria-hidden
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								GROUP_COLOR_CLASSES[data.color].dot
							)}
						/>
						{data.label}
					</p>
				</div>
				<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
					{data.memberCount} {data.memberCount === 1 ? "tab" : "tabs"}
				</span>
			</div>
		</div>
	);
}

function CanvasTabHeader({
	focused,
	onClose,
	onFocus,
	tab,
	tabLayout,
}: {
	focused: boolean;
	onClose: () => void;
	onFocus: () => void;
	tab: Tab;
	tabLayout: ReturnType<typeof useTabLayout>;
}) {
	const tl = useLiteralMessages();
	return (
		<ContextMenu>
			<ContextMenuTrigger
				render={
					<div
						className="flex h-10 items-center gap-2 border-border border-b bg-card px-3"
						data-tab-view-header={tab.id}
					>
						<span
							className={cn(
								"flex size-4 shrink-0 items-center justify-center",
								focused ? "text-foreground" : "text-muted-foreground"
							)}
						>
							<TabGlyph
								busy={tab.busy}
								busySpeed={tab.busySpeed}
								className="size-4"
								icon={tab.icon}
								logoSize="16px"
								path={tab.path}
								unloaded={tab.unloaded}
							/>
						</span>
						<button
							className={cn(
								"min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								focused ? "text-foreground" : "text-muted-foreground"
							)}
							onClick={onFocus}
							type="button"
						>
							<OverflowTooltip
								className="block overflow-hidden whitespace-nowrap font-medium text-sm"
								fade
								forceShow={tab.unloaded}
								text={tab.title}
							/>
						</button>
						<Button
							aria-label={tl("Close {title}", { title: tab.title })}
							className="shrink-0"
							onClick={(event) => {
								event.stopPropagation();
								onClose();
							}}
							size="icon-sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
						</Button>
					</div>
				}
			/>
			<ContextMenuContent>
				<ContextMenuItem disabled={focused} onClick={onFocus}>
					Focus tab
				</ContextMenuItem>
				<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
				<ContextMenuItem onClick={onClose}>Close tab</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function TabCanvasNodeView({
	data,
	dragging,
	selected,
}: NodeProps<TabCanvasNode>) {
	return (
		<>
			<NodeResizer
				handleClassName="!size-2 !rounded-glyph-compact !border-background !bg-primary"
				isVisible={selected}
				lineClassName="!border-primary/40"
				minHeight={TAB_CANVAS_MIN_HEIGHT}
				minWidth={TAB_CANVAS_MIN_WIDTH}
				onResizeEnd={data.persist}
			/>
			<TabViewPane
				className={cn(
					cn(
						"h-full rounded-2xl border border-border duration-200",
						layoutStyles.authored2,
						layoutStyles.authored3
					),
					dragging &&
						data.motionEnabled &&
						"-translate-y-px scale-[1.01] shadow-lg"
				)}
				focused={data.focused}
				onClose={data.onClose}
				onFocus={data.onFocus}
				tab={data.tab}
			>
				<CanvasTabHeader
					focused={data.focused}
					onClose={data.onClose}
					onFocus={data.onFocus}
					tab={data.tab}
					tabLayout={data.tabLayout}
				/>
			</TabViewPane>
		</>
	);
}

export const NODE_TYPES: NodeTypes = {
	region: CanvasRegionNodeView,
	tab: TabCanvasNodeView,
};
