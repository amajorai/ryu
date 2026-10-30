import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { AnimatedTitle } from "@/src/components/layout/animated-title.tsx";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import layoutStyles from "../../layout/Layout.module.css";
import { TabGlyph, useTabBusy } from "../../layout/TitleBar.tsx";

// Chrome at the bottom-left of each split pane: a quiet title pill plus, on the
// focused pane, the page actions. The pill never takes the pointer and fades
// while the pointer is over its pane (CSS group-hover, no pointermove work), so
// the composer controls it sits over stay visible and reachable.
export function PaneBadge({
	actions,
	activeSplit,
	focused,
	tab,
}: {
	actions?: ReactNode;
	activeSplit: boolean;
	focused: boolean;
	tab: Tab;
}) {
	const busy = useTabBusy(tab);

	if (!activeSplit) {
		return null;
	}

	return (
		// Fixed row height (h-8, the action buttons' size) so the pill sits at the
		// same spot whether or not the focused pane's actions are beside it.
		<div className="pointer-events-none absolute bottom-2 left-2 z-10 flex h-8 items-center gap-1">
			<div
				className={cn(
					"flex h-6 items-center gap-1.5 rounded-full bg-muted px-2 text-xs transition-opacity duration-150 group-hover/pane:opacity-0",
					focused ? "text-foreground" : "text-muted-foreground"
				)}
				data-focused={focused ? "true" : undefined}
				data-slot="pane-badge"
			>
				<span className="flex size-3.5 shrink-0 items-center justify-center">
					<TabGlyph
						busy={busy}
						busySpeed={tab.busySpeed}
						className="size-3.5"
						logoSize="14px"
						path={tab.path}
						unloaded={tab.unloaded}
					/>
				</span>
				{busy && !tab.unloaded ? (
					<span
						className={cn(
							"an-text-shimmer an-text-shimmer--active max-w-32 truncate",
							layoutStyles.authored1
						)}
					>
						<AnimatedTitle text={tab.title} />
					</span>
				) : (
					<span className="max-w-32 truncate">
						<AnimatedTitle text={tab.title} />
					</span>
				)}
			</div>
			{focused && actions ? (
				<div
					className="pointer-events-auto flex h-8 shrink-0 flex-row items-center gap-1"
					data-tauri-drag-region={false}
				>
					{actions}
				</div>
			) : null}
		</div>
	);
}
