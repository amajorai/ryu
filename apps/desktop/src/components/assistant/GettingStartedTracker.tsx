import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils";
import { useState } from "react";
import { GettingStartedChecklist } from "@/src/components/chat/GettingStartedChecklist.tsx";
import { useGettingStarted } from "@/src/hooks/useGettingStarted.ts";

/**
 * Compact onboarding tracker, collapsible in place and self-removing once every
 * quest is done. Lives at the top of the "Ask Ryu" panel body (floating popover
 * + docked sidebar), so onboarding is reachable from every page without
 * cluttering the app sidebar. `className` tunes the outer padding to its host.
 */
export function GettingStartedTracker({ className }: { className?: string }) {
	const { quests, completedCount, total, allDone, run } = useGettingStarted();
	const [collapsed, setCollapsed] = useState(true);

	if (allDone) {
		return null;
	}

	return (
		<div className={cn("px-1 pb-1", className)}>
			<button
				aria-controls="getting-started-panel"
				aria-expanded={!collapsed}
				className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
				onClick={() => setCollapsed((value) => !value)}
				type="button"
			>
				<span className="flex-1 truncate text-left">Get started</span>
				<span className="shrink-0 tabular-nums opacity-70">
					{completedCount}/{total}
				</span>
				<HugeiconsIcon
					className={cn(
						"size-3.5 shrink-0 transition-transform duration-200 ease-out",
						collapsed && "-rotate-90"
					)}
					icon={ArrowDown01Icon}
				/>
			</button>
			{/* Grid-rows reveal (0fr↔1fr) so the panel slides open in sync with the
			    chevron rather than popping; the checklist stays mounted. */}
			<div
				aria-hidden={collapsed}
				className={cn(
					"grid transition-[grid-template-rows] duration-200 ease-out",
					collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
				)}
				id="getting-started-panel"
				inert={collapsed}
			>
				<div className="overflow-hidden">
					<div className="scroll-fade-effect-y max-h-[40vh] overflow-y-auto pt-0.5">
						<GettingStartedChecklist onRun={run} quests={quests} />
					</div>
				</div>
			</div>
		</div>
	);
}
