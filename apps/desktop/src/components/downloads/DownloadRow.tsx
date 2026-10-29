// apps/desktop/src/components/downloads/DownloadRow.tsx
//
// One download row — kind glyph, progress, size/speed/ETA, and
// pause/resume/cancel/retry controls — shared by the compact download tray
// (DownloadCenter) and the full DownloadsPage so both render an identical row.
//
// Built on the shared TrayRow grid, so a download sits in the same rhythm as an
// approval or an available update: one title line, one thin progress bar, one
// dot-separated meta line. Everything a download used to stack (size line +
// state line + bar) now fits that shape.
//
// Controls live in a fixed-width slot and stay visible at 70% rather than being
// revealed on hover: hover-only controls left every row looking empty on the
// right, and made the row reflow the moment the pointer touched it.

import {
	Cancel01Icon,
	CheckmarkCircle02Icon,
	Delete02Icon,
	PauseIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo";
import { useEffect, useState } from "react";
import {
	TrayAction,
	TrayIconAction,
	TrayRow,
	trayMeta,
} from "@/src/components/shell/TrayPopover.tsx";
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
import {
	downloadBadge,
	stripRoleSuffix,
} from "@/src/lib/catalog/downloadBadge.ts";
import { friendlyDownloadLabel } from "@/src/lib/catalog/friendly.ts";
import { useDownloadsStore } from "@/src/store/useDownloadsStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { DownloadTypeBadge } from "./DownloadTypeBadge.tsx";
import { kindIcon } from "./kindIcons.ts";

/**
 * Surface a failed pause/resume/cancel/dismiss/retry. The usual cause is Core no
 * longer knowing the task (it restarted) or refusing the caller; swallowing it
 * leaves a button that silently does nothing.
 */
function reportControlFailure(tl: LiteralMessage, action: string) {
	return (error: unknown) => {
		toast.error({
			title: tl("Couldn't {action} the download", { action }),
			description: error instanceof Error ? error.message : String(error),
		});
	};
}

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
	const [busy, setBusy] = useState(false);
	const tl = useLiteralMessages();
	async function runAction(label: string, action: () => Promise<unknown>) {
		setBusy(true);
		try {
			await action();
		} catch (error) {
			reportControlFailure(tl, label.toLowerCase())(error);
		} finally {
			setBusy(false);
		}
	}

	// The type badge carries the role, so the redundant "(embedding model)"
	// parenthetical is stripped from the name; the raw label stays on hover.
	const badge = downloadBadge(task.role, task.kind, task.label);
	const displayLabel = stripRoleSuffix(
		friendly ? friendlyDownloadLabel(task.label, task.kind) : task.label
	);

	const sizeText = task.total_bytes
		? `${formatBytes(task.received_bytes)} of ${formatBytes(task.total_bytes)}`
		: formatBytes(task.received_bytes);
	const percent =
		task.total_bytes && task.total_bytes > 0
			? Math.min(100, (task.received_bytes / task.total_bytes) * 100)
			: null;
	const done = task.state === "completed";
	const failed = task.state === "failed";
	const terminal = done || failed || task.state === "cancelled";
	const [holdFull, setHoldFull] = useState(false);
	useEffect(() => {
		if (!done) {
			return;
		}
		setHoldFull(true);
		const timer = setTimeout(() => setHoldFull(false), 430);
		return () => clearTimeout(timer);
	}, [done]);

	let tone: "default" | "danger" | "success" = "default";
	if (failed) {
		tone = "danger";
	} else if (done) {
		tone = "success";
	}

	let meta: string;
	if (failed) {
		meta = stateLabel(task);
	} else if (terminal) {
		meta = trayMeta(done ? "Installed" : "Cancelled", sizeText);
	} else {
		meta = trayMeta(sizeText, stateLabel(task));
	}

	return (
		<TrayRow
			actions={
				<span className="flex items-center gap-1">
					{task.state === "active" && (
						<TrayIconAction
							icon={PauseIcon}
							label="Pause"
							onClick={() =>
								runAction("Pause", () => pauseDownload(target, task.id))
							}
						/>
					)}
					{(task.state === "paused" || task.state === "queued") && (
						<TrayIconAction
							icon={PlayIcon}
							label="Resume"
							onClick={() =>
								runAction("Resume", () => resumeDownload(target, task.id))
							}
						/>
					)}
					{isInFlight(task.state) || task.state === "paused" ? (
						<TrayIconAction
							icon={Cancel01Icon}
							label="Cancel"
							onClick={() =>
								runAction("Cancel", () => cancelDownload(target, task.id))
							}
							tone="danger"
						/>
					) : (
						<TrayIconAction
							icon={Delete02Icon}
							label="Dismiss"
							onClick={() =>
								runAction("Dismiss", async () => {
									await clearDownload(target, task.id);
									useDownloadsStore.getState().removeTask(task.id);
								})
							}
						/>
					)}
					{failed && task.retryable && (
						<TrayAction
							label="Retry"
							onClick={() =>
								runAction("Retry", () => retryDownload(target, task.id))
							}
						/>
					)}
				</span>
			}
			busy={busy}
			icon={done ? CheckmarkCircle02Icon : kindIcon(task.kind)}
			meta={meta}
			metaTone={failed ? "danger" : "default"}
			progress={terminal ? (holdFull ? 100 : undefined) : percent}
			// Native title attribute rather than a Tooltip: the row already carries
			// tooltipped controls, and nesting another trigger around the truncated
			// label made the whole row a tooltip target.
			title={<span title={task.label}>{displayLabel}</span>}
			tone={tone}
			trailing={badge ? <DownloadTypeBadge badge={badge} /> : undefined}
		/>
	);
}
