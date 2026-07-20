// apps/desktop/src/components/downloads/DownloadCenter.tsx
//
// App-wide download overlay (#456). A compact status pill (sidebar footer) that
// shows aggregate progress whenever anything is downloading; click it to expand
// a panel with three parts: promoted "Available updates" (agents/engines/tools/
// plugins/app that have a newer version — see AvailableUpdates), every tracked
// download with progress + pause/resume/cancel/retry, and an "Open downloads"
// action that pops out to the full DownloadsPage. Reads the downloads store (fed
// by the SSE stream) and the update aggregate, and drives Core's control
// endpoints on the active node.

import { ArrowUpRight01Icon, Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { clearDownload } from "@/src/lib/api/downloads.ts";
import {
	type DownloadsAggregate,
	selectAggregate,
	selectOrderedTasks,
	useDownloadsStore,
} from "@/src/store/useDownloadsStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { AvailableUpdates } from "./AvailableUpdates.tsx";
import { DownloadRow } from "./DownloadRow.tsx";

/**
 * Small count badge overlaid on the trigger's top-right corner. Stays mounted
 * so the transitions.dev notification-badge (03) can pop the dot in/out and
 * slide it diagonally as the count appears/clears, rather than hard-mounting.
 */
function DownloadBadge({ aggregate }: { aggregate: DownloadsAggregate }) {
	const open = aggregate.inFlight > 0 || aggregate.failed > 0;
	const isFailed = aggregate.inFlight === 0 && aggregate.failed > 0;
	const count = aggregate.inFlight > 0 ? aggregate.inFlight : aggregate.failed;
	return (
		<span
			aria-hidden={!open}
			className="t-badge -top-0.5 -right-0.5"
			data-open={open}
		>
			<span
				className={cn(
					"t-badge-dot flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-medium text-[10px] tabular-nums",
					isFailed
						? "bg-destructive text-white"
						: "bg-primary text-primary-foreground"
				)}
			>
				{count > 9 ? "9+" : count}
			</span>
		</span>
	);
}

/**
 * The app-wide download control: a compact icon button (sidebar footer, beside
 * Settings) with a badge for active/failed downloads. Click to open a panel with
 * promoted available updates + every tracked download, and an "Open downloads"
 * action that pops out to the full page. Always rendered so it stays a stable
 * sidebar control; the panel shows an empty state when nothing is tracked.
 */
export function DownloadCenter() {
	// useShallow: both selectors derive a fresh object/array each call; without a
	// shallow equality check Zustand's useSyncExternalStore sees a new snapshot
	// every render ("getSnapshot should be cached") and spins into an infinite
	// update loop.
	const aggregate = useDownloadsStore(useShallow(selectAggregate));
	const tasks = useDownloadsStore(useShallow(selectOrderedTasks));
	const getNode = useNodeStore((s) => s.getActiveNode);
	const [friendly] = useFriendlyMode();
	const { openTab } = useTabsContext();
	const [open, setOpen] = useState(false);

	const clearFinished = useCallback(() => {
		const target = toTarget(getNode());
		for (const task of tasks) {
			if (task.state === "completed" || task.state === "cancelled") {
				clearDownload(target, task.id).catch(() => undefined);
			}
		}
	}, [getNode, tasks]);

	const hasFinished = tasks.some(
		(t) => t.state === "completed" || t.state === "cancelled"
	);

	const openFullPage = () => {
		setOpen(false);
		openTab("/downloads");
	};

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							aria-label="Downloads"
							className="gooey-tap relative flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						>
							<HugeiconsIcon icon={Download01Icon} size={15} />
							<DownloadBadge aggregate={aggregate} />
						</PopoverTrigger>
					}
				/>
				<TooltipContent>Downloads</TooltipContent>
			</Tooltip>
			<PopoverContent align="end" className="w-80 gap-0 p-0" side="top">
				<div className="flex items-center justify-between border-b px-3 py-2">
					<span className="font-semibold text-sm">Downloads</span>
					{hasFinished && (
						<Button onClick={clearFinished} size="sm" variant="ghost">
							Clear finished
						</Button>
					)}
				</div>
				<div className="max-h-96 overflow-y-auto">
					<AvailableUpdates compact />
					{aggregate.hasAny ? (
						<div className="divide-y border-t">
							{tasks.map((task) => (
								<DownloadRow friendly={friendly} key={task.id} task={task} />
							))}
						</div>
					) : (
						<div className="border-t px-3 py-6 text-center text-muted-foreground text-xs">
							No downloads yet
						</div>
					)}
				</div>
				<div className="border-t p-1">
					<button
						className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
						onClick={openFullPage}
						type="button"
					>
						Open downloads
						<HugeiconsIcon icon={ArrowUpRight01Icon} size={14} />
					</button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
