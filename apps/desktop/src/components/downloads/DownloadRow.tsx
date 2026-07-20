// apps/desktop/src/components/downloads/DownloadRow.tsx
//
// One download row — progress bar, size/speed/ETA, and pause/resume/cancel/retry
// controls — shared by the compact download popup (DownloadCenter) and the full
// DownloadsPage so both render an identical row.

import {
	Alert01Icon,
	Cancel01Icon,
	CheckmarkCircle02Icon,
	PauseIcon,
	PlayIcon,
	Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Progress } from "@ryu/ui/components/progress";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	cancelDownload,
	clearDownload,
	type DownloadTask,
	isInFlight,
	pauseDownload,
	resumeDownload,
	retryDownload,
} from "@/src/lib/api/downloads.ts";
import { friendlyDownloadLabel } from "@/src/lib/catalog/friendly.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export function formatBytes(n: number): string {
	if (n < 1024) {
		return `${n} B`;
	}
	const units = ["KB", "MB", "GB", "TB"];
	let value = n / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatEta(task: DownloadTask): string | null {
	if (!(task.total_bytes && task.speed_bps) || task.speed_bps <= 0) {
		return null;
	}
	const remaining = task.total_bytes - task.received_bytes;
	if (remaining <= 0) {
		return null;
	}
	const secs = Math.round(remaining / task.speed_bps);
	if (secs < 60) {
		return `${secs}s left`;
	}
	if (secs < 3600) {
		return `${Math.round(secs / 60)}m left`;
	}
	return `${(secs / 3600).toFixed(1)}h left`;
}

export function stateLabel(task: DownloadTask): string {
	switch (task.state) {
		case "queued":
			return "Queued";
		case "active": {
			const speed = task.speed_bps ? `${formatBytes(task.speed_bps)}/s` : null;
			const eta = formatEta(task);
			return [speed, eta].filter(Boolean).join(" · ") || "Downloading";
		}
		case "paused":
			return "Paused";
		case "verifying":
			return "Verifying";
		case "completed":
			return "Done";
		case "failed":
			return task.error ? `Failed: ${task.error}` : "Failed";
		case "cancelled":
			return "Cancelled";
		default:
			return task.state;
	}
}

/** A single download row in a list. */
export function DownloadRow({
	task,
	friendly,
}: {
	task: DownloadTask;
	friendly: boolean;
}) {
	const getNode = useNodeStore((s) => s.getActiveNode);
	const target = toTarget(getNode());

	const displayLabel = friendly
		? friendlyDownloadLabel(task.label, task.kind)
		: task.label;

	const sizeText = task.total_bytes
		? `${formatBytes(task.received_bytes)} / ${formatBytes(task.total_bytes)}`
		: formatBytes(task.received_bytes);
	const percent =
		task.total_bytes && task.total_bytes > 0
			? Math.min(100, (task.received_bytes / task.total_bytes) * 100)
			: null;
	const indeterminate = task.state === "active" && percent === null;

	return (
		<div className="flex flex-col gap-1.5 px-3 py-2.5">
			<div className="flex items-center justify-between gap-2">
				<Tooltip>
					<TooltipTrigger
						render={
							<span className="truncate font-medium text-sm">
								{displayLabel}
							</span>
						}
					/>
					<TooltipContent>{task.label}</TooltipContent>
				</Tooltip>
				<div className="flex shrink-0 items-center gap-1">
					{task.state === "active" && (
						<Button
							aria-label="Pause"
							onClick={() =>
								pauseDownload(target, task.id).catch(() => undefined)
							}
							size="icon"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={PauseIcon} />
						</Button>
					)}
					{(task.state === "paused" || task.state === "queued") && (
						<Button
							aria-label="Resume"
							onClick={() =>
								resumeDownload(target, task.id).catch(() => undefined)
							}
							size="icon"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={PlayIcon} />
						</Button>
					)}
					{task.state === "failed" && task.retryable && (
						<Button
							aria-label="Retry"
							onClick={() =>
								retryDownload(target, task.id).catch(() => undefined)
							}
							size="icon"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
						</Button>
					)}
					{isInFlight(task.state) || task.state === "paused" ? (
						<Button
							aria-label="Cancel"
							onClick={() =>
								cancelDownload(target, task.id).catch(() => undefined)
							}
							size="icon"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
						</Button>
					) : (
						<Button
							aria-label="Dismiss"
							onClick={() =>
								clearDownload(target, task.id).catch(() => undefined)
							}
							size="icon"
							variant="ghost"
						>
							<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
						</Button>
					)}
				</div>
			</div>

			{task.state === "completed" ? (
				<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
					<HugeiconsIcon
						className="size-3.5 text-success"
						icon={CheckmarkCircle02Icon}
					/>
					<span>Installed · {sizeText}</span>
				</div>
			) : task.state === "failed" ? (
				<div className="flex items-center gap-1.5 text-destructive text-xs">
					<HugeiconsIcon className="size-3.5" icon={Alert01Icon} />
					{task.error ? (
						<Tooltip>
							<TooltipTrigger
								render={<span className="truncate">{stateLabel(task)}</span>}
							/>
							<TooltipContent>{task.error}</TooltipContent>
						</Tooltip>
					) : (
						<span className="truncate">{stateLabel(task)}</span>
					)}
				</div>
			) : (
				<>
					<Progress value={indeterminate ? null : (percent ?? 0)} />
					<div className="flex items-center justify-between text-muted-foreground text-xs tabular-nums">
						<span>{sizeText}</span>
						<span>{stateLabel(task)}</span>
					</div>
				</>
			)}
		</div>
	);
}
